import {
  EventType,
  IncrementalSource,
  MouseInteractions,
  NodeType,
  type eventWithTime,
  type serializedNodeWithId,
} from '@rrweb/types';
import type { LLMSettings } from '~/types';
import { formatTime } from '~/utils';

/**
 * A single user operation step extracted from the recording.
 */
export type OperationStep = {
  /** Zero-based index in the timeline */
  index: number;
  /** Offset from the recording start, in milliseconds */
  offset: number;
  /** Formatted time string, e.g. "01:23" */
  time: string;
  /** Absolute timestamp of the event */
  timestamp: number;
  /** Rule-based Chinese description produced without an LLM */
  description: string;
  /** Structured context for the LLM (element info, action, value, ...) */
  context: Record<string, unknown>;
};

export type SummaryResult = {
  /** Per-step descriptions (rule-based, or LLM-refined when enabled) */
  steps: Array<{ index: number; time: string; description: string }>;
  /** High-level Chinese summary of the whole recording (LLM only) */
  overallSummary?: string;
  /** Whether the LLM was used to refine the steps */
  llmUsed: boolean;
  /** Error message if the LLM call failed */
  error?: string;
};

type NodeMirror = Map<number, serializedNodeWithId>;

// Lookup context passed to element-description helpers.
type ElementContext = {
  mirror: NodeMirror;
  /** child id → parent id */
  parentMap: Map<number, number>;
  /** label "for" attribute value → label node id */
  labelForMap: Map<string, number>;
};

// ---------- Node mirror helpers ----------

function walkSnapshot(
  node: serializedNodeWithId,
  ctx: ElementContext,
  parentId?: number,
): void {
  ctx.mirror.set(node.id, node);
  if (parentId !== undefined) ctx.parentMap.set(node.id, parentId);
  if (
    node.type === NodeType.Element &&
    node.tagName.toLowerCase() === 'label'
  ) {
    const attrs = node.attributes;
    const forAttr = (attrs.for as string) || (attrs.htmlFor as string) || '';
    if (forAttr) ctx.labelForMap.set(forAttr, node.id);
  }
  const childNodes =
    node.type === NodeType.Element || node.type === NodeType.Document
      ? node.childNodes
      : [];
  for (const child of childNodes) {
    walkSnapshot(child, ctx, node.id);
  }
}

function buildMirrorFromFullSnapshot(
  event: eventWithTime,
  ctx: ElementContext,
): void {
  if (event.type !== EventType.FullSnapshot) return;
  walkSnapshot(event.data.node, ctx);
}

function applyMutationToMirror(
  event: eventWithTime,
  ctx: ElementContext,
): void {
  if (
    event.type !== EventType.IncrementalSnapshot ||
    event.data.source !== IncrementalSource.Mutation
  ) {
    return;
  }
  const { adds, removes, texts } = event.data;
  // Keep removed nodes in the mirror so that late input/interaction events
  // (which may fire after a DOM mutation removes the element) can still be
  // described. rrweb assigns unique ids that are never reused, so stale
  // entries don't conflict with new nodes added later.
  for (const remove of removes) {
    // Remove from parent's childNodes so getRecursiveText/getNodeText reflect
    // the current DOM, but keep the node itself in the mirror.
    const pid = ctx.parentMap.get(remove.id);
    if (pid !== undefined) {
      const parent = ctx.mirror.get(pid);
      if (
        parent &&
        (parent.type === NodeType.Element || parent.type === NodeType.Document)
      ) {
        parent.childNodes = parent.childNodes.filter((c) => c.id !== remove.id);
      }
    }
  }
  for (const add of adds) {
    walkSnapshot(add.node, ctx, add.parentId);
    // walkSnapshot adds the node to the mirror and parentMap, but does NOT
    // insert it into the parent's childNodes. Without this, getRecursiveText
    // and getNodeText cannot see mutation-added elements (e.g. a dialog that
    // opens after the full snapshot). Patch the parent's childNodes here.
    const parent = ctx.mirror.get(add.parentId);
    if (
      parent &&
      (parent.type === NodeType.Element || parent.type === NodeType.Document)
    ) {
      if (!parent.childNodes.some((c) => c.id === add.node.id)) {
        parent.childNodes.push(add.node);
      }
    }
  }
  for (const text of texts) {
    const node = ctx.mirror.get(text.id);
    if (node && node.type === NodeType.Text) {
      node.textContent = text.value ?? '';
    }
  }
}

// ---------- Element description helpers ----------

const TEXT_TRUNCATE_LEN = 60;

function truncate(text: string, len = TEXT_TRUNCATE_LEN): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= len) return collapsed;
  return collapsed.slice(0, len) + '…';
}

function getNodeText(node: serializedNodeWithId): string {
  if (node.type === NodeType.Text) return node.textContent;
  if (node.type === NodeType.Element) {
    const parts: string[] = [];
    for (const child of node.childNodes) {
      if (child.type === NodeType.Text) {
        parts.push(child.textContent);
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * Recursively collect all descendant text of a node (up to `maxDepth` levels).
 * Unlike `getNodeText` (which only reads direct text children), this traverses
 * element children too — necessary for patterns like
 * `<button><span>编辑</span></button>` where the button itself has no direct
 * text child.
 */
function getRecursiveText(node: serializedNodeWithId, maxDepth = 6): string {
  if (maxDepth <= 0) return '';
  if (node.type === NodeType.Text) return node.textContent;
  if (node.type === NodeType.Element) {
    const parts: string[] = [];
    for (const child of node.childNodes) {
      if (child.type === NodeType.Text) {
        parts.push(child.textContent);
      } else if (child.type === NodeType.Element) {
        parts.push(getRecursiveText(child, maxDepth - 1));
      }
    }
    return parts.join('');
  }
  return '';
}

/**
 * Tags whose recursive text is safe to use as a label — they are "leaf-like"
 * display elements whose full descendant text is meaningful (e.g. a button
 * wrapping an icon + label span). Container elements (div, section, ul, ...)
 * are excluded because their recursive text would be the concatenation of
 * all children, which is rarely a useful label.
 */
const LEAF_TEXT_TAGS = new Set([
  'a',
  'button',
  'span',
  'li',
  'option',
  'label',
  'summary',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'b',
  'i',
  'small',
  'code',
  'mark',
  'abbr',
  'caption',
]);

// Identifiers that look auto-generated by UI frameworks (Element UI, Radix,
// Headless UI, Bootstrap Vue, rc-*, React/Next internals, pure numbers, UUIDs).
// These are meaningless to a human reader and should not be used as a label.
const GENERATED_ID_RE =
  /^(el-id-|radix-|__BVID|rc-|headlessui-|__react|__next|:r\d+:|react-|next-|aria-|undefined|null)/i;

function isUsefulName(s: string | undefined): boolean {
  if (!s) return false;
  const t = s.trim();
  if (!t) return false;
  if (GENERATED_ID_RE.test(t)) return false;
  // pure numbers / hex hashes / uuid-like
  if (/^\d+$/.test(t)) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(t)) return false;
  // very long strings are likely element outerHTML leaks, not labels
  if (t.length > 80) return false;
  return true;
}

function firstUseful(...vals: Array<string | undefined>): string | undefined {
  return vals.find((v) => isUsefulName(v));
}

/**
 * Search the subtree of `node` (up to `maxDepth` levels) for the first
 * `<input>`/`<select>`/`<textarea>` that has a `<label for="…">` association,
 * and return that label's text. This lets wrapper `<div>`s (e.g. Element UI's
 * `el-select__wrapper`) inherit the label of the form field they contain.
 */
function findDescendantInputLabel(
  node: serializedNodeWithId,
  ctx: ElementContext,
  maxDepth = 4,
): string | undefined {
  if (node.type !== NodeType.Element) return undefined;
  const queue: Array<{ node: serializedNodeWithId; depth: number }> = [];
  for (const child of node.childNodes) {
    queue.push({ node: child, depth: 1 });
  }
  while (queue.length) {
    const item = queue.shift()!;
    if (item.depth > maxDepth) continue;
    const cur = item.node;
    if (cur.type !== NodeType.Element) continue;
    const curTag = cur.tagName.toLowerCase();
    if (curTag === 'input' || curTag === 'select' || curTag === 'textarea') {
      const attrs = cur.attributes ?? {};
      const idAttr = (attrs.id as string) || undefined;
      if (idAttr) {
        const labelNodeId = ctx.labelForMap.get(idAttr);
        if (labelNodeId !== undefined) {
          const labelNode = ctx.mirror.get(labelNodeId);
          if (labelNode) {
            const labelText = truncate(getRecursiveText(labelNode, 3), 40);
            if (isUsefulName(labelText)) return labelText;
          }
        }
      }
    }
    for (const child of cur.childNodes) {
      queue.push({ node: child, depth: item.depth + 1 });
    }
  }
  return undefined;
}

/**
 * Walk up the ancestor chain to find a meaningful label, e.g. when the clicked
 * node is an internal wrapper of an Element UI select popup (whose id is
 * `el-id-xxxx-yy`). We stop at the first ancestor exposing a useful
 * aria-label / title, or — for "leaf-like" tags (button / a / option / label)
 * — its own recursive text. As a last resort, check whether the ancestor
 * wraps a form field with a `<label for>` association.
 */
function findAncestorLabel(
  node: serializedNodeWithId,
  ctx: ElementContext,
): string | undefined {
  let curId = ctx.parentMap.get(node.id);
  let hops = 0;
  while (curId !== undefined && hops < 5) {
    const cur = ctx.mirror.get(curId);
    if (cur && cur.type === NodeType.Element) {
      const attrs = cur.attributes ?? {};
      const aria = (attrs['aria-label'] as string) || undefined;
      const title = (attrs.title as string) || undefined;
      const placeholder = (attrs.placeholder as string) || undefined;
      const found = firstUseful(aria, title, placeholder);
      if (found) return truncate(found, 30);
      const tag = cur.tagName.toLowerCase();
      // Use recursive text for leaf-like containers so that
      // <label class="el-radio"><span>…</span><span>启用</span></label>
      // yields "启用" instead of "".
      if (LEAF_TEXT_TAGS.has(tag)) {
        const t = truncate(getRecursiveText(cur, 4), 30);
        if (isUsefulName(t)) return t;
      }
      // Check if this ancestor wraps a form field with a <label for>.
      const descLabel = findDescendantInputLabel(cur, ctx);
      if (descLabel) return descLabel;
    }
    curId = ctx.parentMap.get(curId);
    hops++;
  }
  return undefined;
}

/**
 * For elements that only contain an icon (e.g. an icon-only <a> or <button>),
 * look at the immediate <img>/<svg>/<i> children for alt / aria-label / title.
 */
function findChildIconLabel(node: serializedNodeWithId): string | undefined {
  if (node.type !== NodeType.Element) return undefined;
  for (const child of node.childNodes) {
    if (child.type !== NodeType.Element) continue;
    const tag = child.tagName.toLowerCase();
    const attrs = child.attributes ?? {};
    if (tag === 'img') {
      const found = firstUseful(
        attrs.alt as string,
        attrs.title as string,
        attrs['aria-label'] as string,
      );
      if (found) return truncate(found, 30);
    } else if (tag === 'svg' || tag === 'i') {
      const found = firstUseful(
        attrs['aria-label'] as string,
        attrs.title as string,
      );
      if (found) return truncate(found, 30);
    }
  }
  return undefined;
}

/**
 * For `a` tags without any text/label, fall back to the last meaningful
 * segment of the href (e.g. from "/users/login" use "login").
 */
function hrefSegmentLabel(href: string | undefined): string | undefined {
  if (!href || href.startsWith('javascript:')) return undefined;
  try {
    const u = new URL(href, 'http://placeholder.invalid/');
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs.length ? segs[segs.length - 1] : undefined;
    if (last && isUsefulName(last)) {
      try {
        return truncate(decodeURIComponent(last), 30);
      } catch {
        return truncate(last, 30);
      }
    }
  } catch {
    /* not a URL */
  }
  return undefined;
}

/**
 * Pick the most useful identifying attributes from an element node.
 */
function describeElement(
  node: serializedNodeWithId | undefined,
  ctx?: ElementContext,
): {
  tag: string;
  text: string;
  role?: string;
  label?: string;
  labelText?: string;
  placeholder?: string;
  title?: string;
  alt?: string;
  href?: string;
  hrefLabel?: string;
  value?: string;
  id?: string;
  name?: string;
  className?: string;
  testId?: string;
  selectedOption?: string;
  precedingLabel?: string;
  ancestorLabel?: string;
  childIconLabel?: string;
  descendantInputLabel?: string;
} {
  if (!node || node.type !== NodeType.Element) {
    return { tag: node ? NodeType[node.type] : '未知元素', text: '' };
  }
  const el = node;
  const attrs = el.attributes ?? {};
  const tag = el.tagName.toLowerCase();
  // For leaf-like elements (button, span, li, ...) use recursive text so that
  // <button><span>编辑</span></button> yields "编辑" instead of "".
  // For div, use recursive text only when it's short enough to look like a
  // label (not the concatenation of an entire form/section).
  let text: string;
  if (LEAF_TEXT_TAGS.has(tag)) {
    text = truncate(getRecursiveText(node, 5));
  } else if (tag === 'div') {
    const full = getRecursiveText(node, 3).replace(/\s+/g, ' ').trim();
    text = full.length <= 12 ? full : getNodeText(node);
  } else {
    text = truncate(getNodeText(node));
  }
  // Filter out framework-generated testIds so they never leak into the label.
  const rawTestId =
    (attrs['data-testid'] as string) ||
    (attrs['data-test'] as string) ||
    undefined;
  const info = {
    tag,
    text,
    role: (attrs.role as string) || undefined,
    label:
      (attrs['aria-label'] as string) ||
      (attrs['aria-labelledby'] as string) ||
      undefined,
    placeholder: (attrs.placeholder as string) || undefined,
    title: (attrs.title as string) || undefined,
    alt: (attrs.alt as string) || undefined,
    href: (attrs.href as string) || undefined,
    value: (attrs.value as string) || undefined,
    id: (attrs.id as string) || undefined,
    name: (attrs.name as string) || undefined,
    className:
      typeof attrs.class === 'string' && attrs.class ? attrs.class : undefined,
    testId: isUsefulName(rawTestId) ? rawTestId : undefined,
  };

  if (!ctx) return info;

  // 1. <label for="id"> association
  const idAttr = info.id;
  if (idAttr) {
    const labelNodeId = ctx.labelForMap.get(idAttr);
    if (labelNodeId !== undefined) {
      const labelNode = ctx.mirror.get(labelNodeId);
      if (labelNode) {
        const labelText = truncate(getRecursiveText(labelNode, 3), 40);
        if (isUsefulName(labelText)) return { ...info, labelText };
      }
    }
  }

  // 2. Wrapping <label> ancestor — use recursive text so that
  // <label class="el-radio"><span class="el-radio__input">…</span>
  //   <span class="el-radio__label">启用</span></label>
  // yields "启用". Return as `ancestorLabel` (not `labelText`) because the
  // wrapping label's text IS the element's own label — appending the tag
  // suffix would produce awkward results like "大模型文本" for a radio span.
  let curId = ctx.parentMap.get(node.id);
  while (curId !== undefined) {
    const cur = ctx.mirror.get(curId);
    if (cur && cur.type === NodeType.Element) {
      const curEl = cur;
      if (curEl.tagName.toLowerCase() === 'label') {
        const labelText = truncate(getRecursiveText(curEl, 4), 40);
        if (isUsefulName(labelText))
          return { ...info, ancestorLabel: labelText };
        break;
      }
    }
    curId = ctx.parentMap.get(curId);
  }

  // 3. For <select>, find the currently selected option's text
  if (info.tag === 'select') {
    const selectedOption = findSelectedOptionText(node);
    if (selectedOption) return { ...info, selectedOption };
  }

  // 4. Preceding sibling label-like text (e.g. <span>用户名</span><input/>)
  const precedingLabel = findPrecedingSiblingLabel(node, ctx);
  if (precedingLabel) return { ...info, precedingLabel };

  // 5. Icon-only element (e.g. <a><svg aria-label="关闭"/></a>)
  const childIconLabel = findChildIconLabel(node);
  if (childIconLabel) return { ...info, childIconLabel };

  // 6. Link href segment fallback
  if (info.tag === 'a' && info.href) {
    const hrefLabel = hrefSegmentLabel(info.href);
    if (hrefLabel) return { ...info, hrefLabel };
  }

  // 7. Ancestor label (handles Element-UI / Radix popup wrappers etc.)
  const ancestorLabel = findAncestorLabel(node, ctx);
  if (ancestorLabel) return { ...info, ancestorLabel };

  // 8. Descendant input label — for wrapper divs (e.g. el-select__wrapper),
  // find a <label for> associated with any input/select/textarea inside.
  const descendantInputLabel = findDescendantInputLabel(node, ctx);
  if (descendantInputLabel) return { ...info, descendantInputLabel };

  return info;
}

function findSelectedOptionText(
  selectNode: serializedNodeWithId,
): string | undefined {
  if (selectNode.type !== NodeType.Element) return undefined;
  const el = selectNode;
  let selected: string | undefined;
  for (const child of el.childNodes) {
    if (
      child.type === NodeType.Element &&
      child.tagName.toLowerCase() === 'option'
    ) {
      const optAttrs = child.attributes ?? {};
      const isSelected =
        optAttrs.selected !== undefined && optAttrs.selected !== null;
      if (isSelected) {
        selected = truncate(getRecursiveText(child, 3), 40);
        break;
      }
    }
  }
  // Fallback: first option
  if (!selected) {
    for (const child of el.childNodes) {
      if (
        child.type === NodeType.Element &&
        child.tagName.toLowerCase() === 'option'
      ) {
        const text = truncate(getRecursiveText(child, 3), 40);
        if (text) {
          selected = text;
          break;
        }
      }
    }
  }
  return selected;
}

function findPrecedingSiblingLabel(
  node: serializedNodeWithId,
  ctx: ElementContext,
): string | undefined {
  const parentId = ctx.parentMap.get(node.id);
  if (parentId === undefined) return undefined;
  const parent = ctx.mirror.get(parentId);
  if (!parent || parent.type !== NodeType.Element) return undefined;
  const siblings = parent.childNodes;
  const idx = siblings.findIndex((s) => s.id === node.id);
  if (idx <= 0) return undefined;
  // Walk backwards over preceding siblings, collecting label-like text.
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i];
    if (sib.type === NodeType.Text) {
      const t = sib.textContent.replace(/\s+/g, ' ').trim();
      if (isUsefulName(t)) return truncate(t, 30);
      continue;
    }
    if (sib.type !== NodeType.Element) continue;
    const sibEl = sib;
    const sibTag = sibEl.tagName.toLowerCase();
    // Skip pure icons / non-text elements
    if (sibTag === 'svg' || sibTag === 'img' || sibTag === 'br') continue;
    const text = truncate(getRecursiveText(sib, 3), 30);
    if (isUsefulName(text)) return text;
  }
  return undefined;
}

const TAG_CHINESE: Record<string, string> = {
  a: '链接',
  button: '按钮',
  input: '输入框',
  textarea: '文本域',
  select: '下拉框',
  option: '选项',
  label: '标签',
  img: '图片',
  svg: '图标',
  canvas: '画布',
  video: '视频',
  audio: '音频',
  form: '表单',
  li: '列表项',
  tr: '表格行',
  td: '单元格',
  th: '表头单元格',
  checkbox: '复选框',
  radio: '单选框',
  span: '文本',
  div: '区域',
  p: '段落',
  ul: '列表',
  ol: '列表',
  table: '表格',
  thead: '表头',
  tbody: '表体',
  nav: '导航',
  header: '页头',
  footer: '页脚',
  section: '区块',
  article: '文章',
  h1: '标题',
  h2: '标题',
  h3: '标题',
  h4: '标题',
  h5: '标题',
  h6: '标题',
  i: '图标',
  strong: '文本',
  em: '文本',
};

/**
 * Resolve a human-readable Chinese tag label, taking `type` and `role`
 * attributes into account for `<input>` elements (e.g.
 * `<input type="radio">` → "单选框", `<input role="switch">` → "开关").
 */
function getTagLabel(tag: string, node?: serializedNodeWithId): string {
  if (tag === 'input' && node && node.type === NodeType.Element) {
    const attrs = node.attributes ?? {};
    const type = (attrs.type as string) || '';
    const role = (attrs.role as string) || '';
    if (role === 'switch') return '开关';
    if (type === 'radio') return '单选框';
    if (type === 'checkbox') return '复选框';
    if (type === 'password') return '密码框';
    if (type === 'search') return '搜索框';
    if (type === 'number') return '数字框';
    if (type === 'email') return '邮箱框';
    if (type === 'tel') return '电话框';
    if (type === 'url') return '网址框';
    if (type === 'date') return '日期框';
    if (type === 'time') return '时间框';
    if (type === 'file') return '文件框';
    if (type === 'range') return '滑块';
    if (type === 'color') return '颜色框';
  }
  return TAG_CHINESE[tag] ?? tag;
}

/**
 * Name sources that are already self-descriptive — the text IS the label, so
 * appending the tag type would produce awkward results like "编辑span" or
 * "选择当前行区域". For these sources we return just the name.
 */
const SELF_DESCRIBTIVE_SOURCES = new Set([
  'text',
  'ancestorLabel',
  'descendantInputLabel',
  'selectedOption',
  'hrefLabel',
  'placeholder',
]);

/**
 * Build a short Chinese label for an element used in rule-based descriptions.
 * Example: "登录按钮", "用户名输入框", "状态下拉框"
 *
 * When the name comes from the element's own text (or an ancestor's text),
 * the tag suffix is omitted — "编辑" instead of "编辑span" — because the text
 * itself is already a complete label. When the name is an external label
 * (labelText, aria-label, title, ...), the tag type is appended to clarify
 * what kind of element was interacted with.
 */
function labelElement(
  node: serializedNodeWithId | undefined,
  ctx?: ElementContext,
): string {
  const info = describeElement(node, ctx);
  const tag = info.tag;

  // Ordered candidates: the first useful one becomes the name.
  // Track which source provided it so we can decide whether to append the tag.
  // NOTE: `text` (the element's own text) is placed BEFORE `precedingLabel`
  // because a button/link's own text is always more reliable than a heuristic
  // derived from the preceding sibling (which may be an unrelated element,
  // e.g. the previous button in a button group).
  const candidates: Array<{ value: string | undefined; src: string }> = [
    { value: info.labelText, src: 'labelText' },
    { value: info.label, src: 'label' },
    { value: info.placeholder, src: 'placeholder' },
    { value: info.title, src: 'title' },
    { value: info.text, src: 'text' },
    { value: info.ancestorLabel, src: 'ancestorLabel' },
    { value: info.descendantInputLabel, src: 'descendantInputLabel' },
    { value: info.childIconLabel, src: 'childIconLabel' },
    { value: info.hrefLabel, src: 'hrefLabel' },
    { value: info.selectedOption, src: 'selectedOption' },
    { value: info.alt, src: 'alt' },
    { value: info.precedingLabel, src: 'precedingLabel' },
    { value: info.testId, src: 'testId' },
  ];

  const found = candidates.find((c) => isUsefulName(c.value));
  const name = found?.value;
  const src = found?.src;

  const tagLabel = getTagLabel(tag, node);

  // Form elements (input, select, textarea) benefit from the tag suffix even
  // when the name comes from a self-descriptive source, because the tag tells
  // the user what kind of form field was interacted with (单选框, 复选框, 开关,
  // 输入框, ...). For non-form elements (span, button, div, ...), the text
  // alone is clear enough.
  const FORM_TAGS = new Set(['input', 'select', 'textarea']);

  if (!name) return tagLabel;

  // If the name is self-descriptive text, don't append the tag — it would
  // produce awkward results like "编辑文本" or "大模型文本" — unless the
  // element is a form field whose type adds useful information.
  if (src && SELF_DESCRIBTIVE_SOURCES.has(src) && !FORM_TAGS.has(tag)) {
    return truncate(name, 30);
  }

  return `${truncate(name, 30)}${tagLabel}`;
}

// ---------- Step extraction ----------

const MOUSE_INTERACTION_LABEL: Partial<Record<MouseInteractions, string>> = {
  [MouseInteractions.Click]: '点击',
  [MouseInteractions.DblClick]: '双击',
  [MouseInteractions.ContextMenu]: '右键点击',
  [MouseInteractions.Focus]: '聚焦',
  [MouseInteractions.Blur]: '离开焦点',
  [MouseInteractions.TouchStart]: '触摸',
  [MouseInteractions.TouchEnd]: '触摸结束',
};

function describeMouseInteraction(
  type: MouseInteractions,
  node: serializedNodeWithId | undefined,
  ctx: ElementContext,
): string {
  const verb = MOUSE_INTERACTION_LABEL[type];
  if (!verb) return '';
  return `${verb}了 ${labelElement(node, ctx)}`;
}

function describeInput(
  node: serializedNodeWithId | undefined,
  text: string,
  isChecked: boolean,
  ctx: ElementContext,
): string {
  const label = labelElement(node, ctx);
  const tag =
    node && node.type === NodeType.Element ? node.tagName.toLowerCase() : '';
  if (tag === 'input' || tag === 'checkbox' || tag === 'radio') {
    const type =
      node && node.type === NodeType.Element
        ? (node.attributes.type as string) || ''
        : '';
    if (type === 'checkbox' || type === 'radio') {
      return `${isChecked ? '勾选' : '取消勾选'}了 ${label}`;
    }
  }
  return `在 ${label} 中输入「${truncate(text, 40)}」`;
}

function describeScroll(
  node: serializedNodeWithId | undefined,
  x: number,
  y: number,
  ctx: ElementContext,
): string {
  const label = labelElement(node, ctx);
  return `滚动 ${label} 到位置 (${Math.round(x)}, ${Math.round(y)})`;
}

function describeViewportResize(width: number, height: number): string {
  return `调整窗口大小为 ${width}x${height}`;
}

function describeMeta(href: string, width: number, height: number): string {
  let host = href;
  try {
    host = new URL(href).host || href;
  } catch {
    /* keep raw href */
  }
  return `访问页面 ${host}（视口 ${width}x${height}）`;
}

function describeCustom(tag: string): string {
  return `触发自定义事件「${tag}」`;
}

/**
 * Walk through rrweb events and produce rule-based Chinese step descriptions.
 *
 * The mirror is updated as we iterate so that later events can look up
 * the most recent state of an element by id.
 */
export function extractOperationSteps(
  events: eventWithTime[],
): OperationStep[] {
  const ctx: ElementContext = {
    mirror: new Map(),
    parentMap: new Map(),
    labelForMap: new Map(),
  };
  const steps: OperationStep[] = [];
  let startTimestamp = 0;
  let lastScrollStep: OperationStep | null = null;
  let lastInputStep: OperationStep | null = null;

  for (const event of events) {
    if (!startTimestamp) startTimestamp = event.timestamp;
    const offset = event.timestamp - startTimestamp;

    switch (event.type) {
      case EventType.Meta: {
        const { href, width, height } = event.data;
        steps.push({
          index: steps.length,
          offset,
          time: formatTime(offset),
          timestamp: event.timestamp,
          description: describeMeta(href, width, height),
          context: {
            kind: 'meta',
            href,
            width,
            height,
          },
        });
        break;
      }
      case EventType.FullSnapshot: {
        buildMirrorFromFullSnapshot(event, ctx);
        break;
      }
      case EventType.IncrementalSnapshot: {
        const data = event.data;
        // Keep the mirror in sync so subsequent lookups see the latest DOM
        applyMutationToMirror(event, ctx);

        switch (data.source) {
          case IncrementalSource.MouseInteraction: {
            // Skip noisy MouseUp/MouseDown which usually pair with a Click
            if (
              data.type === MouseInteractions.MouseUp ||
              data.type === MouseInteractions.MouseDown
            ) {
              break;
            }
            const node = ctx.mirror.get(data.id);
            const description = describeMouseInteraction(data.type, node, ctx);
            if (!description) break;
            steps.push({
              index: steps.length,
              offset,
              time: formatTime(offset),
              timestamp: event.timestamp,
              description,
              context: {
                kind: 'mouse-interaction',
                interactionType: MouseInteractions[data.type],
                element: describeElement(node, ctx),
              },
            });
            lastInputStep = null;
            lastScrollStep = null;
            break;
          }
          case IncrementalSource.Input: {
            const node = ctx.mirror.get(data.id);
            // Skip noise: input events on elements that were never captured
            // (e.g. hidden/programmatic inputs) when the text is empty and
            // there is no checkbox/radio state change.
            if (!node && !data.text && !data.isChecked) {
              break;
            }
            const description = describeInput(
              node,
              data.text,
              data.isChecked,
              ctx,
            );
            // Coalesce input events on the same element as long as no other
            // interaction (click / scroll / ...) interrupted the typing.
            // The previous step is reset to null by every other branch below,
            // so reaching here with a non-null `lastInputStep` on the same
            // node means the user is still typing into the same field — keep
            // updating its description so only the final value is shown.
            if (
              lastInputStep &&
              (lastInputStep.context.nodeId as number) === data.id
            ) {
              lastInputStep.description = description;
              lastInputStep.offset = offset;
              lastInputStep.time = formatTime(offset);
              lastInputStep.timestamp = event.timestamp;
              lastInputStep.context.text = data.text;
              lastInputStep.context.isChecked = data.isChecked;
            } else {
              steps.push({
                index: steps.length,
                offset,
                time: formatTime(offset),
                timestamp: event.timestamp,
                description,
                context: {
                  kind: 'input',
                  nodeId: data.id,
                  text: data.text,
                  isChecked: data.isChecked,
                  element: describeElement(node, ctx),
                },
              });
              lastInputStep = steps[steps.length - 1];
            }
            lastScrollStep = null;
            break;
          }
          case IncrementalSource.Scroll: {
            // Throttle: only emit a scroll step if the last one was > 800ms ago
            if (
              lastScrollStep &&
              offset - lastScrollStep.offset < 800 &&
              (lastScrollStep.context.id as number) === data.id
            ) {
              lastScrollStep.offset = offset;
              lastScrollStep.time = formatTime(offset);
              lastScrollStep.timestamp = event.timestamp;
              lastScrollStep.description = describeScroll(
                ctx.mirror.get(data.id),
                data.x,
                data.y,
                ctx,
              );
            } else {
              const node = ctx.mirror.get(data.id);
              steps.push({
                index: steps.length,
                offset,
                time: formatTime(offset),
                timestamp: event.timestamp,
                description: describeScroll(node, data.x, data.y, ctx),
                context: {
                  kind: 'scroll',
                  id: data.id,
                  x: data.x,
                  y: data.y,
                  element: describeElement(node, ctx),
                },
              });
              lastScrollStep = steps[steps.length - 1];
            }
            lastInputStep = null;
            break;
          }
          case IncrementalSource.ViewportResize: {
            steps.push({
              index: steps.length,
              offset,
              time: formatTime(offset),
              timestamp: event.timestamp,
              description: describeViewportResize(data.width, data.height),
              context: {
                kind: 'viewport-resize',
                width: data.width,
                height: data.height,
              },
            });
            lastInputStep = null;
            lastScrollStep = null;
            break;
          }
          case IncrementalSource.Selection: {
            // `selectionchange` fires on every cursor movement while typing
            // (and on every IME composition step). These selection changes
            // are not meaningful user actions — they merely accompany the
            // input. If we emitted them as steps AND reset `lastInputStep`,
            // the input coalescing above would be fragmented, producing one
            // step per keystroke instead of a single step with the final
            // value. So while the user is actively typing into a field
            // (`lastInputStep` is set), skip selection events entirely and
            // keep the input chain alive so subsequent keystrokes keep
            // updating the same step.
            if (lastInputStep) {
              break;
            }
            steps.push({
              index: steps.length,
              offset,
              time: formatTime(offset),
              timestamp: event.timestamp,
              description: '选中文本',
              context: {
                kind: 'selection',
                ranges: data.ranges,
              },
            });
            lastScrollStep = null;
            break;
          }
          default:
            // Skip mutation / canvas / font / style-sheet events: too noisy
            // for a human-readable step list.
            break;
        }
        break;
      }
      case EventType.Custom: {
        steps.push({
          index: steps.length,
          offset,
          time: formatTime(offset),
          timestamp: event.timestamp,
          description: describeCustom(event.data.tag),
          context: {
            kind: 'custom',
            tag: event.data.tag,
            payload: event.data.payload,
          },
        });
        // A custom event is an explicit user action; it should break any
        // in-progress input coalescing so the next keystroke starts fresh.
        lastInputStep = null;
        lastScrollStep = null;
        break;
      }
      default:
        break;
    }
  }

  return steps;
}

// ---------- LLM call ----------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatCompletionResponse = {
  choices?: Array<{
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string };
};

async function callLLM(
  settings: LLMSettings,
  messages: ChatMessage[],
  options: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  if (!settings.endpoint) throw new Error('LLM endpoint 未配置');
  if (!settings.apiKey) throw new Error('LLM API key 未配置');
  if (!settings.model) throw new Error('LLM model 未配置');

  const res = await fetch(settings.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 4096,
      // 关闭推理模型的 thinking 模式（SiliconFlow / Qwen3 等），
      // 使其直接在 content 字段返回结果，而非 reasoning_content。
      enable_thinking: false,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM 请求失败 (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as ChatCompletionResponse;
  if (json.error?.message) throw new Error(json.error.message);
  const msg = json.choices?.[0]?.message;
  // 优先取 content；若为空（推理模型未关闭 thinking 时），回退到 reasoning_content
  const content = msg?.content || msg?.reasoning_content || '';
  return content;
}

export const STEP_BATCH_SIZE = 40;

function buildStepRefinementMessages(batch: OperationStep[]): ChatMessage[] {
  const system =
    '你是一个网页操作录制分析助手。给定一组结构化的用户操作步骤（JSON 数组），' +
    '请为每个步骤生成简洁、自然的中文描述，说明用户做了什么。\n' +
    '要求：\n' +
    '1. 每个步骤对应一条描述，按 index 顺序输出\n' +
    '2. 元素名称必须取自 element 中的具体字段，优先级如下（依次取首个非空）：' +
    'labelText > label > placeholder > title > precedingLabel > alt > ' +
    'childIconLabel > hrefLabel > selectedOption > ancestorLabel > ' +
    'descendantInputLabel > text > testId。' +
    '描述形如「点击了登录按钮」「在用户名输入框输入了 admin」「在状态下拉框选择已发布」。' +
    '严禁出现「下拉选择框」「输入框」「选择框输入区域」这类无具体名称的笼统表述；' +
    '若所有字段都为空，再用 tag 类型泛称。\n' +
    '3. 严禁使用 element.id 字段（已不提供），严禁使用任何形如 el-id-* / radix-* / rc-* ' +
    '/ __BVID__* / 纯数字 / UUID 的内部标识作为名称。\n' +
    '4. 严格依据 kind 与 interactionType 描述真实发生的操作，禁止臆造未发生的事件，' +
    '例如禁止把 Focus/Blur 改写成「鼠标悬停」、禁止新增原始数据中没有的点击或滚动。\n' +
    '5. Click →「点击了 X」；Focus →「聚焦了 X」/「进入 X」；Blur →「离开 X 的焦点」；' +
    'Input →「在 X 中输入了 Y」；Scroll →「在 X 上滚动」；ViewportResize →「调整窗口大小」。\n' +
    '6. 保留每个步骤的 index 和 time 字段不变\n' +
    '7. 只输出 JSON 数组，每个元素形如 {"index": 0, "time": "00:05", "description": "..."}，' +
    '不要包含任何解释文字或 markdown 代码块标记。';

  const user = JSON.stringify(
    batch.map((s) => {
      const el = s.context.element as Record<string, unknown> | undefined;
      // Only send identifiers that survived the "useful name" filter, so the
      // LLM never sees raw framework-generated ids like `el-id-4198-63`.
      const filteredEl = el
        ? {
            tag: el.tag,
            labelText: el.labelText,
            label: el.label,
            placeholder: el.placeholder,
            title: el.title,
            alt: el.alt,
            text: el.text,
            precedingLabel: el.precedingLabel,
            selectedOption: el.selectedOption,
            childIconLabel: el.childIconLabel,
            hrefLabel: el.hrefLabel,
            ancestorLabel: el.ancestorLabel,
            descendantInputLabel: el.descendantInputLabel,
            testId: el.testId,
            name: el.name,
            role: el.role,
          }
        : undefined;
      return {
        index: s.index,
        time: s.time,
        kind: s.context.kind,
        interactionType: s.context.interactionType,
        element: filteredEl,
        text: s.context.text,
        isChecked: s.context.isChecked,
        x: s.context.x,
        y: s.context.y,
        width: s.context.width,
        height: s.context.height,
        href: s.context.href,
        tag: s.context.tag,
        ruleBasedDescription: s.description,
      };
    }),
    null,
    2,
  );

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function parseStepRefinementResponse(
  content: string,
): Array<{ index: number; time: string; description: string }> {
  // Strip markdown code fences if the model added them
  let text = content.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1) {
    // Include a snippet of the raw content so the user (and the error log)
    // can see what the model actually returned instead of a generic message.
    throw new Error(
      `LLM 返回内容不是合法的 JSON 数组。原始内容（前 500 字）: ${content.slice(
        0,
        500,
      )}`,
    );
  }
  const json = text.slice(start, end + 1);
  let parsed: Array<{
    index: number;
    time?: string;
    description?: string;
  }>;
  try {
    parsed = JSON.parse(json) as Array<{
      index: number;
      time?: string;
      description?: string;
    }>;
  } catch (e) {
    throw new Error(
      `LLM 返回的 JSON 解析失败: ${
        (e as Error).message
      }。原始内容（前 500 字）: ${content.slice(0, 500)}`,
    );
  }
  return parsed.map((item) => ({
    index: item.index,
    time: item.time ?? '',
    description: item.description ?? '',
  }));
}

function buildOverallSummaryMessages(
  steps: Array<{ time: string; description: string }>,
): ChatMessage[] {
  const system =
    '你是一个网页操作录制分析助手。基于给定的用户操作步骤列表，' +
    '请用中文生成一段 100-200 字的总结，概括用户在这次录制中完成的主要任务。\n' +
    '要求：自然流畅，突出主要目的和关键步骤，不要分条列举，只输出总结文本。';
  const user = steps
    .map((s, i) => `${i + 1}. [${s.time}] ${s.description}`)
    .join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------- Public API ----------

export type SummarizePhase =
  | 'extracting'
  | 'refining'
  | 'summarizing'
  | 'done'
  | 'error'
  | 'aborted';

export type SummarizeProgress = {
  phase: SummarizePhase;
  totalSteps: number;
  refinedSteps: number;
  totalBatches: number;
  completedBatches: number;
  /** Current best-known step list (rule-based descriptions get incrementally
   *  replaced by LLM-refined ones as batches complete). */
  steps: Array<{ index: number; time: string; description: string }>;
  overallSummary?: string;
  error?: string;
};

export type SummarizeOptions = {
  /** Called whenever progress changes (phase change, batch done, etc.). */
  onProgress?: (progress: SummarizeProgress) => void;
  /** Optional abort signal. When aborted, the function stops processing
   *  further LLM batches and returns what has been refined so far. */
  signal?: AbortSignal;
};

/**
 * Generate a Chinese summary of a recording.
 *
 * 1. Always extracts rule-based operation steps locally.
 * 2. When `llm.enabled` is true (and configured), refines each step description
 *    and produces an overall summary via an OpenAI-compatible API.
 *
 * When `onProgress` is supplied, it is invoked:
 *   - once with phase `extracting` after the local rule-based steps are ready
 *   - once per completed LLM batch (phase `refining`)
 *   - once with phase `summarizing` before the overall-summary call
 *   - once with phase `done` (or `error`) at the end
 * The caller can render `progress.steps` incrementally so the user sees
 * results as soon as they are available, instead of staring at a spinner.
 */
export async function summarizeRecording(
  events: eventWithTime[],
  llm: LLMSettings,
  options: SummarizeOptions = {},
): Promise<SummaryResult> {
  const { onProgress, signal } = options;

  const emit = (p: SummarizeProgress) => {
    onProgress?.(p);
  };

  // Helper: returns true if the caller aborted via the signal.
  const aborted = () => signal?.aborted === true;

  const steps = extractOperationSteps(events);
  // Mutable list: starts as rule-based, descriptions get replaced in place
  // as each LLM batch returns refined text.
  const current: Array<{
    index: number;
    time: string;
    description: string;
  }> = steps.map((s) => ({
    index: s.index,
    time: s.time,
    description: s.description,
  }));

  // Return a fresh snapshot so React state updates are detected even though
  // we mutate `current` in place between batches.
  const snapshot = () => current.map((s) => ({ ...s }));

  const totalSteps = current.length;

  // Always emit the rule-based steps first so the UI can show something
  // immediately, even when LLM is disabled or fails.
  emit({
    phase: 'extracting',
    totalSteps,
    refinedSteps: 0,
    totalBatches: 0,
    completedBatches: 0,
    steps: snapshot(),
  });

  if (!llm.enabled || !llm.apiKey || !llm.endpoint) {
    emit({
      phase: 'done',
      totalSteps,
      refinedSteps: 0,
      totalBatches: 0,
      completedBatches: 0,
      steps: snapshot(),
    });
    return { steps: snapshot(), llmUsed: false };
  }

  const totalBatches = Math.max(1, Math.ceil(steps.length / STEP_BATCH_SIZE));
  let completedBatches = 0;
  let refinedSteps = 0;

  try {
    for (let i = 0; i < steps.length; i += STEP_BATCH_SIZE) {
      // Check abort before starting each batch so we don't kick off another
      // (potentially slow) LLM call when the user already pressed Stop.
      if (aborted()) {
        emit({
          phase: 'aborted',
          totalSteps,
          refinedSteps,
          totalBatches,
          completedBatches,
          steps: snapshot(),
        });
        return {
          steps: snapshot(),
          llmUsed: refinedSteps > 0,
          error: 'aborted',
        };
      }
      const batch = steps.slice(i, i + STEP_BATCH_SIZE);
      const content = await callLLM(
        llm,
        buildStepRefinementMessages(batch),
        signal ? { signal } : undefined,
      );
      // Parse failures for a single batch should not abort the entire
      // generation. Log the raw content to the console for debugging and
      // fall back to rule-based descriptions for this batch only.
      let part: Array<{ index: number; time: string; description: string }> =
        [];
      try {
        part = parseStepRefinementResponse(content);
      } catch (parseErr) {
        // eslint-disable-next-line no-console
        console.error(
          `[summarize] batch ${completedBatches + 1}/${totalBatches} 解析失败:`,
          (parseErr as Error).message,
          '\n原始 LLM 返回内容:\n',
          content,
        );
      }
      // Merge: use refined description when present, else keep rule-based.
      for (const step of batch) {
        const found = part.find((p) => p.index === step.index);
        const target = current.find((c) => c.index === step.index);
        if (target && found?.description) {
          target.description = found.description;
          refinedSteps++;
        }
      }
      completedBatches++;
      emit({
        phase: 'refining',
        totalSteps,
        refinedSteps,
        totalBatches,
        completedBatches,
        steps: snapshot(),
      });
    }

    // Check abort before the optional overall-summary call.
    if (aborted()) {
      emit({
        phase: 'aborted',
        totalSteps,
        refinedSteps,
        totalBatches,
        completedBatches,
        steps: snapshot(),
      });
      return { steps: snapshot(), llmUsed: true, error: 'aborted' };
    }

    // Overall summary from the (possibly refined) step list
    emit({
      phase: 'summarizing',
      totalSteps,
      refinedSteps,
      totalBatches,
      completedBatches,
      steps: snapshot(),
    });
    let overallSummary: string | undefined;
    try {
      overallSummary = (
        await callLLM(llm, buildOverallSummaryMessages(current), {
          temperature: 0.4,
          ...(signal ? { signal } : {}),
        })
      ).trim();
    } catch {
      // The overall summary is best-effort; ignore failures here.
    }

    emit({
      phase: 'done',
      totalSteps,
      refinedSteps,
      totalBatches,
      completedBatches,
      steps: snapshot(),
      overallSummary,
    });
    return { steps: snapshot(), overallSummary, llmUsed: true };
  } catch (e) {
    // If the fetch was aborted, the AbortError surfaces here. Treat it as a
    // clean stop rather than an error: keep whatever has been refined so
    // far and return with error: 'aborted'.
    if (aborted() || (e as Error).name === 'AbortError') {
      emit({
        phase: 'aborted',
        totalSteps,
        refinedSteps,
        totalBatches,
        completedBatches,
        steps: snapshot(),
      });
      return {
        steps: snapshot(),
        llmUsed: refinedSteps > 0,
        error: 'aborted',
      };
    }
    const errMsg = (e as Error).message;
    emit({
      phase: 'error',
      totalSteps,
      refinedSteps,
      totalBatches,
      completedBatches,
      steps: snapshot(),
      error: errMsg,
    });
    return { steps: snapshot(), llmUsed: false, error: errMsg };
  }
}

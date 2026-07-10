import Browser from 'webextension-polyfill';
import { SyncDataKey, type LLMSettings, type Settings } from '~/types';

export const DEFAULT_LLM_SETTINGS: LLMSettings = {
  // SiliconFlow OpenAI 兼容接口
  endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
  apiKey: 'sk-segbudizsgujqsjppgaeybfgztgsulgbjgxqozubeniariag',
  model: 'Qwen/Qwen3.6-35B-A3B',
  enabled: true,
};

/**
 * Read the LLM settings from chrome.storage.sync.
 * Falls back to defaults when not configured yet.
 */
export async function getLLMSettings(): Promise<LLMSettings> {
  const data = (await Browser.storage.sync.get(
    SyncDataKey.settings,
  )) as Partial<{ settings: Settings }>;
  const llm = data?.settings?.llm;
  return { ...DEFAULT_LLM_SETTINGS, ...(llm ?? {}) };
}

/**
 * Persist the LLM settings.
 */
export async function setLLMSettings(llm: LLMSettings): Promise<void> {
  const data = (await Browser.storage.sync.get(
    SyncDataKey.settings,
  )) as Partial<{ settings: Settings }>;
  const settings: Settings = { ...(data?.settings ?? {}), llm };
  await Browser.storage.sync.set({ settings });
}

/**
 * Subscribe to LLM settings changes.
 * @returns an unsubscribe function
 */
export function onLLMSettingsChange(
  handler: (llm: LLMSettings) => void,
): () => void {
  const listener = () => {
    void getLLMSettings().then(handler);
  };
  Browser.storage.onChanged.addListener(listener);
  return () => {
    Browser.storage.onChanged.removeListener(listener);
  };
}

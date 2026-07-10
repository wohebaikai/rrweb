/// <reference types="chrome"/>
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  AlertIcon,
  Badge,
  Box,
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  Button,
  Code,
  Flex,
  Heading,
  List,
  ListItem,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { FiRefreshCw, FiSettings, FiStopCircle, FiTrash2 } from 'react-icons/fi';
import Browser from 'webextension-polyfill';
import { deleteSummary, getEvents, getSession, getSummary, saveSummary, SUMMARY_SCHEMA_VERSION } from '~/utils/storage';
import {
  STEP_BATCH_SIZE,
  summarizeRecording,
  type SummaryResult,
  type SummarizeProgress,
} from '~/utils/summarize';
import { getLLMSettings } from '~/utils/llmSettings';
import type { LLMSettings } from '~/types';

export default function Summary() {
  const { sessionId } = useParams();
  const [sessionName, setSessionName] = useState('');
  const [llm, setLLM] = useState<LLMSettings | null>(null);
  const [result, setResult] = useState<SummaryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<SummarizeProgress | null>(null);
  // Holds the AbortController for the in-flight summarization. Clicking
  // "停止" calls abort() on it, which cancels the current LLM fetch and
  // causes summarizeRecording to return whatever has been refined so far.
  const abortRef = useRef<AbortController | null>(null);

  const runSummary = async (
    currentLlm: LLMSettings | null,
    options: { force?: boolean } = {},
  ) => {
    if (!sessionId) return;
    setLoading(true);
    setErrorMsg('');
    setProgress(null);
    // When regenerating, clear the existing result and delete the stored
    // summary first so the UI starts fresh and a failed/aborted run does
    // not fall back to stale data.
    if (options.force) {
      setResult(null);
      setGeneratedAt(null);
      // Yield to the event loop so React actually renders the cleared
      // (empty) state before summarizeRecording's synchronous extracting
      // emit calls setResult() again. Without this, React 18's automatic
      // batching can merge the null state with the next state, and the
      // user never sees the old content disappear.
      await new Promise((r) => setTimeout(r, 0));
      await deleteSummary(sessionId).catch(() => {});
    }
    // Create a fresh controller for this run. Stopping is done via abortRef.
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      // If not forced, try to load a previously stored summary first.
      // Summaries produced by an older algorithm version are ignored so the
      // user always sees output from the current labeling logic.
      if (!options.force) {
        const stored = await getSummary(sessionId);
        if (stored && stored.schemaVersion === SUMMARY_SCHEMA_VERSION) {
          setResult(stored.result);
          setGeneratedAt(stored.generatedAt);
          return;
        }
      }
      const events = await getEvents(sessionId);
      const settingsToUse = currentLlm ?? (await getLLMSettings());
      const res = await summarizeRecording(events, settingsToUse, {
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p);
          // When regenerating (force), skip the synchronous 'extracting'
          // emit so the cleared state (spinner) stays visible until real
          // new content arrives. The extracting phase fires synchronously
          // inside summarizeRecording; without this guard it would
          // repopulate `result` in the same tick as the `setResult(null)`
          // above, so React never paints the empty state and the user
          // can't tell old content was cleared.
          if (options.force && p.phase === 'extracting') {
            return;
          }
          // Stream the partial result so the user sees steps appear as
          // soon as they are refined, instead of staring at a spinner.
          setResult({
            steps: p.steps,
            overallSummary: p.overallSummary,
            llmUsed: p.phase !== 'extracting' && p.phase !== 'error',
            error: p.error,
          });
        },
      });
      setResult(res);
      setGeneratedAt(Date.now());
      if (res.error && res.error !== 'aborted') setErrorMsg(res.error);
      else if (res.error === 'aborted') setErrorMsg('');
      // Persist the generated summary so it can be reused next time.
      // Aborted runs are still saved: they contain the rule-based + any
      // refined steps the user explicitly chose to keep.
      await saveSummary(sessionId, res, {
        enabled: settingsToUse.enabled,
        endpoint: settingsToUse.endpoint,
        model: settingsToUse.model,
      });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        // Already handled via progress phase 'aborted'; nothing to do.
      } else {
        setErrorMsg((e as Error).message);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  };

  const stopSummary = () => {
    abortRef.current?.abort();
  };

  // Clear the displayed result and delete the stored summary so the next
  // visit (or "重新生成") starts fresh. Does NOT auto-trigger a new run —
  // the user explicitly chose to clear, so leave the page empty until they
  // click "重新生成".
  const clearSummary = async () => {
    if (!sessionId) return;
    // Stop any in-flight generation first so its onProgress callbacks don't
    // repopulate `result` right after we clear it.
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setResult(null);
    setGeneratedAt(null);
    setProgress(null);
    setErrorMsg('');
    await deleteSummary(sessionId).catch(() => {});
  };

  useEffect(() => {
    if (!sessionId) return;
    void getSession(sessionId)
      .then((session) => setSessionName(session.name))
      .catch((err) => console.error(err));
    void getLLMSettings().then(setLLM);
  }, [sessionId]);

  useEffect(() => {
    void runSummary(llm);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <>
      <Breadcrumb mb={5} fontSize="md">
        <BreadcrumbItem>
          <BreadcrumbLink href="#">Sessions</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <BreadcrumbLink href={`#/session/${sessionId}`}>
            {sessionName}
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbItem isCurrentPage>
          <BreadcrumbLink href="#">操作总结</BreadcrumbLink>
        </BreadcrumbItem>
      </Breadcrumb>

      <Flex justify="space-between" align="center" mb={4}>
        <Heading size="md">操作步骤总结</Heading>
        <Stack direction="row" spacing={2}>
          {loading ? (
            <Button
              leftIcon={<FiStopCircle />}
              size="sm"
              colorScheme="red"
              variant="solid"
              onClick={stopSummary}
            >
              停止
            </Button>
          ) : (
            <Button
              leftIcon={<FiRefreshCw />}
              size="sm"
              onClick={() => void runSummary(llm, { force: true })}
            >
              重新生成
            </Button>
          )}
          <Button
            leftIcon={<FiTrash2 />}
            size="sm"
            variant="outline"
            colorScheme="red"
            isDisabled={!result || loading}
            onClick={() => void clearSummary()}
          >
            清空
          </Button>
          <Button
            leftIcon={<FiSettings />}
            size="sm"
            variant="outline"
            onClick={() => void Browser.runtime.openOptionsPage()}
          >
            LLM 设置
          </Button>
        </Stack>
      </Flex>

      {llm && (
        <Text fontSize="sm" color="gray.500" mb={3}>
          LLM: {llm.enabled ? '已启用' : '未启用（仅使用规则匹配）'} · 模型:{' '}
          {llm.model || '—'}
          {generatedAt
            ? ` · 上次生成: ${new Date(generatedAt).toLocaleString()}`
            : ''}
        </Text>
      )}

      {errorMsg && (
        <Alert status="warning" mb={4}>
          <AlertIcon />
          {errorMsg}
        </Alert>
      )}

      {/* Progress banner shown while the LLM is working. Renders alongside
          the step list (not instead of it) so the user can see partial
          results streaming in and tell "slow" from "stuck". */}
      {loading && progress && (
        <Flex
          align="center"
          p={3}
          mb={4}
          bg="blue.50"
          borderRadius="md"
          borderWidth="1px"
          borderColor="blue.200"
        >
          <Spinner size="sm" color="blue.500" mr={3} />
          <Text fontSize="sm" color="blue.700" flex={1}>
            {progressText(progress)}
          </Text>
        </Flex>
      )}

      {/* Initial spinner before any steps are available (extracting phase). */}
      {loading && !result && (
        <Flex justify="center" py={10}>
          <Spinner size="lg" />
        </Flex>
      )}

      {/* Empty state after the user cleared the summary (or before first
          generation when no cache existed). Prompt them to generate. */}
      {!loading && !result && (
        <Flex direction="column" align="center" py={10} color="gray.500">
          <Text mb={3}>尚未生成操作步骤总结。</Text>
          <Button
            leftIcon={<FiRefreshCw />}
            size="sm"
            onClick={() => void runSummary(llm, { force: true })}
          >
            生成总结
          </Button>
        </Flex>
      )}

      {result && (
        <Box>
          {result.overallSummary && (
            <Box
              p={4}
              mb={4}
              bg="gray.50"
              borderRadius="md"
              borderLeftWidth="4px"
              borderColor="blue.400"
            >
              <Text fontWeight="bold" mb={2}>
                总体总结
              </Text>
              <Text whiteSpace="pre-wrap">{result.overallSummary}</Text>
            </Box>
          )}

          <Flex align="center" mb={2}>
            <Heading size="sm">操作步骤</Heading>
            <Badge ml={2} colorScheme={result.llmUsed ? 'green' : 'gray'}>
              {result.llmUsed ? 'LLM 优化' : '规则匹配'}
            </Badge>
            <Badge ml={2} colorScheme="blue">
              共 {result.steps.length} 步
            </Badge>
            {loading && progress && progress.refinedSteps > 0 && (
              <Badge ml={2} colorScheme="green">
                已精炼 {progress.refinedSteps}/{progress.totalSteps}
              </Badge>
            )}
          </Flex>

          {result.steps.length === 0 ? (
            <Text color="gray.500">未提取到任何操作步骤。</Text>
          ) : (
            <List spacing={2}>
              {result.steps.map((step, idx) => {
                // Determine whether this step has been refined by the LLM:
                // batches are processed in order, so any step whose index
                // falls within a completed batch is considered refined.
                // We avoid using `idx < progress.refinedSteps` because
                // `refinedSteps` counts only successful refinements, not
                // the index range, and would mislabel steps whose LLM
                // response was skipped.
                const stepIndex = step.index;
                const completedBatchBoundary =
                  progress && progress.completedBatches > 0
                    ? progress.completedBatches * STEP_BATCH_SIZE
                    : 0;
                const isRefined =
                  !!progress &&
                  progress.phase !== 'extracting' &&
                  stepIndex < completedBatchBoundary;
                return (
                  <ListItem
                    key={step.index}
                    p={3}
                    borderWidth="1px"
                    borderRadius="md"
                    _hover={{ bg: 'gray.50' }}
                  >
                    <Flex>
                      <Box
                        minW="30px"
                        h="30px"
                        borderRadius="full"
                        bg={isRefined ? 'green.500' : 'blue.500'}
                        color="white"
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        fontSize="sm"
                        fontWeight="bold"
                        mr={3}
                        flexShrink={0}
                      >
                        {idx + 1}
                      </Box>
                      <Box flex={1}>
                        <Flex align="center" mb={1}>
                          <Code colorScheme="blue" mr={2}>
                            {step.time}
                          </Code>
                          {loading && isRefined && (
                            <Badge colorScheme="green" fontSize="xs">
                              已优化
                            </Badge>
                          )}
                        </Flex>
                        <Text>{step.description}</Text>
                      </Box>
                    </Flex>
                  </ListItem>
                );
              })}
            </List>
          )}
        </Box>
      )}
    </>
  );
}

/**
 * Human-readable Chinese status string for the current summarization phase.
 * Helps the user tell a slow LLM call from a stuck/error one.
 */
function progressText(p: SummarizeProgress): string {
  switch (p.phase) {
    case 'extracting':
      return '正在提取操作步骤…';
    case 'refining':
      return p.totalBatches > 1
        ? `正在调用 LLM 优化步骤描述（第 ${p.completedBatches}/${p.totalBatches} 批，已精炼 ${p.refinedSteps}/${p.totalSteps} 步）…`
        : `正在调用 LLM 优化步骤描述（已精炼 ${p.refinedSteps}/${p.totalSteps} 步）…`;
    case 'summarizing':
      return '正在生成总体总结…';
    case 'error':
      return `生成失败：${p.error ?? '未知错误'}`;
    case 'aborted':
      return '已停止，保留已生成的步骤。';
    case 'done':
      return '生成完成。';
    default:
      return '处理中…';
  }
}

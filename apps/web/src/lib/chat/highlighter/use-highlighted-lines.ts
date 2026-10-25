/**
 * Highlight a code block's complete lines through the shared rich-render
 * scheduler (lane "highlight": bounded concurrency, queue and cache).
 *
 * - Only complete lines are highlighted; while a fence streams, its final
 *   partial line stays plain.
 * - Results are cached by conversation scope (backend, environment, session),
 *   content hash, language, theme, font generation and highlighter version,
 *   so remounts and identical blocks of the same conversation reuse them
 *   synchronously while two environments or backends never share an entry.
 * - On-screen blocks request `visible` priority, offscreen ones idle
 *   `prefetch`; a queued prefetch is promoted when it scrolls in. With
 *   `visibility` (the block's own, from `useRichBlockVisibility`) that is
 *   per block; without it, per row.
 * - Queued source is accounted in UTF-8 bytes.
 * - When new complete lines are appended, only the appended lines are sent,
 *   resuming from the worker's retained grammar state.
 * - Previously highlighted lines keep their tokens while newer work is pending,
 *   so a completed line never flashes back to plain text.
 * - Failures leave plain code: an unsupported language is cached as
 *   deterministic, a worker failure offers a retry, a full queue falls back
 *   to plain text and retries a bounded number of times.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { utf8ByteLength } from "@orkestrator/protocol/rich-content-policy";
import { contentFingerprint, richCacheKey, useRichTranscriptScope } from "@/lib/chat/rich-identity";
import {
  RichRenderCapacityError,
  RichRenderDeterministicError,
  richRenderScheduler,
  useRichRenderEpoch,
} from "@/lib/chat/rich-render-cache";
import { useRichRenderPriority, type RichRowVisibility } from "@/lib/chat/rich-render-priority";
import { useFontGeneration } from "./font-generation";
import { highlightBackend, HighlightStateMissingError, HighlightUnsupportedError } from "./client";
import type { HighlightLanguage } from "./languages";
import { HIGHLIGHTER_VERSION, type HighlightLine, type HighlightTheme } from "./protocol";

interface HighlightResult {
  text: string;
  lang: HighlightLanguage;
  theme: HighlightTheme;
  lines: HighlightLine[];
  stateId: string | null;
}

export interface HighlightedLinesState {
  /** Highlighted tokens for the first `lines.length` display lines, or null. */
  lines: HighlightLine[] | null;
  status: "plain" | "pending" | "ready" | "error";
  /** Present with `status: "error"`: the reason plain text is shown. */
  error: "unavailable" | "capacity" | null;
  retry: () => void;
}

const MAX_CAPACITY_RETRIES = 5;
const CAPACITY_RETRY_MS = 400;

/** The complete lines of `displayText`: all of them once the fence is closed. */
export function completeLinesText(
  displayText: string,
  closed: boolean,
): { text: string; count: number } {
  if (closed) {
    const lines = displayText.split("\n");
    return { text: displayText, count: lines.length };
  }
  const lastNewline = displayText.lastIndexOf("\n");
  if (lastNewline < 0) return { text: "", count: 0 };
  const text = displayText.slice(0, lastNewline);
  return { text, count: text.split("\n").length };
}

function estimateBytes(result: HighlightResult): number {
  let tokens = 0;
  for (const line of result.lines) tokens += line.length;
  return result.text.length * 2 + tokens * 48;
}

export function useHighlightedLines(input: {
  displayText: string;
  closed: boolean;
  language: HighlightLanguage | null;
  theme: HighlightTheme;
  /** False when the block is over its highlight limits. */
  enabled: boolean;
  /** The block's own visibility; the row's when omitted. */
  visibility?: RichRowVisibility | null;
}): HighlightedLinesState {
  const { displayText, closed, language, theme, enabled } = input;
  const complete = useMemo(() => completeLinesText(displayText, closed), [displayText, closed]);
  const active = enabled && language !== null && complete.count > 0;
  // The provided scope is memoized by value, so its identity is a stable dep.
  const scope = useRichTranscriptScope();
  const fonts = useFontGeneration();
  const epoch = useRichRenderEpoch();
  const { priority, current: currentPriority } = useRichRenderPriority(input.visibility);
  const key = useMemo(
    () =>
      active
        ? richCacheKey({
            kind: "highlight",
            scope,
            contentHash: contentFingerprint(complete.text),
            rendererVersion: HIGHLIGHTER_VERSION,
            theme,
            display: [language, fonts],
          })
        : null,
    [active, complete.text, language, theme, scope, fonts],
  );
  const priorityRef = useRef(currentPriority);
  useEffect(() => {
    priorityRef.current = currentPriority;
  });
  // A queued prefetch whose block scrolled into view runs ahead of other prefetch.
  useEffect(() => {
    if (key && priority === "visible") richRenderScheduler.promote(key);
  }, [key, priority]);

  const lastResult = useRef<HighlightResult | null>(null);
  const [settled, setSettled] = useState<{ key: string; result: HighlightResult } | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: "unavailable" | "capacity" } | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  // The latest highlighted result shown, kept for display while newer lines are
  // pending (state, so render never reads the ref the async path uses).
  const [lastShown, setLastShown] = useState<HighlightResult | null>(null);

  // A cheap O(1) LRU read; remounts and identical blocks reuse settled work.
  const cachedHit = key ? richRenderScheduler.peek<HighlightResult>(key) : null;
  const cachedNow = cachedHit?.ok ? cachedHit.value : null;

  useEffect(() => {
    if (cachedNow) lastResult.current = cachedNow;
  }, [cachedNow]);

  useEffect(() => {
    if (!key || !language || cachedNow) return;
    let disposed = false;
    let capacityRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancel = () => {};

    const run = () => {
      const request = richRenderScheduler.request<HighlightResult>({
        key,
        lane: "highlight",
        priority: priorityRef.current(),
        sourceBytes: utf8ByteLength(complete.text),
        run: async (signal) => {
          const highlighter = highlightBackend();
          if (!highlighter) throw new Error("Syntax highlighting is unavailable here");
          const prior = lastResult.current;
          const full = async (): Promise<HighlightResult> => {
            const output = await highlighter.highlight(
              { lang: language, theme, code: complete.text },
              signal,
            );
            return {
              text: complete.text,
              lang: language,
              theme,
              lines: output.lines,
              stateId: output.stateId,
            };
          };
          let result: HighlightResult;
          try {
            if (
              prior?.stateId &&
              prior.lang === language &&
              prior.theme === theme &&
              complete.text.startsWith(`${prior.text}\n`)
            ) {
              try {
                const output = await highlighter.highlight(
                  {
                    lang: language,
                    theme,
                    code: complete.text.slice(prior.text.length + 1),
                    resumeStateId: prior.stateId,
                  },
                  signal,
                );
                result = {
                  text: complete.text,
                  lang: language,
                  theme,
                  lines: prior.lines.concat(output.lines),
                  stateId: output.stateId,
                };
              } catch (error) {
                if (!(error instanceof HighlightStateMissingError)) throw error;
                result = await full();
              }
            } else {
              result = await full();
            }
          } catch (error) {
            if (error instanceof HighlightUnsupportedError) {
              throw new RichRenderDeterministicError(error.message);
            }
            throw error;
          }
          return { value: result, bytes: estimateBytes(result) };
        },
      });
      cancel = request.cancel;
      request.promise.then(
        (result) => {
          if (disposed) return;
          lastResult.current = result;
          setFailure(null);
          setSettled({ key, result });
        },
        (error: unknown) => {
          if (disposed || (error instanceof DOMException && error.name === "AbortError")) return;
          if (error instanceof RichRenderCapacityError && capacityRetries < MAX_CAPACITY_RETRIES) {
            capacityRetries++;
            retryTimer = setTimeout(run, CAPACITY_RETRY_MS * capacityRetries);
            setFailure({ key, error: "capacity" });
            return;
          }
          setFailure({
            key,
            error: error instanceof RichRenderCapacityError ? "capacity" : "unavailable",
          });
        },
      );
    };
    run();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      cancel();
    };
  }, [key, language, theme, cachedNow, complete.text, attempt, epoch]);

  const retry = useCallback(() => {
    highlightBackend()?.reset?.();
    setFailure(null);
    setAttempt((value) => value + 1);
  }, []);

  const current = active ? (cachedNow ?? (settled?.key === key ? settled.result : null)) : null;
  // Adjust state while rendering (React's documented pattern), not in an effect.
  if (current && current !== lastShown) setLastShown(current);
  if (!active) return { lines: null, status: "plain", error: null, retry };
  if (current) {
    return { lines: current.lines, status: "ready", error: null, retry };
  }
  // Earlier complete lines keep their tokens while newer lines are pending.
  const prior = lastShown;
  const priorLines =
    prior &&
    prior.lang === language &&
    prior.theme === theme &&
    (complete.text === prior.text || complete.text.startsWith(`${prior.text}\n`))
      ? prior.lines
      : null;
  if (failure?.key === key) {
    return { lines: priorLines, status: "error", error: failure.error, retry };
  }
  return { lines: priorLines, status: "pending", error: null, retry };
}

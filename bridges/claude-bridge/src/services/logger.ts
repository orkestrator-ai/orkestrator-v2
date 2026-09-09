import type { MiddlewareHandler } from "hono";
import {
  bridgeDebugEnabled,
  readBridgeDebugFlag,
  createBufferedDebugLogger,
} from "@orkestrator/protocol/bridge-diagnostics";

/** Kept for standalone legacy configurations; the shared app flag takes precedence. */
export const readDebugFlag = readBridgeDebugFlag;
export const isDebugLoggingEnabled = bridgeDebugEnabled("claude");

// Only source-defined labels can reach the log. All positional strings, raw
// exceptions, model results, paths and nested objects are discarded centrally.
const DEBUG_EVENTS = new Set([
  "[event-emitter] Emitting event",
  "[event-emitter] Subscriber added",
  "[event-emitter] Subscriber removed",
  "[session-manager] Activity existence probe failed",
  "[session-manager] Agent discovery unavailable:",
  "[session-manager] CLI title generation failed:",
  "[session-manager] CLI title generation returned empty output",
  "[session-manager] CLI title generation spawn error:",
  "[session-manager] CLI title generation terminated:",
  "[session-manager] CLI title generation unavailable, using text extraction fallback",
  "[session-manager] Claude CLI not found for title generation",
  "[session-manager] Claude responded after plan denial, clearing re-prompt feedback",
  "[session-manager] Context usage control request failed:",
  "[session-manager] Created assistant message",
  "[session-manager] EnterPlanMode requested",
  "[session-manager] ExitPlanMode requested, waiting for user approval",
  "[session-manager] Failed to clean up model query:",
  "[session-manager] Failed to close query control:",
  "[session-manager] Failed to close rewind query:",
  "[session-manager] Failed to persist generated title:",
  "[session-manager] Failed to re-assert the client session alias:",
  "[session-manager] Failed to read Claude CLI version:",
  "[session-manager] Failed to read Claude SDK version:",
  "[session-manager] Fetching supported models",
  "[session-manager] Generated session title:",
  "[session-manager] Idle hydrated transcript sweep",
  "[session-manager] No resolver found for plan approval:",
  "[session-manager] No resolver found for question:",
  "[session-manager] Plan approval not found for requestId:",
  "[session-manager] Prompt completed",
  "[session-manager] Query completed successfully",
  "[session-manager] Query result",
  "[session-manager] Question not found for requestId:",
  "[session-manager] Re-prompting after approved-plan ExitPlanMode failure",
  "[session-manager] Re-prompting with plan rejection feedback",
  "[session-manager] Refusing incomplete plan approval",
  "[session-manager] Resolving promise for plan approval:",
  "[session-manager] Resolving promise for question:",
  "[session-manager] SDK env PATH",
  "[session-manager] SDK event received",
  "[session-manager] Session init data captured",
  "[session-manager] Session initialized, stored SDK session ID:",
  "[session-manager] Starting query",
  "[session-manager] Structured usage control request failed:",
  "[session-manager] Supported models fetched",
  "[session-manager] System message received",
  "[session-manager] Title generation failed:",
  "[session-manager] Title generation returned empty result",
  "[session-manager] Updated assistant message",
  "[session-manager] Using Claude CLI for title generation:",
  "http-request",
]);
const buffered = createBufferedDebugLogger("claude", DEBUG_EVENTS, isDebugLoggingEnabled);
export function debugLog(event: unknown, ...args: unknown[]): void {
  buffered.record(event, ...args);
}
export const flushDebugLogs = buffered.flush;

/** HTTP diagnostics contain no URLs, query strings, tokens or user path segments. */
export function createRequestLogger(
  enabled = isDebugLoggingEnabled,
  record = buffered.record,
): MiddlewareHandler | null {
  if (!enabled) return null;
  return async (context, next) => {
    const startedAt = Date.now();
    try {
      await next();
    } finally {
      record("http-request", {
        httpStatus: context.res.status,
        durationMs: Date.now() - startedAt,
      });
    }
  };
}

/**
 * The JSON this bridge actually serves.
 *
 * These projections are the contract: the backend's HTTP bridge provider
 * parses them identically for every agent it speaks to, so a field renamed
 * here is a field the renderer stops seeing. Nothing Cursor-specific escapes
 * past this boundary.
 */
import type {
  NativeAgentContextUsage,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import { PROVIDER } from "./config.js";
import { sessionIsWorking, type JsonObject, type SessionState } from "./state.js";

export function publicSession(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    id: state.id,
    provider: PROVIDER,
    status: state.status,
    error: state.error,
    messages: state.messages,
    // Absolute index of `messages[0]`. Clients anchor incremental reads to it
    // so evictions from the front cannot silently shift the window they append
    // to.
    baseIndex: state.droppedMessages,
    revision: state.revision,
    sessionId: state.id,
    composer: state.composer,
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

export function publicStatus(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    status: state.status,
    error: state.error,
    revision: state.revision,
    composer: state.composer,
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

export function messageWindow(state: SessionState, fromIndex: number | null): JsonObject {
  const start =
    fromIndex === null
      ? 0
      : Math.min(Math.max(fromIndex - state.droppedMessages, 0), state.messages.length);
  const baseIndex = state.droppedMessages + start;
  return {
    messages: state.messages.slice(start),
    baseIndex,
    totalMessages: state.droppedMessages + state.messages.length,
    messageWindow: {
      truncated: state.transcriptTruncated || baseIndex > 0,
      ...(baseIndex > 0 ? { omittedMessages: baseIndex } : {}),
      ...(state.droppedParts > 0 ? { omittedParts: state.droppedParts } : {}),
    },
    revision: state.revision,
    status: state.status,
    error: state.error,
  };
}

export function parseFromIndex(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Liveness for the backend's activity sweep.
 *
 * `working` must mean a turn or a background child is genuinely running: an
 * environment reported idle while a sub-agent still writes files is how a
 * build pipeline advances past a turn that has not finished. An errored
 * session is not special-cased — every path that fails a turn also settles its
 * children, so `error` with children still registered would be a real claim.
 */
export function publicActivity(state: SessionState): JsonObject {
  return { activity: sessionIsWorking(state) ? "working" : "idle" };
}

/**
 * Did this bridge ever take this request id?
 *
 * `dispatched` is only ever an explicit positive from this process's own
 * journal. A record that predates a restart is persisted as `ambiguous` and
 * answers `unknown`, so a lost record can never be mistaken for a prompt that
 * was never sent — the caller would run the same turn twice.
 */
export function publicDispatch(state: SessionState, requestId: string): JsonObject {
  const entry = requestId ? state.promptJournal.get(requestId) : undefined;
  const dispatched =
    entry?.state === "accepted" || entry?.state === "completed" || entry?.state === "failed";
  return { dispatch: dispatched ? "dispatched" : "unknown" };
}

export function publicContextUsage(state: SessionState): NativeAgentContextUsage | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  const turn = usage.turn;
  const used =
    (turn.inputTokens ?? 0) +
    (turn.outputTokens ?? 0) +
    (turn.cacheReadTokens ?? 0) +
    (turn.cacheWriteTokens ?? 0);
  if (used === 0) return undefined;
  const model = state.composer.models.find((entry) => entry.id === usage.modelId);
  return {
    usedTokens: used,
    ...(model?.contextWindow ? { maximumTokens: model.contextWindow } : {}),
    ...(usage.modelId ? { modelId: usage.modelId } : {}),
    ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(turn.cacheReadTokens !== undefined ? { cacheReadTokens: turn.cacheReadTokens } : {}),
    ...(turn.cacheWriteTokens !== undefined ? { cacheWriteTokens: turn.cacheWriteTokens } : {}),
    ...(turn.reasoningTokens !== undefined ? { reasoningTokens: turn.reasoningTokens } : {}),
    lastTurnTokens: used,
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    source: "provider",
    updatedAt: usage.updatedAt,
  };
}

export function publicRuntime(state: SessionState): NativeAgentRuntimeSummary {
  return {
    ...(state.todos.length > 0 ? { todos: state.todos.length } : {}),
    state: state.agent ? "attached" : "detached",
  };
}

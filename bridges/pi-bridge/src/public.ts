/**
 * The JSON this bridge actually serves.
 *
 * These projections are the contract: the backend's HTTP bridge provider
 * parses them identically for every agent it speaks to, so a field renamed
 * here is a field the renderer stops seeing. Nothing Pi-specific escapes past
 * this boundary.
 */
import type {
  NativeAgentContextUsage,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import { PROVIDER } from "./config.js";
import {
  piRunId,
  sessionIsBlocked,
  sessionIsWorking,
  type JsonObject,
  type SessionState,
} from "./state.js";

export function publicSession(state: SessionState): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    id: state.id,
    provider: PROVIDER,
    status: state.status,
    ...(state.status === "running" ? { turnId: piRunId(state) } : {}),
    error: state.error,
    ...(state.title ? { title: state.title } : {}),
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
    ...(state.status === "running" ? { turnId: piRunId(state) } : {}),
    error: state.error,
    revision: state.revision,
    // The backend reads the title from this route and no other — `/session/:id`
    // carries one too, but nothing calls it for Pi. Omitting it here left the
    // title Pi reports in `session_info_changed` stranded in bridge state.
    ...(state.title ? { title: state.title } : {}),
    composer: state.composer,
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

/**
 * The transcript window the backend parses.
 *
 * Two fields here are read from an exact path rather than by name, so their
 * shape is the contract and not a detail: `readTranscript` takes truncation
 * from `messageWindow.truncated` and the failure text from a top-level
 * `error`. A flat `truncated` and an absent `error` both parse cleanly as
 * "false" and "no error" — which is why serving them that way showed an
 * errored Pi turn as an empty failed tab and made the truncation notice
 * unreachable. This matches `acp-public.ts`.
 */
export function messageWindow(state: SessionState, fromIndex: number | null): JsonObject {
  const baseIndex = state.droppedMessages;
  // An anchor at or before the first retained message cannot be served
  // incrementally without silently skipping the evicted range, so the whole
  // retained window goes back instead.
  const start =
    fromIndex === null || fromIndex < baseIndex
      ? 0
      : Math.min(fromIndex - baseIndex, state.messages.length);
  const omittedMessages = baseIndex + start;
  return {
    messages: state.messages.slice(start),
    baseIndex: omittedMessages,
    totalMessages: baseIndex + state.messages.length,
    messageWindow: {
      truncated: state.transcriptTruncated || omittedMessages > 0,
      ...(omittedMessages > 0 ? { omittedMessages } : {}),
      ...(state.droppedParts > 0 ? { omittedParts: state.droppedParts } : {}),
    },
    revision: state.revision,
    status: state.status,
    error: state.error,
  };
}

export function parseFromIndex(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Liveness for the backend's activity sweep.
 *
 * `blocked` outranks `working` because it is the more actionable answer: a
 * session parked on an approval is not going to progress on its own, and a
 * build pipeline that reads it as merely busy will wait for a turn that is
 * waiting for a person.
 */
export function publicActivity(state: SessionState): JsonObject {
  if (sessionIsBlocked(state)) return { activity: "blocked" };
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

export function publicSteerDispatch(state: SessionState, requestId: string): JsonObject {
  const entry = requestId ? state.steerJournal.get(requestId) : undefined;
  return {
    dispatch:
      entry?.state === "delivered"
        ? "dispatched"
        : entry?.state === "dropped"
          ? "absent"
          : "unknown",
  };
}

/**
 * How full the model's context is.
 *
 * Pi reports whole-session occupancy directly and accounts for compaction, so
 * that is what the meter shows when it is available; the per-turn token counts
 * ride alongside as the breakdown. Without it, the last turn's own totals are
 * the only honest number, and the meter degrades to showing that.
 */
export function publicContextUsage(state: SessionState): NativeAgentContextUsage | undefined {
  const usage = state.usage;
  if (!usage) return undefined;
  const turn = usage.turn;
  const turnTokens =
    (turn.inputTokens ?? 0) +
    (turn.outputTokens ?? 0) +
    (turn.cacheReadTokens ?? 0) +
    (turn.cacheWriteTokens ?? 0);
  const used = usage.contextTokens ?? turnTokens;
  if (used === 0) return undefined;
  const model = state.composer.models.find((entry) => entry.id === usage.modelId);
  const maximum = usage.contextWindow ?? model?.contextWindow;
  return {
    usedTokens: used,
    ...(maximum ? { maximumTokens: maximum } : {}),
    ...(usage.modelId ? { modelId: usage.modelId } : {}),
    ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(turn.cacheReadTokens !== undefined ? { cacheReadTokens: turn.cacheReadTokens } : {}),
    ...(turn.cacheWriteTokens !== undefined ? { cacheWriteTokens: turn.cacheWriteTokens } : {}),
    ...(turn.reasoningTokens !== undefined ? { reasoningTokens: turn.reasoningTokens } : {}),
    lastTurnTokens: turnTokens,
    ...(usage.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    source: "provider",
    updatedAt: usage.updatedAt,
  };
}

export function publicRuntime(state: SessionState): NativeAgentRuntimeSummary {
  return {
    ...(state.todos.length > 0 ? { todos: state.todos.length } : {}),
    state: state.session ? "attached" : "detached",
  };
}

/** The queue Pi is holding for the running turn, as the shared snapshot. */
export function publicQueue(state: SessionState): JsonObject {
  return {
    // Steering runs before the next model call, follow-ups after the run ends.
    // Both are pending prompts as far as the composer is concerned, so they are
    // reported in the order they will be delivered.
    items: [...state.queue.steering, ...state.queue.followUp].map((text, index) => ({
      id: `queued:${index}`,
      text,
    })),
  };
}

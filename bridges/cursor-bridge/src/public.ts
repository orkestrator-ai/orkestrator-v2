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
  NativeAgentReadiness,
  NativeAgentRuntimeSummary,
} from "@orkestrator/protocol/native-agent";
import { PROVIDER } from "./config.js";
import { mergeAccountWindows, peekPlanAccountWindows } from "./plan-usage.js";
import { sessionIsWorking, turnTokenTotal, type JsonObject, type SessionState } from "./state.js";

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
    ...(state.policy ? { policy: state.policy } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    runtime: publicRuntime(state),
  };
}

export function publicStatus(state: SessionState, readiness?: NativeAgentReadiness): JsonObject {
  const contextUsage = publicContextUsage(state);
  return {
    status: state.status,
    ...(state.activeRun ? { turnId: state.activeRun.id } : {}),
    error: state.error,
    revision: state.revision,
    composer: state.composer,
    ...(state.policy ? { policy: state.policy } : {}),
    ...(readiness ? { readiness } : {}),
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
  const live = state.currentRunUsage;
  const liveEstimate = state.currentTurnOutputTokenEstimate;
  const hasLiveUsage = live !== undefined || liveEstimate !== undefined;
  if (!usage && !hasLiveUsage) return undefined;
  // Do not repeat a previous completed turn's categories while presenting the
  // estimate for a new run that has not produced an exact usage frame yet.
  const turn = live ?? (hasLiveUsage ? {} : usage!.turn);
  const spent = turnTokenTotal(turn) + (liveEstimate ?? 0);
  const hasSessionTokens =
    hasLiveUsage || usage?.sessionTokens !== undefined || usage?.sessionTokenFloor !== undefined;
  // The run result is already an exact provider reading. Publish the durable
  // locally accumulated floor immediately so a completed workflow does not
  // lose its token count while Cursor's eventually consistent account endpoint
  // catches up. A later account total can only raise this value.
  const sessionTokens = hasSessionTokens
    ? Math.max(usage?.sessionTokens ?? 0, usage?.sessionTokenFloor ?? 0) +
      (hasLiveUsage ? spent : 0)
    : undefined;
  // `usedTokens` is measured against the model's context window, so it has to
  // be an occupancy figure. `turn` is cumulative across every model call the
  // run made and can exceed the window several times over, which would peg the
  // gauge at 100%; `context` is the final call's own snapshot, which is what
  // the window actually held. They are the same number on a single-call run.
  const liveContext = hasLiveUsage ? state.currentTurnUsage : undefined;
  const hasLiveContext = liveContext !== undefined && Object.keys(liveContext).length > 0;
  // A prompt clears `currentTurnUsage` before its first model call. Until that
  // call supplies an exact context snapshot, the previous completed call is
  // still the best occupancy baseline; the delta estimates only the output
  // appended since then. Treating the estimate itself as the whole context
  // made a well-used window collapse to almost 0% on every later prompt.
  const liveOccupancyBase = hasLiveContext
    ? turnTokenTotal(liveContext)
    : usage
      ? turnTokenTotal(usage.context ?? usage.turn)
      : 0;
  const used = hasLiveUsage
    ? liveOccupancyBase + (liveEstimate ?? 0)
    : usage?.context
      ? turnTokenTotal(usage.context)
      : spent;
  const modelId = hasLiveUsage
    ? (state.currentRunModelId ?? state.composer.selectedModelId)
    : usage?.modelId;
  const model = state.composer.models.find((entry) => entry.id === modelId);
  const account = mergeAccountWindows(usage?.account, peekPlanAccountWindows());
  return {
    usedTokens: used,
    ...(model?.contextWindow ? { maximumTokens: model.contextWindow } : {}),
    ...(modelId ? { modelId } : {}),
    ...(turn.inputTokens !== undefined ? { inputTokens: turn.inputTokens } : {}),
    ...(turn.outputTokens !== undefined ? { outputTokens: turn.outputTokens } : {}),
    ...(turn.cacheReadTokens !== undefined ? { cacheReadTokens: turn.cacheReadTokens } : {}),
    ...(turn.cacheWriteTokens !== undefined ? { cacheWriteTokens: turn.cacheWriteTokens } : {}),
    ...(turn.reasoningTokens !== undefined ? { reasoningTokens: turn.reasoningTokens } : {}),
    // What the turn cost, as opposed to what the window holds. The category
    // breakdown above is cumulative for the same reason.
    lastTurnTokens: spent,
    ...(sessionTokens !== undefined ? { sessionTokens } : {}),
    ...(usage?.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage?.durationMs !== undefined ? { durationMs: usage.durationMs } : {}),
    ...(usage?.turns ? { turns: usage.turns } : {}),
    ...(account ? { account } : {}),
    ...(liveEstimate !== undefined ? { estimated: true } : {}),
    source: "cursor",
    updatedAt: state.currentRunUsageUpdatedAt ?? usage!.updatedAt,
  };
}

export function publicRuntime(state: SessionState): NativeAgentRuntimeSummary {
  const drift = state.health.drift();
  const notices = state.health.listNotices();
  return {
    ...(state.todos.length > 0 ? { todos: state.todos.length } : {}),
    // What the run reported it was given, not what the composer asked for.
    ...(state.runTools ? { commands: state.runTools.length } : {}),
    state: state.agent ? "attached" : "detached",
    ...(drift ? { drift } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

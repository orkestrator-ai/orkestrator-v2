import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { isRootAssistantRecord } from "@orkestrator/protocol/model-id";
import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import type {
  BackgroundTaskSnapshot,
  SdkMessageBase,
  SessionTurnActivity,
} from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  backgroundTaskOwner,
} from "./session-manager-background-tasks.js";
import { applySessionPlanMode, recordStructuredOutput, sessions } from "./session-manager-core.js";
import { recordPromptDispatch } from "./session-manager-lifecycle.js";
import { MAX_RESULT_INPUT_UUIDS } from "./session-manager-messages.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import { syncTurnInFlightMark } from "./session-manager-turn-interruption.js";
import {
  armClaudeRuntimeIdleDetach,
  disarmClaudeRuntimeIdleDetach,
  idleClaudeRuntime,
} from "./session-manager-runtime-idle.js";
import { inProgressClaudeUsage } from "./session-manager-usage.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

// Who owns the foreground and the continuation a background task notification
// owes, for one `sendPrompt` turn. The CLI's input belongs to its runtime,
// which closes it only once idle (`session-manager-runtime-idle.ts`). Every
// function reads the turn's state when it runs; none of them keeps a copy.

/**
 * Keep failure logs useful without copying provider messages, prompts, or tool
 * output into the process log. Constructor names are code-owned metadata, but
 * still bounded and validated in case a foreign error object overrides them.
 */
export function diagnosticErrorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "NonError";
    const name = error.constructor?.name;
    return typeof name === "string" && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name)
      ? name
      : "Error";
  } catch {
    return "Error";
  }
}

export function ownsActiveTurn(turn: TurnState): boolean {
  const { session, sessionId } = turn;
  return (
    !turn.abortController.signal.aborted &&
    sessions.get(sessionId) === session &&
    session.abortController === turn.abortController
  );
}

export function pushSteerInput(
  turn: TurnState,
  message: SDKUserMessage,
): boolean | "capacity-exceeded" {
  // Only the turn that owns the root conversation can be steered.
  if (!turn.runtime || turn.runtime.latestTurn !== turn.thisTurn) return false;
  // Bound all steers for this query, not just the unacknowledged ones:
  // merged prompt batches and tool-round fold-ins share the result cap.
  if (turn.steerUuids.size >= MAX_RESULT_INPUT_UUIDS - 1) return "capacity-exceeded";
  const pushed = turn.runtime.input.push(message);
  if (pushed && typeof message.uuid === "string" && message.uuid) {
    turn.latestSteerUuid = message.uuid;
    turn.steerUuids.add(message.uuid);
    turn.unansweredSteerUuids.add(message.uuid);
  }
  return pushed;
}

export function publishStreamUsage(turn: TurnState, message: unknown) {
  const { session, sessionId } = turn;
  const usage = turn.streamUsage.apply(message);
  if (!usage || !ownsActiveTurn(turn)) return;
  session.inProgressUsage = inProgressClaudeUsage(session, usage);
  session.inProgressUsageGeneration = turn.turnGeneration;
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { contextUsage: session.inProgressUsage },
  });
}

/**
 * What the provider says it is doing, when that is not visible from the
 * transcript itself. Session state rather than a row, so a tab mounted
 * mid-compaction learns it from `GET /session/:id`.
 */
export function setTurnActivity(turn: TurnState, activity: SessionTurnActivity | undefined) {
  const { session, sessionId } = turn;
  if (!ownsActiveTurn(turn) || session.activity === activity) return;
  session.activity = activity;
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { activity: activity ?? null },
  });
}

/** Drop the thinking estimate once the thinking it measured is over. */
export function clearThinkingTokens(turn: TurnState) {
  const { session, sessionId } = turn;
  if (session.thinkingTokens === undefined || !ownsActiveTurn(turn)) return;
  session.thinkingTokens = undefined;
  turn.lastThinkingTokensEmitAt = 0;
  eventEmitter.emit({ type: "session.updated", sessionId, data: { thinkingTokens: null } });
}

/**
 * Follow the CLI out of plan mode when a status frame reports it left.
 * The ExitPlanMode handler covers the tool path; this covers exits that
 * never reach `canUseTool`. Only a turn that itself started in plan mode
 * may leave it this way: a turn started in another mode says nothing about
 * the user's toggle.
 *
 * Deliberately one-way. Entering is the EnterPlanMode handler's job, and a
 * status frame still saying `plan` just after an approved exit (the CLI
 * reports its mode lazily) would otherwise turn the toggle back on.
 */
export async function reconcilePlanModeFromStatus(turn: TurnState, reported: unknown) {
  const { session, sessionId } = turn;
  if (typeof reported !== "string" || reported === "plan" || !ownsActiveTurn(turn)) return;
  if (session.planMode !== true || turn.permissionMode !== "plan") return;
  try {
    await applySessionPlanMode(session, false);
  } catch (error) {
    log.warn("plan-mode.record-failed", { sessionId, errorClass: diagnosticErrorClass(error) });
  }
}

export function setCompletionBlockedByBackgroundTasks(turn: TurnState, blocked: boolean) {
  const { session, sessionId } = turn;
  if (!ownsActiveTurn(turn)) return;
  if (session.completionBlockedByBackgroundTasks === blocked) return;
  session.completionBlockedByBackgroundTasks = blocked;
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: { completionBlockedByBackgroundTasks: blocked },
  });
}

export function hasLiveTaskOwnedByThisQuery(turn: TurnState): boolean {
  const { session } = turn;
  return (Object.values(session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[]).some(
    (task) =>
      LIVE_BACKGROUND_TASK_STATUSES.has(task.status) &&
      backgroundTaskOwner(session, task.id) === turn.runtime,
  );
}

export function hasBackgroundTaskCandidateOwnedByThisQuery(turn: TurnState): boolean {
  return (turn.runtime?.tasks.candidates.size ?? 0) > 0;
}

export function releaseCompletedTurnToBackgroundTasks(
  turn: TurnState,
  backgroundTasksRunning: boolean,
) {
  const { session, sessionId } = turn;
  if (turn.turnReleasedToBackgroundTasks || !ownsActiveTurn(turn)) return;
  turn.turnReleasedToBackgroundTasks = true;
  turn.releasedTurnStartedAt = session.turnStartedAt;
  session.status = "idle";
  session.turnStartedAt = undefined;
  session.abortController = undefined;
  session.completionBlockedByBackgroundTasks = false;
  if (session.queryControl === turn.queryIteratorControl) {
    session.queryControl = undefined;
  }
  if (session.queryControlDraining === turn.queryIteratorControl) {
    session.queryControlDraining = undefined;
  }
  if (turn.dispatchRequestId) {
    recordPromptDispatch(sessionId, turn.dispatchRequestId, "already-processed");
  }
  syncTurnInFlightMark(session);
  eventEmitter.emit({
    type: "session.idle",
    sessionId,
    data: {
      success: true,
      backgroundTasksRunning,
      completionBlockedByBackgroundTasks: false,
    },
  });
  armClaudeRuntimeIdleDetach(turn.runtime);
}

/** The continuation this turn waited for arrived, or will no longer be waited for. */
export function stopWaitingForContinuation(turn: TurnState) {
  const { session } = turn;
  turn.awaitingContinuation = false;
  if (turn.dispatchRequestId) {
    session.retainedContinuationRequestIds?.delete(turn.dispatchRequestId);
    if (session.retainedContinuationRequestIds?.size === 0) {
      session.retainedContinuationRequestIds = undefined;
    }
  }
  syncTurnInFlightMark(session);
}

/**
 * A terminal background-task notification is going back into the CLI's root
 * loop, which owes a continuation. The runtime's idle window stretches to
 * `CONTINUATION_SILENCE_MS` and restarts on every frame, so a slow
 * continuation is never cut off and a silent one still ends.
 */
export function waitForContinuationAfterNotification(turn: TurnState) {
  const { session } = turn;
  if (!turn.queryIteratorControl) return;
  turn.awaitingContinuation = true;
  if (turn.dispatchRequestId) {
    (session.retainedContinuationRequestIds ??= new Set()).add(turn.dispatchRequestId);
  }
  // The CLI owes the root loop more of this turn; a restart now cuts it short.
  syncTurnInFlightMark(session);
  if (turn.runtime?.idleTimer) armClaudeRuntimeIdleDetach(turn.runtime);
}

export function reclaimReleasedTurnForAssistant(turn: TurnState, message: SdkMessageBase) {
  const { session, sessionId } = turn;
  if (!turn.turnReleasedToBackgroundTasks || ownsActiveTurn(turn)) return;
  const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  if (
    !isRootAssistantRecord(parentToolUseId, (message as { isSidechain?: unknown }).isSidechain) ||
    sessions.get(sessionId) !== session ||
    session.deleting ||
    // Releasing lets a follow-up turn join this CLI, and the newest turn
    // owns the root conversation. Only it may publish `running` and take
    // abort ownership; an older one doing so would point stop at a turn
    // the user has moved on from and lock the newer turn out of its own
    // reclaim.
    session.latestTurnGeneration !== turn.turnGeneration ||
    session.status !== "idle" ||
    session.abortController !== undefined
  ) {
    return;
  }

  // A terminal background-task notification is injected back into the
  // same streaming Claude session and can start another root model turn.
  // The preceding result released the UI while the task ran, but it is no
  // longer the final result once Claude resumes. Reclaim ownership so the
  // resumed response is shown as running and its later result can publish
  // the real idle edge.
  session.status = "running";
  session.turnStartedAt = turn.releasedTurnStartedAt ?? new Date().toISOString();
  session.abortController = turn.abortController;
  session.queryControl = turn.queryIteratorControl;
  // The continuation arrived, and the process holds the foreground again.
  stopWaitingForContinuation(turn);
  disarmClaudeRuntimeIdleDetach(turn.runtime);
  // This query can cross more than one result boundary: the resumed root
  // loop may launch another background task and need to release ownership
  // again. Treat each reclaim as the start of a fresh release cycle.
  turn.turnReleasedToBackgroundTasks = false;
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: {
      status: "running",
      turnStartedAt: session.turnStartedAt,
      completionBlockedByBackgroundTasks: false,
    },
  });
}

export function finishTurnInputIfSettled(turn: TurnState) {
  const { session } = turn;
  // Input, retention and the continuation watchdog belong to the newest
  // turn once this one is superseded. Its subagents' frames still reach it,
  // but releasing the process's retention from here would let it be closed
  // under a newer turn that is waiting for a continuation.
  if (turn.superseded || session.latestTurnGeneration !== turn.turnGeneration) return;
  if (!turn.receivedResult || turn.settlingResult) return;
  if (turn.inheritedContinuation) {
    // The turn this one replaced was waiting for the continuation a task
    // notification owes, and nothing has answered it yet. Release, and keep
    // waiting for it as the replaced turn was.
    turn.inheritedContinuation = false;
    turn.receivedResult = false;
    setCompletionBlockedByBackgroundTasks(turn, false);
    releaseCompletedTurnToBackgroundTasks(turn, hasLiveTaskOwnedByThisQuery(turn));
    waitForContinuationAfterNotification(turn);
    return;
  }
  const hasLiveTask = hasLiveTaskOwnedByThisQuery(turn);
  if (hasLiveTask || hasBackgroundTaskCandidateOwnedByThisQuery(turn)) {
    // The model turn is complete, but its CLI process owns work that must
    // survive the response boundary. Publish idle so a follow-up turn can
    // start — written into this same process — and keep this turn waiting
    // until the last task owned by this process settles.
    setCompletionBlockedByBackgroundTasks(turn, false);
    releaseCompletedTurnToBackgroundTasks(turn, hasLiveTask);
    return;
  }
  setCompletionBlockedByBackgroundTasks(turn, false);
  stopWaitingForContinuation(turn);
  endTurnOnWarmRuntime(turn);
}

/**
 * Nothing is owed to this turn any more. The turn ends; its CLI stays open for
 * the next prompt until the runtime's idle window releases it.
 *
 * A turn whose `sendPrompt` is still waiting stops waiting, and that prompt
 * settles the foreground as it always has (idle edge, or a plan re-prompt
 * written into this same process). A turn whose prompt settled earlier and
 * then took the foreground back for a continuation publishes its own idle
 * edge: nothing else is left to.
 */
function endTurnOnWarmRuntime(turn: TurnState) {
  const { session } = turn;
  const runtime = turn.runtime;
  const self = turn.thisTurn;
  // An ended process settles its own turns (`endClaudeRuntime`), including the
  // failure that ended it; settling its tasks must not end them first.
  if (!runtime || !self || runtime.latestTurn !== self || runtime.state === "ended") return;
  if (runtime.waitingTurns.has(self)) {
    // A root loop the CLI resumes on its own later reclaims the foreground
    // through this turn, as it would for a released one.
    turn.turnReleasedToBackgroundTasks = true;
    turn.releasedTurnStartedAt = session.turnStartedAt;
    if (session.queryControl === runtime.control) session.queryControl = undefined;
    runtime.waitingTurns.delete(self);
    turn.resolveTurnEnded();
  } else {
    releaseCompletedTurnToBackgroundTasks(turn, false);
  }
  if (runtime.state === "open") idleClaudeRuntime(runtime);
}

/**
 * A result reached this turn after it lost the foreground without being
 * stopped: it was released to background work and the continuation
 * produced no root assistant record to reclaim it. The CLI behind it may
 * still be running agents, so the consumer keeps draining and task state
 * decides whether input closes. Ending the consumer instead closes the
 * query — the iterator's `return()` is the SDK's `transport.close()` — and
 * kills those agents.
 */
export function settleResultWithoutOwnership(turn: TurnState) {
  // A later notification then waits for its continuation under the bounded
  // watchdog, exactly as for a turn released at its own result.
  turn.turnReleasedToBackgroundTasks = true;
  finishTurnInputIfSettled(turn);
}

/** A structured-output turn that ends without its result still owes the caller a terminal outcome. */
export function recordInterruptedStructuredOutputIfCurrent(turn: TurnState): void {
  const { session, options, structuredRequestId } = turn;
  if (
    !options?.outputSchema ||
    !structuredRequestId ||
    session.structuredOutputRequestId !== structuredRequestId ||
    session.structuredOutput
  ) {
    return;
  }
  recordStructuredOutput(
    session,
    structuredOutputFailure(
      "claude",
      "interrupted",
      "Claude structured-output turn was interrupted.",
      { requestId: structuredRequestId, retryable: true },
    ),
  );
}

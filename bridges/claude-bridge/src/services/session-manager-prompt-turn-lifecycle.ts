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
  closeQueryControlIfUnused,
  forgetRetainedQueryControl,
  forgetSettlingBackgroundTasksOwnedBy,
  retainQueryControl,
} from "./session-manager-background-tasks.js";
import { applySessionPlanMode, recordStructuredOutput, sessions } from "./session-manager-core.js";
import { recordPromptDispatch } from "./session-manager-lifecycle.js";
import { MAX_RESULT_INPUT_UUIDS } from "./session-manager-messages.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import { drainClaudeRuntime } from "./session-manager-runtime.js";
import { inProgressClaudeUsage } from "./session-manager-usage.js";

// Who owns the foreground, the CLI's input and the continuation a background
// task notification owes, for one `sendPrompt` turn. Every function reads the
// turn's state when it runs; none of them keeps a copy.

/**
 * How long a released turn waits in silence for the continuation that a
 * terminal background-task notification is expected to trigger.
 *
 * Any frame from the query disarms this, so it only expires when the provider
 * answered the notification with nothing at all. Generous on purpose: cutting a
 * legitimate continuation short is the corruption this retention exists to
 * avoid, while never expiring would strand the CLI child for the lifetime of
 * the bridge.
 */
export const RETAINED_CONTINUATION_TIMEOUT_MS = 5 * 60 * 1000;

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

/**
 * Closing stdin starts the CLI's exit. `session.queryControl` stays set
 * until this turn's `finally`, so without this marker a read-only control
 * request issued in between races the exit and comes back as
 * "Query closed before response received". Wrapping the close in one place
 * means a future close site cannot forget to mark it.
 *
 * The input belongs to the session's CLI, not to this turn: a superseded
 * turn never closes it, because a newer turn is using it.
 */
export function closeTurnInput(turn: TurnState) {
  const { session } = turn;
  if (
    !turn.runtime ||
    turn.runtime.latestTurn !== turn.thisTurn ||
    session.latestTurnGeneration !== turn.turnGeneration
  )
    return;
  if (turn.queryIteratorControl) session.queryControlDraining = turn.queryIteratorControl;
  drainClaudeRuntime(turn.runtime);
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
    console.warn("[session-manager] Could not record plan mode from a status frame", {
      sessionId,
      errorClass: diagnosticErrorClass(error),
    });
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
      session.backgroundTaskControls?.get(task.id) === turn.queryIteratorControl,
  );
}

export function hasBackgroundTaskCandidateOwnedByThisQuery(turn: TurnState): boolean {
  const { session } = turn;
  return Array.from(session.backgroundTaskCandidates?.values() ?? []).includes(
    turn.queryIteratorControl!,
  );
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
  eventEmitter.emit({
    type: "session.idle",
    sessionId,
    data: {
      success: true,
      backgroundTasksRunning,
      completionBlockedByBackgroundTasks: false,
    },
  });
}

// The retained control is closed only by the paths that legitimately end
// the turn — a continuation result, session teardown, or the watchdog
// below. Everything else must find it, so retention is a tracked reference
// rather than an absent one.
export function stopWaitingForContinuation(turn: TurnState) {
  const { session } = turn;
  if (turn.retainedContinuationTimer) {
    clearTimeout(turn.retainedContinuationTimer);
    turn.retainedContinuationTimer = null;
  }
  if (turn.queryIteratorControl) {
    forgetRetainedQueryControl(session, turn.queryIteratorControl);
  }
  if (turn.dispatchRequestId) {
    session.retainedContinuationRequestIds?.delete(turn.dispatchRequestId);
    if (session.retainedContinuationRequestIds?.size === 0) {
      session.retainedContinuationRequestIds = undefined;
    }
  }
}

// A silence watchdog, not a turn deadline: every frame received while it is
// armed pushes it out again, so a slow continuation is never cut off.
// Without a bound, a provider that answers the notification with nothing
// would hold this query's stdin — and its CLI child — open forever.
export function armContinuationWatchdog(turn: TurnState) {
  const { session, sessionId } = turn;
  if (turn.retainedContinuationTimer) clearTimeout(turn.retainedContinuationTimer);
  turn.retainedContinuationTimer = setTimeout(() => {
    turn.retainedContinuationTimer = null;
    if (session.latestTurnGeneration !== turn.turnGeneration) {
      armContinuationWatchdog(turn);
      return;
    }
    if (hasLiveTaskOwnedByThisQuery(turn) || hasBackgroundTaskCandidateOwnedByThisQuery(turn)) {
      // Another task this query owns is still running, which is its own
      // reason to hold stdin open — closing it here would kill that task.
      // The control is reachable through `backgroundTaskControls` while
      // that is true, so only the bound needs re-arming.
      armContinuationWatchdog(turn);
      return;
    }
    console.warn(
      "[session-manager] No continuation after a background task notification; releasing the retained query",
      { sessionId },
    );
    stopWaitingForContinuation(turn);
    // No edge can arrive on a query that has gone silent this long. The
    // parked snapshots are already absent from the live set, so dropping
    // them only releases metadata that now has nothing to attach to.
    forgetSettlingBackgroundTasksOwnedBy(session, turn.queryIteratorControl);
    closeTurnInput(turn);
    closeQueryControlIfUnused(session, turn.queryIteratorControl);
  }, turn.retainedContinuationTimeoutMs ?? RETAINED_CONTINUATION_TIMEOUT_MS);
}

export function waitForContinuationAfterNotification(turn: TurnState) {
  const { session } = turn;
  if (!turn.queryIteratorControl) return;
  retainQueryControl(session, turn.queryIteratorControl);
  if (turn.dispatchRequestId) {
    (session.retainedContinuationRequestIds ??= new Set()).add(turn.dispatchRequestId);
  }
  armContinuationWatchdog(turn);
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
  // The continuation arrived, so `queryControl` references this handle
  // again and the standalone retention would only outlive its purpose.
  stopWaitingForContinuation(turn);
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
    // notification owes, and nothing has answered it yet. Closing input now
    // lands EOF before the CLI runs it; release instead and wait for it
    // under the same bounded watchdog the replaced turn was using.
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
    // start — written into this same process — retain this query through
    // backgroundTaskControls, and keep its input open until the last task
    // owned by this process settles.
    setCompletionBlockedByBackgroundTasks(turn, false);
    releaseCompletedTurnToBackgroundTasks(turn, hasLiveTask);
    return;
  }
  setCompletionBlockedByBackgroundTasks(turn, false);
  // Nothing is owed to this query any more, so it must stop being retained
  // or `closeQueryControlIfUnused` would keep treating it as referenced.
  stopWaitingForContinuation(turn);
  closeTurnInput(turn);
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

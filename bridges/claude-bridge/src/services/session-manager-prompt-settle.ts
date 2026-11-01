import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import type { PromptOptions } from "../types/index.js";
import { claudePermissionMode, claudeTurnPolicy } from "./claude-query-config.js";
import { eventEmitter } from "./event-emitter.js";
import { debugLog, flushDebugLogs } from "./logger.js";
import { recordStructuredOutput, sessions } from "./session-manager-core.js";
import {
  cleanupPendingInteractions,
  forgetPromptDispatch,
  recordPromptDispatch,
} from "./session-manager-lifecycle.js";
import { ClaudeAttachmentError } from "./session-manager-persistence.js";
import { settlePendingApiRetry } from "./session-manager-prompt-handlers/transcript-notice.js";
import {
  diagnosticErrorClass,
  ownsActiveTurn,
  recordInterruptedStructuredOutputIfCurrent,
} from "./session-manager-prompt-turn-lifecycle.js";
import { reconcileIdleClaudeRuntime } from "./session-manager-runtime-idle.js";
import {
  claudeProcessKilledMessage,
  killedClaudeProcessSignal,
  syncTurnInFlightMark,
} from "./session-manager-turn-interruption.js";
import type { TurnState } from "./session-manager-prompt-turn.js";
import { markTranscriptChanged, resetTranscriptEpoch } from "./transcript-revision.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

// The end of a turn: what follows it, how a failure is reported, and the
// cleanup every turn runs. All synchronous, so nothing runs between the turn
// ending and the follow-up it starts.

/** A bridge-internal re-prompt `sendPrompt` runs once this turn has ended. */
export interface PromptFollowUp {
  readonly prompt: string;
  readonly options: PromptOptions;
  /** Logged with the follow-up's error, which is not this turn's own. */
  readonly failureEvent: "plan.reprompt-feedback-failed" | "plan.reprompt-approved-failed";
}

/**
 * Settle a turn whose runtime stopped waiting on it. Answers the re-prompt to
 * run next, with the foreground already handed back for it, or undefined.
 */
export function settleTurnEnd(turn: TurnState): PromptFollowUp | undefined {
  const { session, sessionId, options, structuredRequestId, abortController, stream, diagnostics } =
    turn;
  diagnostics?.streamSettled("resolved");

  // The stream can end on a delta (abort, SDK hang-up) with a snapshot still
  // pending; publish it so the transcript holds everything that streamed.
  stream.flushStreamedAssistantMessage();
  // A retry still open when the stream ends never got its answer. Whatever
  // the turn's own outcome, the row has to stop claiming to be in flight.
  settlePendingApiRetry(session, sessionId, (event) => eventEmitter.emit(event), stream, {
    state: turn.receivedResult ? "success" : "failure",
  });

  if (abortController.signal.aborted) {
    diagnostics?.terminalSettled("rejected");
    diagnostics?.streamSettled("rejected");
    if (options?.outputSchema && structuredRequestId) {
      recordInterruptedStructuredOutputIfCurrent(turn);
    }
    return undefined;
  }

  // If a plan was rejected with feedback but the SDK ended the turn without
  // Claude revising, re-send the feedback as a follow-up prompt so Claude
  // actually sees it and generates a revised plan.
  // Guard: only re-prompt once (skip if this call is itself a re-prompt).
  if (
    turn.pendingPlanRejectionFeedback &&
    !abortController.signal.aborted &&
    !options?._isReprompt &&
    !turn.superseded
  ) {
    const feedbackPrompt = turn.pendingPlanRejectionFeedback;
    turn.pendingPlanRejectionFeedback = null;

    debugLog("[session-manager] Re-prompting with plan rejection feedback", { sessionId });

    // Reset status to idle temporarily so sendPrompt can be called
    session.status = "idle";
    session.abortController = undefined;

    // Re-prompt with plan mode preserved, attachments stripped, and _isReprompt
    // set to prevent infinite recursion if this re-prompt also gets rejected.
    const repromptOptions: PromptOptions = {
      model: options?.model,
      effort: options?.effort,
      fastMode: options?.fastMode,
      approvalMode: options?.approvalMode,
      readOnly: options?.readOnly,
      parameterValues: options?.parameterValues,
      permissionMode: "plan",
      _isReprompt: true,
    };

    return {
      prompt: feedbackPrompt,
      options: repromptOptions,
      failureEvent: "plan.reprompt-feedback-failed",
    };
  }

  // Defensive fallback continuation: see the comment block on
  // `TurnState.planApprovedThisTurn`. If the SDK failed the ExitPlanMode tool
  // despite an approval (we already overrode the tool state to success in
  // the message loop), re-prompt Claude WITHOUT plan mode so it actually
  // implements the approved plan instead of ending the turn.
  // Guard: skip if this call is itself a re-prompt to avoid recursion.
  if (
    turn.pendingPlanApprovalContinuation &&
    !abortController.signal.aborted &&
    !options?._isReprompt &&
    !turn.superseded
  ) {
    const continuationPrompt = turn.pendingPlanApprovalContinuation;
    turn.pendingPlanApprovalContinuation = null;

    debugLog("[session-manager] Re-prompting after approved-plan ExitPlanMode failure", {
      sessionId,
    });

    session.status = "idle";
    session.abortController = undefined;

    // Drop plan mode for the continuation re-prompt — the user has approved,
    // so Claude needs the full toolset (Write/Edit/Bash) to implement.
    // Attachments are intentionally not forwarded: the SDK has already seen
    // them in the conversation history, and re-sending them on a synthetic
    // system-role continuation could double-count their content. Matches
    // the turn.pendingPlanRejectionFeedback re-prompt path above.
    const repromptOptions: PromptOptions = {
      model: options?.model,
      effort: options?.effort,
      fastMode: options?.fastMode,
      approvalMode: options?.approvalMode,
      readOnly: options?.readOnly,
      parameterValues: options?.parameterValues,
      permissionMode: claudePermissionMode(
        claudeTurnPolicy(session.executionPolicy, options?.readOnly),
        options?.approvalMode,
      ),
      _isReprompt: true,
    };

    return {
      prompt: continuationPrompt,
      options: repromptOptions,
      failureEvent: "plan.reprompt-approved-failed",
    };
  }

  // An abort or immediate restart can take ownership while an awaited control
  // request above is still resolving. The old turn must not publish a second
  // idle edge or clear the new turn's controller.
  if (!ownsActiveTurn(turn)) return undefined;

  session.status = "idle";
  session.turnStartedAt = undefined;
  session.abortController = undefined;
  session.completionBlockedByBackgroundTasks = false;

  eventEmitter.emit({
    type: "session.idle",
    sessionId,
    data: { success: true },
  });

  debugLog("[session-manager] Prompt completed", {
    sessionId,
    sdkMessageCount: turn.sdkMessageCount,
    durationMs: Date.now() - turn.startedAt,
  });
  return undefined;
}

/**
 * Report a turn that failed. Rethrows unless the failure was a stop, which
 * resolves the prompt instead.
 */
export function settleFailedTurn(turn: TurnState, error: unknown): void {
  const {
    session,
    sessionId,
    options,
    structuredRequestId,
    userMessage,
    abortController,
    turnGeneration,
    stream,
    diagnostics,
  } = turn;
  // The turn died mid-stream with deltas still coalescing. Publish them
  // before anything else here: the alternative is that the last window of
  // streamed text is silently dropped from the transcript, and the `finally`
  // below discards the pending timer, so this is the last chance to emit it.
  // Ordered before the failure is recorded so the client sees the completed
  // message first and `session.error` stays terminal.
  stream.flushStreamedAssistantMessage();
  settlePendingApiRetry(session, sessionId, (event) => eventEmitter.emit(event), stream, {
    state: "failure",
  });

  diagnostics?.terminalSettled("rejected");
  diagnostics?.streamSettled("rejected");
  // This turn never reached the SDK, so it hands the foreground back to
  // whichever turn held it — including a released one whose process is
  // still running background work and may yet need to reclaim it.
  if (!turn.queryStarted && session.latestTurnGeneration === turnGeneration) {
    session.latestTurnGeneration = turn.beforeStartup.latestTurnGeneration;
  }
  if (
    !turn.queryStarted &&
    turn.beforeStartup.runtime &&
    !abortController.signal.aborted &&
    !session.deleting
  ) {
    session.status = turn.beforeStartup.status;
    session.turnStartedAt = turn.beforeStartup.turnStartedAt;
    session.abortController = turn.beforeStartup.abortController;
    session.error = turn.beforeStartup.error;
    session.interruption = turn.beforeStartup.interruption;
    session.interruptedRequestId = turn.beforeStartup.interruptedRequestId;
    session.inProgressUsage = turn.beforeStartup.inProgressUsage;
    session.inProgressUsageGeneration = turn.beforeStartup.inProgressUsageGeneration;
    const index = session.messages.indexOf(userMessage);
    if (index >= 0) {
      session.messages.splice(index, 1);
      markTranscriptChanged(session);
    }
    throw error;
  }
  if (abortController.signal.aborted) {
    recordInterruptedStructuredOutputIfCurrent(turn);
    return;
  }
  log.error("prompt.failed", { errorClass: diagnosticErrorClass(error) });

  if (session.abortController === abortController) {
    // A CLI killed under the turn cut it short; the rollout holds it, so a
    // workflow continues it like a turn a bridge restart cut short.
    const killedBy = killedClaudeProcessSignal(error);
    const failure = killedBy
      ? claudeProcessKilledMessage(killedBy)
      : error instanceof Error
        ? error.message
        : String(error);
    if (options?.outputSchema && structuredRequestId && !session.structuredOutput) {
      recordStructuredOutput(
        session,
        structuredOutputFailure("claude", "provider_error", failure, {
          requestId: structuredRequestId,
        }),
      );
    }
    session.status = "error";
    session.turnStartedAt = undefined;
    session.error = failure;
    session.interruption = killedBy ? "restart" : undefined;
    session.interruptedRequestId = killedBy ? turn.dispatchRequestId : undefined;
    session.abortController = undefined;
    session.completionBlockedByBackgroundTasks = false;
    cleanupPendingInteractions(sessionId);

    eventEmitter.emit({
      type: "session.error",
      sessionId,
      data: {
        error: session.error,
        ...(error instanceof ClaudeAttachmentError
          ? { code: (error as { code: string }).code }
          : {}),
      },
    });
  }
  throw error;
}

function advanceBaselineForInterruptedStream(turn: TurnState): void {
  const { session, streamUsage } = turn;

  const baseline = session.claudeUsageBaseline;
  if (!baseline) return;
  const completed = streamUsage.completedTotals();
  session.claudeUsageBaseline = {
    input: baseline.input + completed.inputTokens,
    output: baseline.output + completed.outputTokens,
    cacheRead: baseline.cacheRead + completed.cacheReadTokens,
    cacheWrite: baseline.cacheWrite + completed.cacheWriteTokens,
    // Stream events expose tokens but no price. Leaving cost at the last
    // terminal result makes the next cumulative result reconcile the missing
    // interrupted cost exactly once.
    cost: baseline.cost,
  };
}

/** Cleanup every turn runs, whatever its outcome. */
export function finalizeTurn(turn: TurnState): void {
  const {
    session,
    sessionId,
    dispatchRequestId,
    abortController,
    turnGeneration,
    stream,
    diagnostics,
  } = turn;
  turn.queryEnded = true;
  // A lost transport may never produce a result to consume the stop request.
  // An old turn finishing must leave a newer turn's request intact.
  if (session.interruptRequestedGeneration === turnGeneration) {
    session.interruptRequestedGeneration = undefined;
  }
  diagnostics?.close();
  flushDebugLogs();
  abortController.signal.removeEventListener("abort", turn.observeAbort);
  // The turn has stopped producing frames. From here the `revision` counters
  // it stamped only matter for as long as a disconnected client could still
  // be resuming from them; see `evictIdleHydratedTranscripts`.
  session.lastStreamedRevisionAt = Date.now();
  // Nothing is compacting or thinking once the stream is over. Only the
  // turn that owns the foreground clears it: a released turn ending must
  // not wipe the indicator of the turn that replaced it.
  if (session.latestTurnGeneration === turnGeneration) {
    if (session.activity !== undefined) {
      session.activity = undefined;
      eventEmitter.emit({ type: "session.updated", sessionId, data: { activity: null } });
    }
    if (session.thinkingTokens !== undefined) {
      session.thinkingTokens = undefined;
      eventEmitter.emit({ type: "session.updated", sessionId, data: { thinkingTokens: null } });
    }
  }
  if (session.inProgressUsageGeneration === turnGeneration) {
    // Preserve tokens already observed on interrupted/error paths; the
    // provider may never send the terminal result that would reconcile them.
    if (session.inProgressUsage) {
      advanceBaselineForInterruptedStream(turn);
      session.usage = session.inProgressUsage;
    }
    session.inProgressUsage = undefined;
    session.inProgressUsageGeneration = undefined;
  }
  if (session.finishTurnInputIfSettled === turn.finishTurnInputForThisTurn) {
    session.finishTurnInputIfSettled = undefined;
  }
  if (session.splitAssistantAfterSteer === turn.splitAssistantAfterSteer) {
    session.splitAssistantAfterSteer = undefined;
  }
  // Once the SDK accepted the query, a retry must replay the outcome rather
  // than risk running its side effects twice. Before that startup barrier,
  // failure is unambiguous and the caller must be able to retry.
  if (dispatchRequestId && sessions.get(sessionId) === session) {
    if (turn.queryStarted) {
      recordPromptDispatch(sessionId, dispatchRequestId, "already-processed");
    } else {
      forgetPromptDispatch(sessionId, dispatchRequestId);
    }
  }
  // This prompt is answered: nothing waits on a continuation for it any more.
  turn.awaitingContinuation = false;
  if (dispatchRequestId) {
    session.retainedContinuationRequestIds?.delete(dispatchRequestId);
    if (session.retainedContinuationRequestIds?.size === 0) {
      session.retainedContinuationRequestIds = undefined;
    }
  }
  // What the process owned is settled by the runtime when it ends
  // (`endClaudeRuntime`), not here: a turn that is superseded, released to
  // background work or simply over finishes while its process keeps going.
  // The pre-turn transcript read failed, so `persistedMessagesLoaded` claims
  // a hydration that never happened. Clearing it once the turn is over lets
  // the next transcript request retry; leaving it set hid the on-disk history
  // until the bridge restarted.
  if (turn.transcriptHydrationFailed && sessions.get(sessionId) === session && !session.deleting) {
    session.persistedMessagesLoaded = false;
    resetTranscriptEpoch(session);
  }
  // Both successful settlement and failed join rollback can restore idle
  // ownership after another session filled the warm cap. Enforce only once
  // the foreground is actually free, including when turns settle together.
  reconcileIdleClaudeRuntime(session);
  stream.clearFlushTimer();
  if (sessions.get(sessionId) === session) syncTurnInFlightMark(session);
}

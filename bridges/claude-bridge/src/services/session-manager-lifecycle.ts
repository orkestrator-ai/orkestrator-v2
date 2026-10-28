// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import type {
  SessionState,
  NormalizedMessage,
  QuestionRequest,
  PlanApprovalRequest,
  ClaudeInteractionRequest,
} from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import {
  isPreferenceLockTimeout,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
} from "./session-preferences.js";

import * as core from "./session-manager-core.js";
import {
  claimedPromptDispatches,
  interactionResolvers,
  pendingInteractions,
  pendingPlanApprovals,
  pendingPromptDispatchClaims,
  pendingQuestions,
  persistedSessionExistsOnDisk,
  planApprovalResolvers,
  questionResolvers,
  sdkSessionIdFromBridgeId,
  sessionOperationError,
  sessions,
  touchSession,
} from "./session-manager-core.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  claudeRuntimeOwnsLiveWork,
  releaseQueryControl,
} from "./session-manager-background-tasks.js";
import { appendInterruptedNotice } from "./session-manager-messages.js";
import { syncTurnInFlightMark } from "./session-manager-turn-interruption.js";
type SessionActivity = core.SessionActivity;
type PromptDispatchHandle = core.PromptDispatchHandle;
/**
 * Read-only activity state for the backend's per-session sweep.
 *
 * Deliberately side-effect free. The backend polls this every two seconds for
 * *every* session it has persisted, so any liveness side effect here is
 * permanent, not transient:
 *
 * - It must not {@link touchSession}. `lastAccessedAt` is the clock
 *   {@link evictIdleHydratedTranscripts} reads, and a touch every two seconds
 *   keeps `now - lastAccessedAt` below {@link IDLE_TRANSCRIPT_EVICTION_MS}
 *   forever, putting eviction permanently out of reach.
 * - It must not hydrate. Materializing a transcript to answer a poll pulls
 *   every persisted session's full history into memory — and, with the clock
 *   pinned by the same poll, leaves it there for the life of the process.
 *
 * Hence the direct `sessions` lookup rather than {@link getSession}, and no
 * call to `ensurePersistedSession` / `hydratePersistedSessionMessages`.
 *
 * Not resident is not `missing`. A session is absent from the map after a
 * bridge restart until something materializes it, and this function
 * deliberately is not that something. Since the backend deletes its session
 * mapping when it sees `missing`, answering from residency alone would cut the
 * user's link to a conversation that is sitting intact on disk. Only a
 * malformed id or a rollout that is provably gone is `missing`; a well-formed,
 * on-disk, non-resident id is `idle`, because nothing can be running for a
 * session this process is not holding.
 *
 * Async only for that on-disk probe, which the resident fast path skips
 * entirely.
 */
export async function getSessionActivity(sessionId: string): Promise<SessionActivity> {
  const session = sessions.get(sessionId);
  if (session) {
    // A parked question, approval or MCP elicitation blocks on the user,
    // including after the root turn releases to background work or idle auth. The backend renders
    // those differently and must not treat them as progress it should wait out.
    //
    // This outranks the background-task sweep below. A backgrounded Bash
    // command started earlier in the same turn stays live while that turn asks
    // for permission, so checking tasks first would report the ordinary case
    // as progress: the sidebar would pulse blue instead of amber, and the
    // durable attention edge that hangs off `waiting` would never fire for a
    // question nobody is looking at.
    if (sessionHasPendingInteractions(sessionId)) return "waiting";
    // A parent turn can finish and release the composer while tasks it launched
    // keep running in the same session. Those tasks are still environment work:
    // retiring the sidebar indicator here paints the environment green even
    // though its task cards are visibly active. Pending and paused tasks are
    // unfinished too, so they keep the working indicator just like running
    // tasks do.
    //
    // `readyForInput` on the activity route is what stops this from also
    // meaning "busy": consumers that gate on a free composer read that flag
    // rather than this state.
    const hasUnfinishedBackgroundTask = Object.values(session.backgroundTasks ?? {}).some((task) =>
      LIVE_BACKGROUND_TASK_STATUSES.has(task.status),
    );
    if (hasUnfinishedBackgroundTask || sessionCompletionPending(session)) return "working";
    return session.status === "running" ? "working" : "idle";
  }

  const sdkSessionId = sdkSessionIdFromBridgeId(sessionId);
  // No rollout id can be derived, so no rollout can exist. This is the one
  // cheap, certain `missing`.
  if (!sdkSessionId) return "missing";
  return (await persistedSessionExistsOnDisk(sdkSessionId)) ? "idle" : "missing";
}

/**
 * A released composer can still owe a root response. Agent tasks (and unknown
 * task kinds from older CLIs) owe that response; a detached local shell does
 * not hold completion attention until its potentially unbounded exit. Once a
 * notification arrives, even a shell can owe a continuation until its result
 * or the runtime's bounded silence window settles it.
 */
export function sessionCompletionPending(session: SessionState): boolean {
  const runtime = session.claudeRuntime;
  return (
    (runtime?.state === "open" && runtime.latestTurn.isAwaitingContinuation()) ||
    Object.values(session.backgroundTasks ?? {}).some(
      (task) => LIVE_BACKGROUND_TASK_STATUSES.has(task.status) && task.taskType !== "local_bash",
    )
  );
}

/**
 * At-most-once prompt dispatch.
 *
 * A turn can run shell commands and edit files, so executing one twice is
 * destructive — and the window is real: the browser can lose the HTTP response
 * to `POST /session/:id/prompt` (suspended tab, reset socket, reloaded window)
 * and retry a request the bridge already accepted.
 *
 * Every prompt carrying a client-supplied `requestId` gets a record here, and a
 * second request for the same id never starts a second turn; it replays the
 * first one's outcome instead. This generalizes the structured-output-only
 * guard that used to live solely on `session.structuredOutputRequestId` —
 * structured turns still set that field because it also addresses the *result*,
 * but dedup for every prompt now flows through this registry.
 *
 * Durability: these records are in memory and lost on a bridge restart. The
 * claim itself is durable: `claimPromptDispatch` writes the id to the session's
 * `dispatchedRequestIds` before the turn starts, so a restart can never run it
 * a second time. Whether that turn ran is lost with the process, though: a
 * restart can land before the CLI starts or partway through the turn. The
 * prompt route therefore refuses a restored claim without an outcome record
 * (`restoredDispatchedRequestIds`) with `DISPATCH_OUTCOME_LOST_KIND`, rather
 * than reporting it processed, and the caller resends under a new id.
 */
export type PromptDispatchState = "processing" | "already-processed";

export interface PromptDispatchRecord {
  sessionId: string;
  state: PromptDispatchState;
  updatedAt: number;
}

/**
 * A settled tombstone remains authoritative for the entire retry window.
 *
 * This is time-bounded instead of count-bounded: evicting a still-live
 * tombstone merely because the process handled 500 later prompts lets the
 * original destructive request run twice. Request ids are capped at the HTTP
 * boundary, and expired records are collected on every state transition.
 */
export const PROMPT_DISPATCH_RETENTION_MS = 24 * 60 * 60 * 1000;

export const promptDispatchRecords = new Map<string, PromptDispatchRecord>();

export function promptDispatchKey(sessionId: string, requestId: string): string {
  // requestId is caller-controlled and may legitimately be reused in a
  // different session. Scope it here so one session can never overwrite
  // another session's in-flight at-most-once claim.
  return `${sessionId}\u0000${requestId}`;
}

export function collectPromptDispatchGarbage(): void {
  const cutoff = Date.now() - PROMPT_DISPATCH_RETENTION_MS;
  for (const [requestId, record] of promptDispatchRecords) {
    if (record.updatedAt < cutoff) {
      promptDispatchRecords.delete(requestId);
    }
  }
}

export function recordPromptDispatch(
  sessionId: string,
  requestId: string,
  state: PromptDispatchState,
): void {
  promptDispatchRecords.set(promptDispatchKey(sessionId, requestId), {
    sessionId,
    state,
    updatedAt: Date.now(),
  });
  collectPromptDispatchGarbage();
}

export function getPromptDispatchRecord(
  sessionId: string,
  requestId: string,
): PromptDispatchRecord | undefined {
  return promptDispatchRecords.get(promptDispatchKey(sessionId, requestId));
}

export function forgetPromptDispatch(sessionId: string, requestId: string): void {
  promptDispatchRecords.delete(promptDispatchKey(sessionId, requestId));
}

export function forgetPromptDispatchesForSession(sessionId: string): void {
  for (const [requestId, record] of promptDispatchRecords) {
    if (record.sessionId === sessionId) promptDispatchRecords.delete(requestId);
  }
}

/** Test-only visibility for retention and lifecycle cleanup assertions. */
export function getPromptDispatchRecordCountForTesting(): number {
  return promptDispatchRecords.size;
}

/** Test-only seeding for retention-volume regression coverage. */
export function seedSettledPromptDispatchForTesting(
  sessionId: string,
  requestId: string,
  updatedAt = Date.now(),
): void {
  promptDispatchRecords.set(promptDispatchKey(sessionId, requestId), {
    sessionId,
    state: "already-processed",
    updatedAt,
  });
  collectPromptDispatchGarbage();
}

/**
 * Classify an incoming prompt request id, for both structured and plain turns.
 *
 * `not-found` is reserved for an unknown session; `new` means "never seen, go
 * dispatch".
 */
export function getPromptDispatchState(
  sessionId: string,
  requestId: string,
): "new" | "processing" | "already-processed" | "not-found" {
  const session = sessions.get(sessionId);
  if (!session) return "not-found";

  const record = getPromptDispatchRecord(sessionId, requestId);
  if (record) return record.state;

  // A structured turn also carries its request id on the session itself, which
  // covers the paths that never ran through `sendPrompt` in this process (a
  // session adopted from disk mid-turn, a bridge-internal dispatch). Keep
  // honouring it so structured dedup does not regress.
  if (session.structuredOutputRequestId === requestId) {
    if (session.structuredOutput) return "already-processed";
    if (session.status === "running") return "processing";
  }
  return "new";
}

/** The transcript id of the user row an idle `/steer` reply records for a request. */
export function idleSteerUserMessageId(requestId: string): string {
  return `idle-steer:${requestId}`;
}

/**
 * Would `POST /:id/prompt` refuse this id as `DISPATCH_OUTCOME_LOST_KIND`?
 *
 * For a resident session whose dispatch state is `new`: the id was restored
 * from disk without an outcome. The route's other exception, an idle `/steer`
 * answered locally, is recognised by the reply row it kept, because a read has
 * no prompt text to test; that case is not lost (the route answers it
 * processed). A pure read of the session record: no touch, no hydration.
 */
export function restoredDispatchClaimLost(
  session: Pick<SessionState, "restoredDispatchedRequestIds" | "localTranscript"> | undefined,
  requestId: string,
): boolean {
  if (!session?.restoredDispatchedRequestIds?.has(requestId)) return false;
  const localReplyId = idleSteerUserMessageId(requestId);
  return !session.localTranscript?.some((message) => message.id === localReplyId);
}

/**
 * Can this resident session prove `requestId` never reached Claude?
 *
 * Only while its journal is complete (`dispatchJournalComplete`): every id it
 * ever claimed, in any process, is still journaled, and each claim was written
 * to disk before its turn could start. Then an id missing from the journal, the
 * restored ids, the structured-output slot and the idle `/steer` replies was
 * never handed over, and a claim racing this read adds the id to the journal
 * synchronously, so a resend under it is a duplicate. A pure read of the
 * session record: no touch, no hydration.
 */
export function dispatchJournalProvesAbsent(
  session:
    | Pick<
        SessionState,
        | "dispatchJournalComplete"
        | "dispatchJournalUnavailable"
        | "deleting"
        | "dispatchedRequestIds"
        | "restoredDispatchedRequestIds"
        | "structuredOutputRequestId"
        | "localTranscript"
      >
    | undefined,
  requestId: string,
): boolean {
  if (
    !session ||
    session.dispatchJournalComplete !== true ||
    session.dispatchJournalUnavailable === true ||
    session.deleting === true ||
    session.dispatchedRequestIds?.has(requestId) ||
    session.restoredDispatchedRequestIds?.has(requestId) ||
    session.structuredOutputRequestId === requestId
  ) {
    return false;
  }
  const localReplyId = idleSteerUserMessageId(requestId);
  return !session.localTranscript?.some((message) => message.id === localReplyId);
}

/**
 * {@link restoredDispatchClaimLost} and {@link dispatchJournalProvesAbsent}
 * for a session this process has not registered yet (after a restart nothing
 * materializes it until a tab reads it), answered from its durable preferences
 * file. Materializing it would restore exactly this journal as
 * `restoredDispatchedRequestIds`, with no outcome records, so the prompt route
 * would refuse a journaled id the same way and take a missing one as new.
 * Reads the file only: the session is not registered, touched or hydrated.
 * An unreadable file, a missing one, or a resident session answers `unknown`.
 */
export async function persistedDispatchStatus(
  sessionId: string,
  requestId: string,
): Promise<"lost" | "absent" | "unknown"> {
  if (sessions.has(sessionId)) return "unknown";
  const sdkSessionId = sdkSessionIdFromBridgeId(sessionId);
  if (!sdkSessionId) return "unknown";
  let preferences: Awaited<ReturnType<typeof readSessionPreferences>>;
  try {
    preferences = await readSessionPreferences(sdkSessionId);
  } catch {
    return "unknown";
  }
  if (!preferences || sessionPreferencesUnavailable(preferences)) return "unknown";
  const localReplyId = idleSteerUserMessageId(requestId);
  const localReply = preferences.localTranscript?.some((entry) => entry.id === localReplyId);
  if (preferences.dispatchedRequestIds?.includes(requestId)) {
    return localReply ? "unknown" : "lost";
  }
  return preferences.dispatchJournalComplete === true && !localReply ? "absent" : "unknown";
}

/**
 * Atomically reserve an idempotent prompt request id before dispatch.
 *
 * The in-memory Set makes concurrent retries atomic without awaiting. The
 * durable write is completed before the route returns 202, so a renderer or
 * bridge restart cannot turn an accepted one-shot launch prompt into a second
 * agent turn. A failed write rolls the claim back and rejects the request.
 */
export async function claimPromptDispatch(
  sessionId: string,
  requestId: string,
  startDispatch: () => PromptDispatchHandle,
  testHooks?: {
    beforePersistence?: () => void | Promise<void>;
  },
): Promise<"claimed" | "duplicate" | "not-found"> {
  const session = sessions.get(sessionId);
  if (!session) return "not-found";
  if (session.dispatchJournalUnavailable) {
    throw sessionOperationError(
      "conflict",
      "The durable prompt journal is unavailable; refusing to risk replaying this prompt",
    );
  }

  const dispatchedRequestIds = session.dispatchedRequestIds ?? new Set<string>();
  if (dispatchedRequestIds.has(requestId)) {
    const pending = pendingPromptDispatchClaims.get(sessionId);
    if (pending?.requestId === requestId) {
      await pending.outcome;
    }
    return "duplicate";
  }
  if (session.deleting) {
    throw sessionOperationError("conflict", "Session is being deleted");
  }
  if (session.status === "running") {
    throw sessionOperationError("conflict", "Session is already processing a prompt");
  }
  if (session.rewindInProgress) {
    throw sessionOperationError("conflict", "Session is restoring files from a checkpoint");
  }

  dispatchedRequestIds.add(requestId);
  session.dispatchedRequestIds = dispatchedRequestIds;

  // Past the bound the oldest id is forgotten, and with it the proof that any
  // id missing from the journal was never sent.
  if (dispatchedRequestIds.size > MAX_DISPATCHED_REQUEST_IDS) {
    session.dispatchJournalComplete = false;
  }
  const recentRequestIds = [...dispatchedRequestIds].slice(-MAX_DISPATCHED_REQUEST_IDS);
  const retainedRequestIds = new Set(recentRequestIds);
  session.dispatchedRequestIds = retainedRequestIds;
  const journalUpdate = (ids: string[]) => ({
    dispatchedRequestIds: ids,
    dispatchJournalComplete: session.dispatchJournalComplete === true ? (true as const) : undefined,
  });

  const sdkSessionId = session.sdkSessionId ?? sdkSessionIdFromBridgeId(session.id);
  if (!sdkSessionId) {
    session.dispatchedRequestIds.delete(requestId);
    throw sessionOperationError("invalid", "Session does not have a durable request-id key");
  }

  // Reserve the turn synchronously before the journal write yields. Without
  // this, another request can start while persistence is in flight, leaving a
  // request id accepted on disk for a turn that sendPrompt later refuses.
  const previousStatus = session.status;
  const previousTurnStartedAt = session.turnStartedAt;
  session.status = "running";
  session.turnStartedAt ??= new Date().toISOString();
  claimedPromptDispatches.set(sessionId, requestId);

  const outcome = (async () => {
    await testHooks?.beforePersistence?.();
    try {
      await updateSessionPreferences(sdkSessionId, journalUpdate(recentRequestIds));
    } catch (error) {
      // The lock stayed held by a live owner and nothing reached the journal or
      // the CLI, so this is a definite refusal the backend may retry, not the
      // ambiguous 500 a failure after dispatch would be. Only the claim write
      // maps this way.
      if (isPreferenceLockTimeout(error)) {
        throw sessionOperationError(
          "unavailable",
          "The session's preferences are busy, so the prompt was not sent. Try again.",
        );
      }
      throw error;
    }

    if (
      sessions.get(sessionId) !== session ||
      session.deleting ||
      claimedPromptDispatches.get(sessionId) !== requestId
    ) {
      claimedPromptDispatches.delete(sessionId);
      retainedRequestIds.delete(requestId);
      await updateSessionPreferences(
        sdkSessionId,
        journalUpdate([...retainedRequestIds].slice(-MAX_DISPATCHED_REQUEST_IDS)),
      );
      throw sessionOperationError(
        "conflict",
        "Session became unavailable before the prompt could start",
      );
    }

    try {
      const dispatch = startDispatch();
      // Invoking an async function is not yet an accepted turn: attachment
      // and config preparation can still fail before the SDK sees anything.
      // Wait only for that unambiguous handoff, never for the provider turn.
      await dispatch.started;
    } catch (error) {
      claimedPromptDispatches.delete(sessionId);
      if (!session.deleting) {
        session.status = previousStatus;
        session.turnStartedAt = previousTurnStartedAt;
      }
      retainedRequestIds.delete(requestId);
      try {
        await updateSessionPreferences(
          sdkSessionId,
          journalUpdate([...retainedRequestIds].slice(-MAX_DISPATCHED_REQUEST_IDS)),
        );
      } catch (rollbackError) {
        console.error(
          "[session-manager] Failed to roll back prompt dispatch claim:",
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        );
      }
      throw error;
    }
  })();
  pendingPromptDispatchClaims.set(sessionId, { requestId, outcome });

  try {
    await outcome;
  } catch (error) {
    claimedPromptDispatches.delete(sessionId);
    if (!session.deleting) {
      session.status = previousStatus;
      session.turnStartedAt = previousTurnStartedAt;
    }
    retainedRequestIds.delete(requestId);
    throw error;
  } finally {
    if (pendingPromptDispatchClaims.get(sessionId)?.outcome === outcome) {
      pendingPromptDispatchClaims.delete(sessionId);
    }
  }

  return "claimed";
}

export async function waitForPendingPromptDispatchClaim(sessionId: string): Promise<void> {
  const pending = pendingPromptDispatchClaims.get(sessionId);
  if (!pending) return;
  try {
    await pending.outcome;
  } catch {
    // Deletion owns the terminal state. The claim path reports its own failure;
    // deletion waits only to order rollback before preference removal.
  }
}

/**
 * List all sessions
 */
export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

/**
 * Clean up pending plan approvals for a session
 * Rejects any waiting promises so they don't hang
 */
export function cleanupPendingPlanApprovals(sessionId: string): void {
  for (const [approvalId, approval] of Array.from(pendingPlanApprovals)) {
    if (approval.sessionId === sessionId) {
      const resolver = planApprovalResolvers.get(approvalId);
      if (resolver) {
        resolver.reject(new Error("Session terminated"));
        planApprovalResolvers.delete(approvalId);
      }
      pendingPlanApprovals.delete(approvalId);
      eventEmitter.emit({
        type: "plan.approval-responded",
        sessionId,
        data: { requestId: approvalId, approved: false, cancelled: true },
      });
    }
  }
}

/**
 * Clean up pending questions for a session.
 * Rejects any waiting promises so SDK callbacks cannot remain suspended.
 */
export function cleanupPendingQuestions(sessionId: string): void {
  for (const [questionId, question] of Array.from(pendingQuestions)) {
    if (question.sessionId === sessionId) {
      const resolver = questionResolvers.get(questionId);
      if (resolver) {
        resolver.reject(new Error("Session terminated"));
        questionResolvers.delete(questionId);
      }
      pendingQuestions.delete(questionId);
      eventEmitter.emit({
        type: "question.answered",
        sessionId,
        data: { requestId: questionId, cancelled: true },
      });
    }
  }
}

/**
 * Withdraw the session's parked MCP elicitations and tool approvals. Each
 * waiting callback then answers the CLI itself: an elicitation is cancelled,
 * a tool call denied.
 */
export function cleanupParkedInteractions(sessionId: string): void {
  for (const [interactionId, interaction] of Array.from(pendingInteractions)) {
    if (interaction.sessionId !== sessionId) continue;
    const resolve = interactionResolvers.get(interactionId);
    pendingInteractions.delete(interactionId);
    interactionResolvers.delete(interactionId);
    resolve?.({ action: "withdrawn" });
  }
}

export function cleanupPendingInteractions(sessionId: string): void {
  cleanupPendingQuestions(sessionId);
  cleanupPendingPlanApprovals(sessionId);
  cleanupParkedInteractions(sessionId);
}

/**
 * The single rule mapping a parked prompt to the session that raised it.
 *
 * `getPendingQuestions`, `getPendingPlanApprovals`, `getPendingInteractions`,
 * the eviction guard and {@link getSessionActivity} all ask some form of "is
 * anything of this session's waiting on the user". Routing every one of them
 * through this predicate is what stops the `waiting` activity state from
 * disagreeing with the cards `/questions`, `/plan-approvals` and
 * `/interactions` actually serve.
 */
export function isPendingInteractionFor(
  entry: QuestionRequest | PlanApprovalRequest | ClaudeInteractionRequest,
  sessionId: string,
): boolean {
  return entry.sessionId === sessionId;
}

/** True while a question, approval or elicitation is waiting on the user. */
export function sessionHasPendingInteractions(sessionId: string): boolean {
  for (const question of pendingQuestions.values()) {
    if (isPendingInteractionFor(question, sessionId)) return true;
  }
  for (const approval of pendingPlanApprovals.values()) {
    if (isPendingInteractionFor(approval, sessionId)) return true;
  }
  for (const interaction of pendingInteractions.values()) {
    if (isPendingInteractionFor(interaction, sessionId)) return true;
  }
  return false;
}

/**
 * Delete a session
 */
export function deleteSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (session) {
    claimedPromptDispatches.delete(sessionId);
    // Abort any running query
    if (session.abortController) {
      session.abortController.abort();
    }
    // The control handle outlives the turn while background tasks are alive
    // (see `stopBackgroundTask`); deleting the session is the point at which
    // the user has said that work should stop.
    releaseQueryControl(session);
    cleanupPendingInteractions(sessionId);
    forgetPromptDispatchesForSession(sessionId);
    sessions.delete(sessionId);
    return true;
  }
  return false;
}

/**
 * Get messages for a session
 */
export function getSessionMessages(sessionId: string): NormalizedMessage[] {
  const session = sessions.get(sessionId);
  if (session) touchSession(session);
  return session?.messages || [];
}

/**
 * Abort a running session
 */
export function abortSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  // A CLI kept warm between turns, owing nothing, is not running: stopping it
  // would only cost the next prompt a cold start and write a stray
  // interruption into the transcript.
  const runtime = session?.claudeRuntime;
  const runtimeOwesWork =
    runtime !== undefined &&
    runtime.state !== "ended" &&
    (claudeRuntimeOwnsLiveWork(runtime) || runtime.latestTurn.isAwaitingContinuation());
  if (session && (session.abortController || runtimeOwesWork)) {
    session.abortController?.abort();
    // Bank completed model calls synchronously. A replacement prompt may claim
    // the session before the aborted iterator reaches its finally block; if we
    // waited for that block, the new turn would clear this lower bound first.
    if (session.inProgressUsage) session.usage = session.inProgressUsage;
    session.inProgressUsage = undefined;
    session.inProgressUsageGeneration = undefined;
    session.status = "idle";
    session.turnStartedAt = undefined;
    session.abortController = undefined;
    session.completionBlockedByBackgroundTasks = false;
    // Provider-reported progress belongs to the turn just stopped; the aborted
    // iterator may never reach the frame that would have cleared it.
    session.activity = undefined;
    session.thinkingTokens = undefined;
    releaseQueryControl(session);
    syncTurnInFlightMark(session, { stopped: true });

    cleanupPendingInteractions(sessionId);
    // The stop is part of the conversation: without a row the transcript just
    // ends mid-answer, and a reload (which reads the CLI's own interruption
    // marker) would show one that the live tab never did.
    appendInterruptedNotice(session, sessionId);

    eventEmitter.emit({
      type: "session.idle",
      sessionId,
      data: {
        aborted: true,
        completionBlockedByBackgroundTasks: false,
      },
    });

    return true;
  }
  return false;
}

/**
 * Tool tracker for managing tool invocations across a conversation turn.
 * Tools are tracked by their ID and their results are merged in when received.
 * Also tracks parent Task relationships for proper tool grouping.
 */

// Session Manager Service
// Handles session state and interacts with Claude Agent SDK

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageBlockParam, TextBlockParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ModelInfo,
  SessionState,
  NormalizedMessage,
  NormalizedPart,
  ToolDiffMetadata,
  QuestionInfo,
  QuestionRequest,
  PlanApprovalRequest,
  PromptOptions,
  SessionInitData,
  McpServerRuntimeStatus,
  PluginRuntimeStatus,
  SdkMessageBase,
  SdkCompactBoundaryMessage,
  SdkResultMessage,
  SdkSystemMessage,
  TaskListSnapshot,
  MessagePatchEventData,
  SessionUsageSnapshot,
  BackgroundTaskSnapshot,
  SessionRateLimitWindow,
  StopBackgroundTaskResult,
} from "../types/index.js";
import { isSdkCompactBoundaryMessage, isSdkResultMessage } from "../types/index.js";
import { TaskRegistry, isTaskListTool } from "@orkestrator/protocol/task-list";
import { AGENT_INTERACTION_DEFAULT_TIMEOUT_MS } from "@orkestrator/protocol/agent-interactions";
import {
  isRootAssistantRecord,
  normalizeBackendModelId,
} from "@orkestrator/protocol/model-id";
import {
  structuredOutputFailure,
  type StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import {
  deleteSessionPreferences,
  MAX_DISPATCHED_REQUEST_IDS,
  readSessionPreferences,
  sessionPreferencesUnavailable,
  updateSessionPreferences,
  type SessionPreferences,
} from "./session-preferences.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { debugLog, isDebugLoggingEnabled } from "./logger.js";
import { applyDiffBudget, applyToolResultBudget } from "./part-budget.js";
import { getMcpRuntimeConfig } from "./mcp-config.js";
import { getPluginsForSdk } from "./plugin-config.js";
import type { McpToolMetadata } from "../types/mcp.js";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync, type Stats } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import * as core from "./session-manager-core.js";
import * as background from "./session-manager-background-tasks.js";
const { sessions, turnGenerationCounter, claimedPromptDispatches, pendingPromptDispatchClaims, IDLE_TRANSCRIPT_EVICTION_MS, IDLE_TRANSCRIPT_SWEEP_INTERVAL_MS, STRUCTURED_USAGE_REQUEST_TIMEOUT_MS, StructuredUsageRequestTimeoutError, touchSession, claudeExecutableOptions, pendingQuestions, questionResolvers, pendingPlanApprovals, planApprovalResolvers, QUESTION_TIMEOUT_MS, PLAN_APPROVAL_TIMEOUT_MS, SessionOperationError, sessionOperationError, TRANSCRIPT_UUID_PATTERN, ClaudeStructuredOutputError, recordStructuredOutput, generateSessionId, CLIENT_SESSION_ID_PATTERN, sessionIdForClientKey, sdkSessionIdFromBridgeId, bridgeSessionIdFromSdkId, persistedBridgeSessionId, generateMessageId, parseTokenValue, MAX_DATE_MS, EPOCH_MILLISECONDS_THRESHOLD, rateLimitResetToIso, extractContextUsageFromUnknown, STRUCTURED_RATE_LIMIT_WINDOWS, structuredRateLimitReset, structuredRateLimitWindow, rateLimitsFromStructuredUsage, getStructuredUsageWithTimeout, refreshStructuredRateLimits, createStructuredUsageRefreshCoordinator, buildClaudeUsageSnapshot, TITLE_MAX_SOURCE_PROMPT_LENGTH, TITLE_MAX_LENGTH, TITLE_MAX_OUTPUT_BYTES, TITLE_MAX_STDERR_LENGTH, TITLE_COMMAND_TIMEOUT_MS, TITLE_TERMINATION_GRACE_MS, SESSION_TITLE_SYSTEM_PROMPT, execFileText, findClaudeCliExecutable, sanitizeSessionTitle, buildSessionTitlePrompt, runClaudeTitleCommand, generateTitleViaCli, generateAndSetSessionTitle, createSession, persistSessionMetadata, ensureClientSessionAlias, applySessionPlanMode, setSessionPreferences, clearPromptSuggestion, getSession, PERSISTED_EXISTENCE_MEMO_MS, PERSISTED_EXISTENCE_MEMO_MAX, persistedSessionExistence, persistedSessionExistsOnDisk, resetSessionActivityProbeCacheForTesting, claudeSdk, currentWorkingDirectory, persistSessionTitle, LIVE_BACKGROUND_TASK_STATUSES, registerBackgroundTaskCandidate, takeBackgroundTaskCandidate, removeBackgroundTaskCandidatesOwnedBy, takeProvisionalBackgroundTask, recordBackgroundTaskLaunch, MAX_TERMINAL_BACKGROUND_TASKS, boundBackgroundTaskHistory, MAX_SETTLING_BACKGROUND_TASKS, parkSettlingBackgroundTask, takeSettlingBackgroundTask, forgetSettlingBackgroundTasksOwnedBy, NO_CONTROL_CHANNEL, settleBackgroundTask, settleTasksOwnedByClosedControl, stopBackgroundTask, emitBackgroundTaskSnapshot, releaseQueryControl, closeQueryControl, releaseQueryControls, retainQueryControl, forgetRetainedQueryControl, closeQueryControlIfUnused } = Object.assign({}, core, background);
void [sessions, turnGenerationCounter, claimedPromptDispatches, pendingPromptDispatchClaims, IDLE_TRANSCRIPT_EVICTION_MS, IDLE_TRANSCRIPT_SWEEP_INTERVAL_MS, STRUCTURED_USAGE_REQUEST_TIMEOUT_MS, StructuredUsageRequestTimeoutError, touchSession, claudeExecutableOptions, pendingQuestions, questionResolvers, pendingPlanApprovals, planApprovalResolvers, QUESTION_TIMEOUT_MS, PLAN_APPROVAL_TIMEOUT_MS, SessionOperationError, sessionOperationError, TRANSCRIPT_UUID_PATTERN, ClaudeStructuredOutputError, recordStructuredOutput, generateSessionId, CLIENT_SESSION_ID_PATTERN, sessionIdForClientKey, sdkSessionIdFromBridgeId, bridgeSessionIdFromSdkId, persistedBridgeSessionId, generateMessageId, parseTokenValue, MAX_DATE_MS, EPOCH_MILLISECONDS_THRESHOLD, rateLimitResetToIso, extractContextUsageFromUnknown, STRUCTURED_RATE_LIMIT_WINDOWS, structuredRateLimitReset, structuredRateLimitWindow, rateLimitsFromStructuredUsage, getStructuredUsageWithTimeout, refreshStructuredRateLimits, createStructuredUsageRefreshCoordinator, buildClaudeUsageSnapshot, TITLE_MAX_SOURCE_PROMPT_LENGTH, TITLE_MAX_LENGTH, TITLE_MAX_OUTPUT_BYTES, TITLE_MAX_STDERR_LENGTH, TITLE_COMMAND_TIMEOUT_MS, TITLE_TERMINATION_GRACE_MS, SESSION_TITLE_SYSTEM_PROMPT, execFileText, findClaudeCliExecutable, sanitizeSessionTitle, buildSessionTitlePrompt, runClaudeTitleCommand, generateTitleViaCli, generateAndSetSessionTitle, createSession, persistSessionMetadata, ensureClientSessionAlias, applySessionPlanMode, setSessionPreferences, clearPromptSuggestion, getSession, PERSISTED_EXISTENCE_MEMO_MS, PERSISTED_EXISTENCE_MEMO_MAX, persistedSessionExistence, persistedSessionExistsOnDisk, resetSessionActivityProbeCacheForTesting, claudeSdk, currentWorkingDirectory, persistSessionTitle, LIVE_BACKGROUND_TASK_STATUSES, registerBackgroundTaskCandidate, takeBackgroundTaskCandidate, removeBackgroundTaskCandidatesOwnedBy, takeProvisionalBackgroundTask, recordBackgroundTaskLaunch, MAX_TERMINAL_BACKGROUND_TASKS, boundBackgroundTaskHistory, MAX_SETTLING_BACKGROUND_TASKS, parkSettlingBackgroundTask, takeSettlingBackgroundTask, forgetSettlingBackgroundTasksOwnedBy, NO_CONTROL_CHANNEL, settleBackgroundTask, settleTasksOwnedByClosedControl, stopBackgroundTask, emitBackgroundTaskSnapshot, releaseQueryControl, closeQueryControl, releaseQueryControls, retainQueryControl, forgetRetainedQueryControl, closeQueryControlIfUnused];
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
    if (session.status !== "running") return "idle";
    // A running turn that has parked a question or a plan approval is blocked
    // on the user, not on Claude. The backend renders those differently and
    // must not treat them as progress it should wait out.
    return sessionHasPendingInteractions(sessionId) ? "waiting" : "working";
  }

  const sdkSessionId = sdkSessionIdFromBridgeId(sessionId);
  // No rollout id can be derived, so no rollout can exist. This is the one
  // cheap, certain `missing`.
  if (!sdkSessionId) return "missing";
  return (await persistedSessionExistsOnDisk(sdkSessionId)) ? "idle" : "missing";
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
 * Durability: in memory, matching the session state it guards, so it is lost on
 * a bridge restart. For Claude that is the correct tradeoff rather than a gap.
 * The SDK spawns a per-turn child owned by this process, so a restart kills any
 * in-flight turn outright: a prompt retried across a restart provably did not
 * finish and *should* run again. (The Codex bridge persists its journal to disk
 * because `codex app-server` turns outlive the bridge connection, leaving
 * genuine ambiguity after a restart — see `sessions/dispatch-journal.ts`.) The
 * hazard covered here, a lost HTTP response from a still-live bridge, never
 * spans a restart.
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
  promptDispatchRecords.set(
    promptDispatchKey(sessionId, requestId),
    { sessionId, state, updatedAt: Date.now() },
  );
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
  promptDispatchRecords.set(
    promptDispatchKey(sessionId, requestId),
    { sessionId, state: "already-processed", updatedAt },
  );
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

  const dispatchedRequestIds =
    session.dispatchedRequestIds ?? new Set<string>();
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
    throw sessionOperationError(
      "conflict",
      "Session is already processing a prompt",
    );
  }
  if (session.rewindInProgress) {
    throw sessionOperationError(
      "conflict",
      "Session is restoring files from a checkpoint",
    );
  }

  dispatchedRequestIds.add(requestId);
  session.dispatchedRequestIds = dispatchedRequestIds;

  const recentRequestIds = [...dispatchedRequestIds].slice(
    -MAX_DISPATCHED_REQUEST_IDS,
  );
  const retainedRequestIds = new Set(recentRequestIds);
  session.dispatchedRequestIds = retainedRequestIds;

  const sdkSessionId =
    session.sdkSessionId ?? sdkSessionIdFromBridgeId(session.id);
  if (!sdkSessionId) {
    session.dispatchedRequestIds.delete(requestId);
    throw sessionOperationError(
      "invalid",
      "Session does not have a durable request-id key",
    );
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
    await updateSessionPreferences(sdkSessionId, {
      dispatchedRequestIds: recentRequestIds,
    });

    if (
      sessions.get(sessionId) !== session
      || session.deleting
      || claimedPromptDispatches.get(sessionId) !== requestId
    ) {
      claimedPromptDispatches.delete(sessionId);
      retainedRequestIds.delete(requestId);
      await updateSessionPreferences(sdkSessionId, {
        dispatchedRequestIds: [...retainedRequestIds].slice(
          -MAX_DISPATCHED_REQUEST_IDS,
        ),
      });
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
        await updateSessionPreferences(sdkSessionId, {
          dispatchedRequestIds: [...retainedRequestIds].slice(
            -MAX_DISPATCHED_REQUEST_IDS,
          ),
        });
      } catch (rollbackError) {
        console.error(
          "[session-manager] Failed to roll back prompt dispatch claim:",
          rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
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

export async function waitForPendingPromptDispatchClaim(
  sessionId: string,
): Promise<void> {
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
  for (const [approvalId, approval] of pendingPlanApprovals) {
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
  for (const [questionId, question] of pendingQuestions) {
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

export function cleanupPendingInteractions(sessionId: string): void {
  cleanupPendingQuestions(sessionId);
  cleanupPendingPlanApprovals(sessionId);
}

/**
 * The single rule mapping a parked prompt to the session that raised it.
 *
 * `getPendingQuestions`, `getPendingPlanApprovals`, the eviction guard and
 * {@link getSessionActivity} all ask some form of "is anything of this
 * session's waiting on the user". Routing every one of them through this
 * predicate is what stops the `waiting` activity state from disagreeing with
 * the cards `/questions` and `/plan-approvals` actually serve.
 */
export function isPendingInteractionFor(
  entry: QuestionRequest | PlanApprovalRequest,
  sessionId: string,
): boolean {
  return entry.sessionId === sessionId;
}

/** True while a question or plan approval is waiting on the user. */
export function sessionHasPendingInteractions(sessionId: string): boolean {
  for (const question of pendingQuestions.values()) {
    if (isPendingInteractionFor(question, sessionId)) return true;
  }
  for (const approval of pendingPlanApprovals.values()) {
    if (isPendingInteractionFor(approval, sessionId)) return true;
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
  if (session && session.abortController) {
    session.abortController.abort();
    session.status = "idle";
    session.turnStartedAt = undefined;
    session.abortController = undefined;
    session.completionBlockedByBackgroundTasks = false;
    releaseQueryControl(session);

    cleanupPendingInteractions(sessionId);

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

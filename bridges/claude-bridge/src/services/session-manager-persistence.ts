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
import * as lifecycle from "./session-manager-lifecycle.js";
import * as messageParts from "./session-manager-messages.js";
import * as background from "./session-manager-background-tasks.js";
const { sessions, turnGenerationCounter, claimedPromptDispatches, pendingPromptDispatchClaims, IDLE_TRANSCRIPT_EVICTION_MS, IDLE_TRANSCRIPT_SWEEP_INTERVAL_MS, STRUCTURED_USAGE_REQUEST_TIMEOUT_MS, StructuredUsageRequestTimeoutError, touchSession, claudeExecutableOptions, pendingQuestions, questionResolvers, pendingPlanApprovals, planApprovalResolvers, QUESTION_TIMEOUT_MS, PLAN_APPROVAL_TIMEOUT_MS, SessionOperationError, sessionOperationError, TRANSCRIPT_UUID_PATTERN, ClaudeStructuredOutputError, recordStructuredOutput, generateSessionId, CLIENT_SESSION_ID_PATTERN, sessionIdForClientKey, sdkSessionIdFromBridgeId, bridgeSessionIdFromSdkId, persistedBridgeSessionId, generateMessageId, parseTokenValue, MAX_DATE_MS, EPOCH_MILLISECONDS_THRESHOLD, rateLimitResetToIso, extractContextUsageFromUnknown, STRUCTURED_RATE_LIMIT_WINDOWS, structuredRateLimitReset, structuredRateLimitWindow, rateLimitsFromStructuredUsage, getStructuredUsageWithTimeout, refreshStructuredRateLimits, createStructuredUsageRefreshCoordinator, buildClaudeUsageSnapshot, TITLE_MAX_SOURCE_PROMPT_LENGTH, TITLE_MAX_LENGTH, TITLE_MAX_OUTPUT_BYTES, TITLE_MAX_STDERR_LENGTH, TITLE_COMMAND_TIMEOUT_MS, TITLE_TERMINATION_GRACE_MS, SESSION_TITLE_SYSTEM_PROMPT, execFileText, findClaudeCliExecutable, sanitizeSessionTitle, buildSessionTitlePrompt, runClaudeTitleCommand, generateTitleViaCli, generateAndSetSessionTitle, createSession, persistSessionMetadata, ensureClientSessionAlias, applySessionPlanMode, setSessionPreferences, clearPromptSuggestion, getSession, PERSISTED_EXISTENCE_MEMO_MS, PERSISTED_EXISTENCE_MEMO_MAX, persistedSessionExistence, persistedSessionExistsOnDisk, resetSessionActivityProbeCacheForTesting, claudeSdk, currentWorkingDirectory, persistSessionTitle, getSessionActivity, PROMPT_DISPATCH_RETENTION_MS, promptDispatchRecords, promptDispatchKey, collectPromptDispatchGarbage, recordPromptDispatch, getPromptDispatchRecord, forgetPromptDispatch, forgetPromptDispatchesForSession, getPromptDispatchRecordCountForTesting, seedSettledPromptDispatchForTesting, getPromptDispatchState, claimPromptDispatch, waitForPendingPromptDispatchClaim, listSessions, cleanupPendingPlanApprovals, cleanupPendingQuestions, cleanupPendingInteractions, isPendingInteractionFor, sessionHasPendingInteractions, deleteSession, getSessionMessages, abortSession, ToolTracker, parseMcpToolName, isTaskToolName, parseMessageContent, buildMessageParts, MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH, MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS, persistedTaskIdentifier, persistedTaskText, PROVISIONAL_BACKGROUND_TASK_PREFIX, MAX_BACKGROUND_TASK_CANDIDATES, provisionalBackgroundTaskId, BACKGROUND_TASK_LABEL_BODY, LINE_LEADING_BACKGROUND_TASK_LABEL, EXCLUSIVE_BACKGROUND_TASK_LABEL, backgroundTaskResultText, backgroundTaskIdFromToolResultContent, exclusiveBackgroundTaskLabelId, correlatedBashToolResults, exclusiveBashToolResultId, bashToolResultOutcomes, provisionalBackgroundTaskLaunchesFromAssistantMessage, bashToolUseIdsFromAssistantMessage, persistedTaskStatus, persistedNotificationStatus, persistedTimestamp, persistedBackgroundTaskMessage, persistedRecordTime, reducePersistedBackgroundTaskMessage, normalizePersistedSessionMessages, LIVE_BACKGROUND_TASK_STATUSES, registerBackgroundTaskCandidate, takeBackgroundTaskCandidate, removeBackgroundTaskCandidatesOwnedBy, takeProvisionalBackgroundTask, recordBackgroundTaskLaunch, MAX_TERMINAL_BACKGROUND_TASKS, boundBackgroundTaskHistory, MAX_SETTLING_BACKGROUND_TASKS, parkSettlingBackgroundTask, takeSettlingBackgroundTask, forgetSettlingBackgroundTasksOwnedBy, NO_CONTROL_CHANNEL, settleBackgroundTask, settleTasksOwnedByClosedControl, stopBackgroundTask, emitBackgroundTaskSnapshot, releaseQueryControl, closeQueryControl, releaseQueryControls, retainQueryControl, forgetRetainedQueryControl, closeQueryControlIfUnused } = Object.assign({}, core, lifecycle, messageParts, background);
void [sessions, turnGenerationCounter, claimedPromptDispatches, pendingPromptDispatchClaims, IDLE_TRANSCRIPT_EVICTION_MS, IDLE_TRANSCRIPT_SWEEP_INTERVAL_MS, STRUCTURED_USAGE_REQUEST_TIMEOUT_MS, StructuredUsageRequestTimeoutError, touchSession, claudeExecutableOptions, pendingQuestions, questionResolvers, pendingPlanApprovals, planApprovalResolvers, QUESTION_TIMEOUT_MS, PLAN_APPROVAL_TIMEOUT_MS, SessionOperationError, sessionOperationError, TRANSCRIPT_UUID_PATTERN, ClaudeStructuredOutputError, recordStructuredOutput, generateSessionId, CLIENT_SESSION_ID_PATTERN, sessionIdForClientKey, sdkSessionIdFromBridgeId, bridgeSessionIdFromSdkId, persistedBridgeSessionId, generateMessageId, parseTokenValue, MAX_DATE_MS, EPOCH_MILLISECONDS_THRESHOLD, rateLimitResetToIso, extractContextUsageFromUnknown, STRUCTURED_RATE_LIMIT_WINDOWS, structuredRateLimitReset, structuredRateLimitWindow, rateLimitsFromStructuredUsage, getStructuredUsageWithTimeout, refreshStructuredRateLimits, createStructuredUsageRefreshCoordinator, buildClaudeUsageSnapshot, TITLE_MAX_SOURCE_PROMPT_LENGTH, TITLE_MAX_LENGTH, TITLE_MAX_OUTPUT_BYTES, TITLE_MAX_STDERR_LENGTH, TITLE_COMMAND_TIMEOUT_MS, TITLE_TERMINATION_GRACE_MS, SESSION_TITLE_SYSTEM_PROMPT, execFileText, findClaudeCliExecutable, sanitizeSessionTitle, buildSessionTitlePrompt, runClaudeTitleCommand, generateTitleViaCli, generateAndSetSessionTitle, createSession, persistSessionMetadata, ensureClientSessionAlias, applySessionPlanMode, setSessionPreferences, clearPromptSuggestion, getSession, PERSISTED_EXISTENCE_MEMO_MS, PERSISTED_EXISTENCE_MEMO_MAX, persistedSessionExistence, persistedSessionExistsOnDisk, resetSessionActivityProbeCacheForTesting, claudeSdk, currentWorkingDirectory, persistSessionTitle, getSessionActivity, PROMPT_DISPATCH_RETENTION_MS, promptDispatchRecords, promptDispatchKey, collectPromptDispatchGarbage, recordPromptDispatch, getPromptDispatchRecord, forgetPromptDispatch, forgetPromptDispatchesForSession, getPromptDispatchRecordCountForTesting, seedSettledPromptDispatchForTesting, getPromptDispatchState, claimPromptDispatch, waitForPendingPromptDispatchClaim, listSessions, cleanupPendingPlanApprovals, cleanupPendingQuestions, cleanupPendingInteractions, isPendingInteractionFor, sessionHasPendingInteractions, deleteSession, getSessionMessages, abortSession, ToolTracker, parseMcpToolName, isTaskToolName, parseMessageContent, buildMessageParts, MAX_PERSISTED_BACKGROUND_TASK_ID_LENGTH, MAX_PERSISTED_BACKGROUND_TASK_TEXT_LENGTH, MAX_PERSISTED_TIMESTAMP_FUTURE_SKEW_MS, persistedTaskIdentifier, persistedTaskText, PROVISIONAL_BACKGROUND_TASK_PREFIX, MAX_BACKGROUND_TASK_CANDIDATES, provisionalBackgroundTaskId, BACKGROUND_TASK_LABEL_BODY, LINE_LEADING_BACKGROUND_TASK_LABEL, EXCLUSIVE_BACKGROUND_TASK_LABEL, backgroundTaskResultText, backgroundTaskIdFromToolResultContent, exclusiveBackgroundTaskLabelId, correlatedBashToolResults, exclusiveBashToolResultId, bashToolResultOutcomes, provisionalBackgroundTaskLaunchesFromAssistantMessage, bashToolUseIdsFromAssistantMessage, persistedTaskStatus, persistedNotificationStatus, persistedTimestamp, persistedBackgroundTaskMessage, persistedRecordTime, reducePersistedBackgroundTaskMessage, normalizePersistedSessionMessages, LIVE_BACKGROUND_TASK_STATUSES, registerBackgroundTaskCandidate, takeBackgroundTaskCandidate, removeBackgroundTaskCandidatesOwnedBy, takeProvisionalBackgroundTask, recordBackgroundTaskLaunch, MAX_TERMINAL_BACKGROUND_TASKS, boundBackgroundTaskHistory, MAX_SETTLING_BACKGROUND_TASKS, parkSettlingBackgroundTask, takeSettlingBackgroundTask, forgetSettlingBackgroundTasksOwnedBy, NO_CONTROL_CHANNEL, settleBackgroundTask, settleTasksOwnedByClosedControl, stopBackgroundTask, emitBackgroundTaskSnapshot, releaseQueryControl, closeQueryControl, releaseQueryControls, retainQueryControl, forgetRetainedQueryControl, closeQueryControlIfUnused];
type OrderedPartEntry = messageParts.OrderedPartEntry;
type BackgroundTaskSystemMessage = messageParts.BackgroundTaskSystemMessage;
type BackgroundTaskLaunch = messageParts.BackgroundTaskLaunch;
type CorrelatedBashToolResult = messageParts.CorrelatedBashToolResult;
type BashToolResultOutcome = messageParts.BashToolResultOutcome;
export let sessionDeletionTick = 0;

/** How many recent deletions are remembered; each only has to outlast one read. */
export const DELETE_TOMBSTONE_LIMIT = 128;

/** SDK session id → the tick at which durable deletion removed its rollout. */
export const deletedSdkSessionTicks = new Map<string, number>();

export function recordDeletedSdkSession(sdkSessionId: string): void {
  sessionDeletionTick += 1;
  // Insertion-ordered, so the first key is always the oldest tombstone.
  deletedSdkSessionTicks.delete(sdkSessionId);
  deletedSdkSessionTicks.set(sdkSessionId, sessionDeletionTick);
  while (deletedSdkSessionTicks.size > DELETE_TOMBSTONE_LIMIT) {
    const oldest = deletedSdkSessionTicks.keys().next();
    if (oldest.done) break;
    deletedSdkSessionTicks.delete(oldest.value);
  }
}

/**
 * Whether a read that started at `readTick` could be holding a pre-deletion
 * snapshot of this session. A deletion that landed after the read started means
 * the rows it returns are stale, so adopting them would resurrect a session the
 * user deleted — with no code path that ever prunes it again.
 */
export function deletedSinceTick(sdkSessionId: string, readTick: number): boolean {
  const deletedAt = deletedSdkSessionTicks.get(sdkSessionId);
  return deletedAt !== undefined && deletedAt > readTick;
}

/**
 * Whether a title is still the id-derived placeholder the bridge assigns, and
 * so carries no user or generated intent worth preserving.
 *
 * Matched exactly against the two forms that can be minted rather than by
 * prefix: a user-chosen "Session planning notes" is not a default.
 */
export function isDefaultSessionTitle(
  title: string | undefined,
  bridgeId: string,
  sdkId?: string,
): boolean {
  if (title === undefined || title.length === 0) return true;
  if (title === `Session ${bridgeId.slice(-6)}`) return true;
  return sdkId !== undefined && title === `Session ${sdkId.slice(-6)}`;
}

/**
 * Reconcile lightweight SDK session metadata into the bridge registry.
 *
 * Transcript bodies are deliberately loaded only when one session is opened.
 * Listing must stay bounded even for a large Claude home.
 */
export async function reconcilePersistedSessions(): Promise<void> {
  const sdk = await claudeSdk();
  if (typeof sdk.listSessions !== "function") return;
  const cwd = currentWorkingDirectory();
  // Recorded before the read, so a deletion that lands while it is in flight is
  // detectable against the snapshot it returns.
  const listStartedAtTick = sessionDeletionTick;
  const infos = await sdk.listSessions({
    dir: cwd,
    includeProgrammatic: true,
    // Every Orkestrator environment is a worktree of the same repository, so
    // the SDK default (`true`) would hand this bridge every *other*
    // environment's sessions — which rename, delete and fork would then act on.
    includeWorktrees: false,
  });
  // Durable preferences are read before the adoption loop below: the loop's
  // race-safety against concurrent prompts and deletions depends on it never
  // awaiting between its `sessions.get` check and `sessions.set`. Sequential
  // rather than fanned out so a large Claude home cannot open hundreds of
  // files at once; entries that already live in memory are skipped, and memory
  // stays authoritative for them.
  const storedPreferencesBySdkId = new Map<
    string,
    Awaited<ReturnType<typeof readSessionPreferences>>
  >();
  for (const info of infos) {
    if (sessions.has(bridgeSessionIdFromSdkId(info.sessionId))) continue;
    const preferences = await readSessionPreferences(info.sessionId);
    if (preferences) {
      storedPreferencesBySdkId.set(info.sessionId, preferences);
    }
  }
  for (const info of infos) {
    // Belt and braces: an SDK that ignores `includeWorktrees` (or a store
    // backend where it does not apply) must still not leak another
    // environment's sessions into this registry.
    if (typeof info.cwd === "string" && info.cwd.length > 0 && !isPathWithin(cwd, info.cwd)) {
      continue;
    }
    // The rollout was deleted while this listing was in flight. Nothing prunes
    // a re-inserted entry, so adopting it would leave a permanent zombie.
    if (deletedSinceTick(info.sessionId, listStartedAtTick)) continue;
    const storedPreferences = storedPreferencesBySdkId.get(info.sessionId);
    const id = persistedBridgeSessionId(info.sessionId, storedPreferences);
    const existing = sessions.get(id);
    if (existing) {
      // `summary` is effectively always set, so taking it unconditionally
      // reverted every title generated by `generateAndSetSessionTitle` on the
      // next `GET /session/list`. Only an explicit on-disk rename outranks the
      // in-memory title; a summary may only fill a still-default placeholder.
      if (info.customTitle) {
        existing.title = info.customTitle;
      } else if (
        info.summary
        && isDefaultSessionTitle(existing.title, id, info.sessionId)
      ) {
        existing.title = info.summary;
      }
      existing.lastActivity = new Date(info.lastModified);
      existing.sdkSessionId = info.sessionId;
      continue;
    }
    sessions.set(id, {
      id,
      title: info.customTitle || info.summary || `Session ${info.sessionId.slice(-6)}`,
      messages: [],
      status: "idle",
      createdAt: new Date(info.createdAt ?? info.lastModified),
      lastActivity: new Date(info.lastModified),
      sdkSessionId: info.sessionId,
      persistedMessagesLoaded: false,
      ...(storedPreferences?.planMode !== undefined
        ? { planMode: storedPreferences.planMode }
        : {}),
      ...(storedPreferences?.dispatchedRequestIds?.length
        ? {
            dispatchedRequestIds: new Set(
              storedPreferences.dispatchedRequestIds,
            ),
          }
        : {}),
      ...(sessionPreferencesUnavailable(storedPreferences)
        ? { dispatchJournalUnavailable: true }
        : {}),
    });
  }
}

/**
 * Single in-flight materialization per bridge session id.
 *
 * `GET /:id`, `/messages`, `/tasks` and `POST /:id/prompt` all call
 * {@link ensurePersistedSession}, and a tab mounting fires them together. One
 * shared promise means one SDK read and, more importantly, one writer.
 */
export const persistedMaterializations = new Map<string, Promise<SessionState | undefined>>();

export async function materializePersistedSessionState(
  sessionId: string,
  sdkId: string,
): Promise<SessionState | undefined> {
  const startedAtTick = sessionDeletionTick;
  const sdk = await claudeSdk();
  // Re-checked after every await. A prompt that claimed this id while the read
  // was pending owns a running status, a live transcript and a task registry;
  // overwriting it with a fresh idle record silently discards the turn.
  const racedDuringImport = sessions.get(sessionId);
  if (racedDuringImport) return racedDuringImport;

  if (typeof sdk.getSessionInfo !== "function") return undefined;
  const [info, preferences] = await Promise.all([
    sdk.getSessionInfo(sdkId, {
      dir: currentWorkingDirectory(),
    }),
    readSessionPreferences(sdkId),
  ]);
  const racedDuringRead = sessions.get(sessionId);
  if (racedDuringRead) return racedDuringRead;

  if (!info) return undefined;
  // Deleted while this read was in flight: the metadata is a pre-deletion
  // snapshot and registering it would resurrect the session.
  if (deletedSinceTick(sdkId, startedAtTick)) return undefined;
  const state: SessionState = {
    id: sessionId,
    title: info.customTitle || info.summary || `Session ${sdkId.slice(-6)}`,
    messages: [],
    status: "idle",
    createdAt: new Date(info.createdAt ?? info.lastModified),
    lastActivity: new Date(info.lastModified),
    sdkSessionId: sdkId,
    persistedMessagesLoaded: false,
    ...(preferences?.planMode !== undefined ? { planMode: preferences.planMode } : {}),
    ...(preferences?.dispatchedRequestIds?.length
      ? { dispatchedRequestIds: new Set(preferences.dispatchedRequestIds) }
      : {}),
    ...(sessionPreferencesUnavailable(preferences)
      ? { dispatchJournalUnavailable: true }
      : {}),
  };
  touchSession(state);
  sessions.set(sessionId, state);
  // Registered first: the alias repair is durability housekeeping and must not
  // decide whether this session becomes available.
  await ensureClientSessionAlias(state, preferences);
  return state;
}

export async function ensurePersistedSession(
  sessionId: string,
): Promise<SessionState | undefined> {
  const existing = sessions.get(sessionId);
  if (existing) {
    touchSession(existing);
    return existing;
  }

  const inFlight = persistedMaterializations.get(sessionId);
  if (inFlight) return inFlight;

  const sdkId = sdkSessionIdFromBridgeId(sessionId);
  if (!sdkId) return undefined;

  const materialization = materializePersistedSessionState(sessionId, sdkId);
  persistedMaterializations.set(sessionId, materialization);
  void materialization
    .finally(() => {
      if (persistedMaterializations.get(sessionId) === materialization) {
        persistedMaterializations.delete(sessionId);
      }
    })
    .catch(() => {
      // The caller observes the original rejection. This branch only handles
      // the promise returned by `finally`, avoiding an unhandled rejection.
    });
  return materialization;
}

/**
 * Read and normalize a session's persisted transcript.
 *
 * Split out of {@link hydratePersistedSessionMessages} so `sendPrompt` can load
 * the transcript for a session it has *already* marked running, which the
 * public entry point deliberately refuses to do.
 */
export async function readPersistedSessionMessages(
  session: SessionState,
): Promise<{
  messages: NormalizedMessage[];
  taskRegistry: TaskRegistry;
  backgroundTasks?: Record<string, BackgroundTaskSnapshot>;
} | undefined> {
  if (!session.sdkSessionId) return undefined;
  const sdk = await claudeSdk();
  if (typeof sdk.getSessionMessages !== "function") return undefined;
  const persisted = await sdk.getSessionMessages(session.sdkSessionId, {
    dir: currentWorkingDirectory(),
    includeSystemMessages: true,
  });
  return normalizePersistedSessionMessages(persisted);
}

export function readPersistedSessionMessagesOnce(
  session: SessionState,
): Promise<{
  messages: NormalizedMessage[];
  taskRegistry: TaskRegistry;
  backgroundTasks?: Record<string, BackgroundTaskSnapshot>;
} | undefined> {
  if (session.persistedHydration) return session.persistedHydration;
  const hydration = readPersistedSessionMessages(session);
  session.persistedHydration = hydration;
  void hydration.finally(() => {
    if (session.persistedHydration === hydration) {
      session.persistedHydration = undefined;
    }
  }).catch(() => {
    // The caller observes the original rejection. This branch only handles the
    // promise returned by `finally`, avoiding an unhandled rejection.
  });
  return hydration;
}

export async function hydratePersistedSessionMessages(
  sessionId: string,
): Promise<NormalizedMessage[]> {
  const session = await ensurePersistedSession(sessionId);
  if (!session) return [];
  // Hydration replaces `messages` and `taskRegistry` wholesale. A turn holds a
  // direct reference to both (the user message it pushed, the registry it
  // captured), so doing that mid-turn silently discards live state. The
  // in-memory transcript is authoritative while a turn runs.
  if (session.status === "running") return session.messages;
  if (session.persistedMessagesLoaded !== false) return session.messages;

  const hydrated = await readPersistedSessionMessagesOnce(session);
  // A prompt or deletion may have claimed the session while the SDK read was
  // pending. In that case its in-memory state is authoritative; the prompt
  // shares this same read and applies it before appending its live message.
  if (
    sessions.get(sessionId) === session
    && (session.status as SessionState["status"]) !== "running"
    && !session.deleting
    && session.persistedMessagesLoaded === false
  ) {
    if (hydrated) {
      session.messages = hydrated.messages;
      session.taskRegistry = hydrated.taskRegistry;
      session.backgroundTasks = hydrated.backgroundTasks;
    }
    session.persistedMessagesLoaded = true;
    touchSession(session);
  }
  return session.messages;
}

/** Why a session survived a sweep, counted so the sweep is observable. */
export interface IdleTranscriptSweepStats {
  scanned: number;
  evicted: number;
  /** Skip reason → count. Only non-zero reasons appear. */
  skipped: Record<string, number>;
}

export let lastIdleTranscriptSweep: IdleTranscriptSweepStats | undefined;

/**
 * Stats from the most recent sweep, or undefined before the first one.
 *
 * The sweep used to report only the sessions it evicted, which made "evicted
 * nothing" indistinguishable from "was disqualified by the same guard every
 * time" — the exact failure mode that let a permanent guard go unnoticed.
 */
export function getLastIdleTranscriptSweep(): IdleTranscriptSweepStats | undefined {
  return lastIdleTranscriptSweep;
}

/**
 * Drop hydrated transcripts nobody has read in {@link IDLE_TRANSCRIPT_EVICTION_MS}.
 *
 * Conservative, but time-scoped rather than permanent. A session that is
 * running, that still holds turn control handles or background tasks, or that
 * a pending question or plan approval points into is never touched: those hold
 * direct references into the live transcript.
 *
 * Streamed messages are the one guard that used to be permanent. They carry
 * `revision` counters a reconnecting SSE client resumes `message.patched`
 * from, and hydration from disk cannot reproduce them — but `revision` is
 * stamped on every assistant message of every turn and never cleared, so that
 * exempted every session the user had actually run, which are precisely the
 * large transcripts. The counters only matter while a client could still be
 * resuming from them, and the SSE replay ring retains a bounded window: a
 * client whose cursor is `IDLE_TRANSCRIPT_EVICTION_MS` stale has already been
 * told `replay.required` and will rehydrate from REST regardless. So the guard
 * now expires with {@link SessionState.lastStreamedRevisionAt}. A session
 * carrying revisions with no such timestamp is still never evicted.
 *
 * Eviction is invisible to clients: the next `GET /messages` (or `/tasks`, or
 * prompt) sees `persistedMessagesLoaded === false` and re-hydrates from the
 * SDK rollout, exactly as after a bridge restart.
 *
 * Returns the evicted session ids. Exported for tests; production runs it on
 * the unref'd sweep timer below.
 */
export function evictIdleHydratedTranscripts(now: number = Date.now()): string[] {
  const evicted: string[] = [];
  const skipped: Record<string, number> = {};
  let scanned = 0;
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const session of sessions.values()) {
    scanned += 1;
    // Only a transcript hydrated from disk can be re-hydrated from disk. This
    // also excludes fresh `createSession` sessions (flag undefined) and
    // sessions whose hydration is pending or previously failed (flag false).
    if (session.persistedMessagesLoaded !== true) { skip("not-hydrated"); continue; }
    if (!session.sdkSessionId) { skip("no-rollout"); continue; }
    // `error` is deliberately included alongside `running`: a failed turn's
    // control handles are torn down, but `status` stays `error` until the next
    // prompt, so excluding it would pin that transcript for the process
    // lifetime. The remaining guards below still cover anything it left live.
    if (session.status === "running") { skip("running"); continue; }
    if (session.deleting || session.rewindInProgress) { skip("claimed"); continue; }
    if (session.abortController) { skip("abort-controller"); continue; }
    if (session.persistedHydration) { skip("hydrating"); continue; }
    // A live or recently completed turn: control handles may still own
    // background work, and the turn holds direct references into `messages`.
    if (session.queryControl) { skip("query-control"); continue; }
    if (session.backgroundTaskControls && session.backgroundTaskControls.size > 0) {
      skip("background-task-controls");
      continue;
    }
    if (session.backgroundTaskCandidates && session.backgroundTaskCandidates.size > 0) {
      skip("background-task-candidates");
      continue;
    }
    // A released turn waiting for the continuation a background task triggers
    // is idle by `status`, owns no abort controller and — once the level signal
    // has cleared its tasks — no live task either. Evicting its transcript here
    // would drop the messages the continuation is about to be appended to.
    if (session.retainedQueryControls && session.retainedQueryControls.size > 0) {
      skip("retained-query-controls");
      continue;
    }
    if (session.settlingBackgroundTasks && session.settlingBackgroundTasks.size > 0) {
      skip("settling-background-tasks");
      continue;
    }
    if (
      (Object.values(session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[]).some(
        (task: BackgroundTaskSnapshot) =>
          task.status === "pending"
          || task.status === "running"
          || task.status === "paused",
      )
    ) {
      skip("background-tasks");
      continue;
    }
    if (sessionHasPendingInteractions(session.id)) { skip("pending-interaction"); continue; }
    if (session.messages.length === 0 && !session.taskRegistry) { skip("empty"); continue; }
    const lastAccessedAt = session.lastAccessedAt ?? session.lastActivity.getTime();
    if (now - lastAccessedAt < IDLE_TRANSCRIPT_EVICTION_MS) { skip("recently-read"); continue; }
    // A message with a revision was streamed by this process; see above. With
    // no recorded stream time we cannot tell how stale it is, so keep it.
    if (session.messages.some((message: NormalizedMessage) => message.revision !== undefined)) {
      const streamedAt = session.lastStreamedRevisionAt ?? now;
      if (now - streamedAt < IDLE_TRANSCRIPT_EVICTION_MS) {
        skip("recently-streamed");
        continue;
      }
    }

    session.messages = [];
    session.taskRegistry = undefined;
    session.persistedMessagesLoaded = false;
    evicted.push(session.id);
  }

  lastIdleTranscriptSweep = { scanned, evicted: evicted.length, skipped };
  if (isDebugLoggingEnabled || evicted.length > 0) {
    debugLog("[session-manager] Idle hydrated transcript sweep", {
      scanned,
      evicted: evicted.length,
      sessionIds: evicted,
      skipped,
    });
  }
  return evicted;
}

/**
 * Arm the periodic sweep.
 *
 * Unref'd so it never holds an exiting bridge open. Exported (with an
 * injectable interval) so a test can prove eviction actually runs on a timer
 * rather than only when a test calls it directly.
 */
export function startIdleTranscriptSweep(
  intervalMs: number = IDLE_TRANSCRIPT_SWEEP_INTERVAL_MS,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => evictIdleHydratedTranscripts(), intervalMs);
  timer.unref?.();
  return timer;
}

startIdleTranscriptSweep();

export async function deleteSessionDurably(sessionId: string): Promise<boolean> {
  // Do not introduce an `await` for an already registered session: deletion
  // must claim it synchronously so a prompt cannot slip in on the next
  // microtask before `deleting` is visible.
  const session = sessions.get(sessionId) ?? await ensurePersistedSession(sessionId);
  if (!session) {
    // A prior attempt can delete the SDK rollout and then fail while removing
    // bridge-owned metadata. Let a retry finish that cleanup even though the
    // authoritative rollout no longer materializes.
    const sdkSessionId = sdkSessionIdFromBridgeId(sessionId);
    if (sdkSessionId) await deleteSessionPreferences(sdkSessionId);
    return false;
  }
  if (session.deleting) {
    throw sessionOperationError("conflict", "Session deletion is already in progress");
  }

  // Claim deletion before the first await. Stop every live writer before
  // removing its rollout so it cannot recreate or append to the file.
  session.deleting = true;
  session.status = "running";
  claimedPromptDispatches.delete(sessionId);
  session.abortController?.abort();
  session.abortController = undefined;
  cleanupPendingInteractions(sessionId);
  await releaseQueryControls(session);
  await waitForPendingPromptDispatchClaim(sessionId);
  let rolloutDeleted = false;
  try {
    const preferenceSessionId =
      session.sdkSessionId ?? sdkSessionIdFromBridgeId(session.id);
    if (session.sdkSessionId) {
      const sdk = await claudeSdk();
      if (typeof sdk.deleteSession === "function") {
        await sdk.deleteSession(session.sdkSessionId, {
          dir: currentWorkingDirectory(),
        });
      }
      rolloutDeleted = true;
      // Recorded before the map entry is dropped: a reconcile already holding a
      // pre-deletion `listSessions` snapshot would otherwise re-insert it.
      recordDeletedSdkSession(session.sdkSessionId);
    }
    forgetPromptDispatchesForSession(sessionId);
    if (preferenceSessionId) {
      await deleteSessionPreferences(preferenceSessionId);
    }
    sessions.delete(sessionId);
    return true;
  } catch (error) {
    if (rolloutDeleted && session.sdkSessionId) {
      // The rollout is already gone and cannot be restored. Keep the registry
      // consistent with that authoritative fact; a retry by id can still
      // finish removing the preference journal through the missing-session
      // branch above.
      recordDeletedSdkSession(session.sdkSessionId);
      sessions.delete(sessionId);
      throw error;
    }
    // The rollout still exists when deletion fails. Restore an addressable idle
    // session, but leave its stopped query stopped.
    session.deleting = false;
    session.status = "idle";
    session.turnStartedAt = undefined;
    session.completionBlockedByBackgroundTasks = false;
    throw error;
  }
}

export async function renameSessionDurably(
  sessionId: string,
  title: string,
): Promise<boolean> {
  const session = await ensurePersistedSession(sessionId);
  if (!session) return false;
  await persistSessionTitle(session, title);
  session.title = title;
  session.lastActivity = new Date();
  eventEmitter.emit({
    type: "session.title-updated",
    sessionId,
    data: { title },
  });
  return true;
}

export async function forkPersistedSession(
  sessionId: string,
  options: { upToMessageId?: string; title?: string } = {},
): Promise<SessionState> {
  const source = await ensurePersistedSession(sessionId);
  if (!source?.sdkSessionId) {
    throw sessionOperationError("not_found", "Session has not been materialized");
  }
  if (source.status === "running") {
    throw sessionOperationError("conflict", "Cannot fork a running session");
  }
  const sdk = await claudeSdk();
  if (typeof sdk.forkSession !== "function") {
    throw sessionOperationError(
      "conflict",
      "Installed Claude Agent SDK does not support session forking",
    );
  }
  const boundaryId = options.upToMessageId
    ? await resolvePersistedMessageId(source, options.upToMessageId)
    : undefined;
  if (options.upToMessageId && !boundaryId) {
    throw sessionOperationError(
      "invalid",
      "The selected Claude message is not a persisted fork boundary",
    );
  }
  const result = await sdk.forkSession(source.sdkSessionId, {
    dir: currentWorkingDirectory(),
    upToMessageId: boundaryId,
    title: options.title,
  });
  const id = bridgeSessionIdFromSdkId(result.sessionId);
  const now = new Date();
  const forked: SessionState = {
    id,
    title: options.title || `${source.title || "Session"} (fork)`,
    messages: [],
    status: "idle",
    createdAt: now,
    lastActivity: now,
    sdkSessionId: result.sessionId,
    persistedMessagesLoaded: false,
  };
  sessions.set(id, forked);
  return forked;
}

/**
 * Map a bridge message id onto the transcript uuid it stands for.
 *
 * Resolution is by *identity only*. There is no positional fallback: the
 * normalized transcript drops records the persisted list keeps (every
 * `tool_result` arrives as an empty `type:"user"` entry), so the two lists are
 * not index-aligned and an ordinal lookup silently returns a neighbouring
 * message — which the callers then fork at, or restore files to. Returning
 * `undefined` makes them fail closed instead.
 */
export async function resolvePersistedMessageId(
  session: SessionState,
  normalizedMessageId: string,
  allowedTypes: ReadonlySet<"user" | "assistant"> = new Set(["user", "assistant"]),
): Promise<string | undefined> {
  if (!session.sdkSessionId) return undefined;

  // A live message's `id` is locally generated (`msg-…`) and exists nowhere on
  // disk; `sdkUuid` is the uuid the SDK reported for it. A hydrated message has
  // both, and they agree.
  const local = session.messages.find((message) => message.id === normalizedMessageId);
  const candidate = local
    ? local.sdkUuid
    : TRANSCRIPT_UUID_PATTERN.test(normalizedMessageId)
      ? normalizedMessageId
      : undefined;
  if (!candidate) return undefined;
  if (local && !allowedTypes.has(local.role as "user" | "assistant")) return undefined;

  const sdk = await claudeSdk();
  if (typeof sdk.getSessionMessages !== "function") return candidate;
  const persisted = await sdk.getSessionMessages(session.sdkSessionId, {
    dir: currentWorkingDirectory(),
    includeSystemMessages: false,
  });
  const match = persisted.find(
    (message: { uuid?: string; type?: string }) =>
      message.uuid === candidate
      && allowedTypes.has(message.type as "user" | "assistant"),
  );
  return match?.uuid;
}

/**
 * How long a transient rewind query may take to produce its first message.
 *
 * Without a bound, a CLI that never speaks leaves the HTTP request hanging
 * forever with the session flagged busy.
 */
export const REWIND_OPEN_TIMEOUT_MS = 30_000;

export async function rewindViaTransientQuery(
  sdkSessionId: string,
  persistedMessageId: string,
  dryRun: boolean,
): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), REWIND_OPEN_TIMEOUT_MS);
  const iterator = query({
    prompt: "",
    options: {
      cwd: currentWorkingDirectory(),
      ...claudeExecutableOptions(),
      resume: sdkSessionId,
      enableFileCheckpointing: true,
      // This query exists only to obtain a control handle. `maxTurns: 0` keeps
      // it from running a turn that would append to the very rollout the
      // checkpoints are indexed against.
      maxTurns: 0,
      abortController,
    },
  });
  try {
    for await (const _message of iterator) {
      if (typeof iterator.rewindFiles !== "function") {
        throw sessionOperationError(
          "conflict",
          "Installed Claude Agent SDK does not support file rewind",
        );
      }
      return await iterator.rewindFiles(persistedMessageId, { dryRun });
    }
    throw sessionOperationError(
      "conflict",
      abortController.signal.aborted
        ? "Timed out opening the Claude session for file rewind"
        : "Claude session could not be opened for file rewind",
    );
  } finally {
    clearTimeout(timeout);
    try {
      await iterator.return?.();
    } catch (error) {
      debugLog("[session-manager] Failed to close rewind query:", error);
    }
  }
}

export async function rewindSessionFiles(
  sessionId: string,
  userMessageId: string,
  dryRun = false,
): Promise<unknown> {
  const session = await ensurePersistedSession(sessionId);
  if (!session?.sdkSessionId) {
    throw sessionOperationError("not_found", "Session has not been materialized");
  }
  if (session.status === "running") {
    throw sessionOperationError("conflict", "Cannot rewind a running session");
  }
  if (session.rewindInProgress) {
    throw sessionOperationError(
      "conflict",
      "A file rewind is already in progress for this session",
    );
  }

  // Claimed before the first await: a rewind restores the working tree, and
  // `status` never leaves `idle` while it runs, so nothing else would stop a
  // prompt accepted a millisecond later from executing against files mid-restore.
  session.rewindInProgress = true;
  try {
    const persistedMessageId = await resolvePersistedMessageId(
      session,
      userMessageId,
      new Set(["user"]),
    );
    if (!persistedMessageId) {
      throw sessionOperationError(
        "invalid",
        "The selected Claude message is not a persisted checkpoint",
      );
    }
    // Prefer the handle a live session already holds. Spawning a second CLI
    // against the same rollout only to ask it to rewind is both slower and a
    // write to the transcript this operation is indexed against.
    const liveRewind = session.queryControl?.rewindFiles;
    let result: unknown;
    if (typeof liveRewind === "function") {
      result = await liveRewind.call(session.queryControl, persistedMessageId, { dryRun });
    } else {
      result = await rewindViaTransientQuery(
        session.sdkSessionId,
        persistedMessageId,
        dryRun,
      );
    }
    if (
      !result
      || typeof result !== "object"
      || (result as { canRewind?: unknown }).canRewind !== true
    ) {
      const providerError =
        typeof (result as { error?: unknown } | null)?.error === "string"
          ? (result as { error: string }).error
          : "Claude cannot rewind files to the selected checkpoint";
      throw sessionOperationError("conflict", providerError);
    }
    return result;
  } finally {
    session.rewindInProgress = false;
  }
}


/**
 * Whether a rebuilt part is indistinguishable from the one already published
 * at that index, and so can be left out of a patch frame.
 *
 * Tool parts are compared by identity, which is exact: `ToolTracker` hands out
 * the same object until a result arrives and replaces it. Text and thinking
 * parts are rebuilt from the accumulated deltas on every pass, so they never
 * match by identity and are compared on the one field they carry.
 */
export function isSamePublishedPart(
  published: NormalizedPart | undefined,
  next: NormalizedPart,
): boolean {
  if (published === next) return true;
  if (!published || published.type !== next.type) return false;
  if (next.type === "text" || next.type === "thinking") {
    return (
      published.content === next.content
      && published.parentTaskUseId === next.parentTaskUseId
    );
  }
  return false;
}

export function getMessageTextFromParts(parts: NormalizedPart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.content || "")
    .join("");
}

/**
 * Detect image media type from file extension.
 */
export function getImageMediaType(filePath: string): "image/jpeg" | "image/png" | "image/gif" | "image/webp" {
  const ext = filePath.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Matches the renderer's final image-attachment policy. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export type ClaudeAttachmentErrorCode =
  | "attachment_changed"
  | "attachment_invalid_data"
  | "attachment_not_regular_file"
  | "attachment_outside_workspace"
  | "attachment_read_failed"
  | "attachment_symlink_not_allowed"
  | "attachment_too_large";

/** Stable error shape surfaced through the authoritative session error event. */
export class ClaudeAttachmentError extends Error {
  readonly name = "ClaudeAttachmentError";

  constructor(
    readonly code: ClaudeAttachmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function parseBase64ImageData(
  value: string,
): { data: string; mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null {
  let data = value;
  let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined;

  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
    if (!match || !SUPPORTED_IMAGE_MEDIA_TYPES.has(match[1])) {
      return null;
    }
    mediaType = match[1] as typeof mediaType;
    data = match[2];
  }

  const normalized = data.replace(/\s+/g, "");
  if (
    normalized.length === 0
    || normalized.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)
    || decodedBase64ByteLength(normalized) > MAX_IMAGE_ATTACHMENT_BYTES
  ) {
    return null;
  }

  return { data: normalized, mediaType };
}

export function isPathWithin(rootPath: string, targetPath: string): boolean {
  const childPath = relative(rootPath, targetPath);
  return (
    childPath === ""
    || (
      childPath !== ".."
      && !childPath.startsWith(`..${sep}`)
      && !isAbsolute(childPath)
    )
  );
}

export function attachmentErrorForFsFailure(error: unknown): ClaudeAttachmentError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ELOOP") {
    return new ClaudeAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links.",
    );
  }
  if (code === "EFBIG") {
    return new ClaudeAttachmentError(
      "attachment_too_large",
      "Image attachment exceeds the 8MB limit.",
    );
  }
  return new ClaudeAttachmentError(
    "attachment_read_failed",
    "Image attachment could not be read safely from the workspace.",
  );
}

export async function assertNoSymlinkComponents(
  lexicalRoot: string,
  targetPath: string,
): Promise<void> {
  const childPath = relative(lexicalRoot, targetPath);
  let currentPath = lexicalRoot;
  for (const segment of childPath.split(sep).filter(Boolean)) {
    currentPath = join(currentPath, segment);
    const stats = await lstat(currentPath).catch((error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    });
    if (stats.isSymbolicLink()) {
      throw new ClaudeAttachmentError(
        "attachment_symlink_not_allowed",
        "Image attachments must be regular workspace files, not symbolic links.",
      );
    }
  }
}

export async function assertOpenedWorkspaceFile(
  targetPath: string,
  canonicalRoot: string,
  openedStats: Stats,
): Promise<void> {
  const [pathStats, canonicalTarget] = await Promise.all([
    lstat(targetPath),
    realpath(targetPath),
  ]).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });

  if (pathStats.isSymbolicLink()) {
    throw new ClaudeAttachmentError(
      "attachment_symlink_not_allowed",
      "Image attachments must be regular workspace files, not symbolic links.",
    );
  }
  if (
    !pathStats.isFile()
    || !openedStats.isFile()
    || pathStats.dev !== openedStats.dev
    || pathStats.ino !== openedStats.ino
  ) {
    throw new ClaudeAttachmentError(
      "attachment_not_regular_file",
      "Image attachment is not a stable regular workspace file.",
    );
  }
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }
}

export async function readWorkspaceImageAttachment(
  filePath: string,
  cwd: string,
  afterSymlinkValidation?: (filePath: string) => void | Promise<void>,
  afterCanonicalValidation?: (filePath: string) => void | Promise<void>,
  afterInitialValidation?: (filePath: string) => void | Promise<void>,
): Promise<Buffer> {
  const lexicalRoot = resolve(cwd);
  const targetPath = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(lexicalRoot, filePath);
  if (!isPathWithin(lexicalRoot, targetPath)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }

  const canonicalRoot = await realpath(lexicalRoot).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  await assertNoSymlinkComponents(lexicalRoot, targetPath);
  await afterSymlinkValidation?.(targetPath);

  const canonicalTarget = await realpath(targetPath).catch((error: unknown) => {
    throw attachmentErrorForFsFailure(error);
  });
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new ClaudeAttachmentError(
      "attachment_outside_workspace",
      "Image attachment must be contained in the current workspace.",
    );
  }
  await afterCanonicalValidation?.(targetPath);

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(targetPath, constants.O_RDONLY | noFollow).catch(
    (error: unknown) => {
      throw attachmentErrorForFsFailure(error);
    },
  );

  try {
    const initialStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, initialStats);
    if (initialStats.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new ClaudeAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit.",
      );
    }
    await afterInitialValidation?.(targetPath);

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_IMAGE_ATTACHMENT_BYTES) {
      const remaining = (MAX_IMAGE_ATTACHMENT_BYTES + 1) - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
      throw new ClaudeAttachmentError(
        "attachment_too_large",
        "Image attachment exceeds the 8MB limit.",
      );
    }
    if (totalBytes === 0) {
      throw new ClaudeAttachmentError(
        "attachment_invalid_data",
        "Image attachment file is empty.",
      );
    }

    const finalStats = await handle.stat();
    await assertOpenedWorkspaceFile(targetPath, canonicalRoot, finalStats);
    if (
      finalStats.dev !== initialStats.dev
      || finalStats.ino !== initialStats.ino
      || finalStats.size !== initialStats.size
      || finalStats.size !== totalBytes
      || finalStats.mtimeMs !== initialStats.mtimeMs
      || finalStats.ctimeMs !== initialStats.ctimeMs
    ) {
      throw new ClaudeAttachmentError(
        "attachment_changed",
        "Image attachment changed while it was being read; please attach it again.",
      );
    }

    return Buffer.concat(chunks, totalBytes);
  } catch (error) {
    if (error instanceof ClaudeAttachmentError) throw error;
    throw attachmentErrorForFsFailure(error);
  } finally {
    await handle.close();
  }
}

export function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function attachmentTag(attachment: NonNullable<PromptOptions["attachments"]>[number]): string {
  return `<attachment type="${escapeXmlAttribute(attachment.type)}" path="${escapeXmlAttribute(attachment.path)}" filename="${escapeXmlAttribute(attachment.filename || "")}" />`;
}

/**
 * Build the SDK prompt. When image attachments are present, returns an
 * AsyncIterable<SDKUserMessage> with inline base64 image content blocks so
 * the API receives them natively (up to 8000x8000) instead of relying on the
 * Read tool (which has a 2000x2000 limit).
 *
 * For text-only prompts (or prompts with only file attachments), returns a
 * plain string as before.
 */
export async function buildSdkPrompt(
  finalPrompt: string,
  attachments: PromptOptions["attachments"] | undefined,
  cwd: string,
  afterAttachmentSymlinkValidation?: (filePath: string) => void | Promise<void>,
  afterAttachmentCanonicalValidation?: (filePath: string) => void | Promise<void>,
  afterAttachmentInitialValidation?: (filePath: string) => void | Promise<void>,
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const imageAttachments = attachments?.filter((att) => att.type === "image") ?? [];
  if (imageAttachments.length === 0) {
    return finalPrompt;
  }

  const contentBlocks: ContentBlockParam[] = [];
  if (finalPrompt) {
    contentBlocks.push({ type: "text", text: finalPrompt } as TextBlockParam);
  }
  let imageBlockCount = 0;

  for (const att of imageAttachments) {
    let base64Data: string | null = null;
    let mediaType = getImageMediaType(att.path || att.filename || "image.png");

    // Prefer dataUrl from the frontend (already base64-encoded).
    if (att.dataUrl !== undefined) {
      const parsedData = parseBase64ImageData(att.dataUrl);
      if (!parsedData) {
        throw new ClaudeAttachmentError(
          "attachment_invalid_data",
          "Image attachment data must be valid base64 and no larger than 8MB.",
        );
      }
      base64Data = parsedData.data;
      mediaType = parsedData.mediaType ?? mediaType;
    } else if (att.path) {
      const buffer = await readWorkspaceImageAttachment(
        att.path,
        cwd,
        afterAttachmentSymlinkValidation,
        afterAttachmentCanonicalValidation,
        afterAttachmentInitialValidation,
      );
      base64Data = buffer.toString("base64");
    } else {
      throw new ClaudeAttachmentError(
        "attachment_read_failed",
        "Image attachment does not contain readable image data.",
      );
    }

    if (base64Data) {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: mediaType,
          data: base64Data,
        },
      } as ImageBlockParam);
      imageBlockCount += 1;
    }
  }

  if (imageBlockCount === 0) {
    if (finalPrompt.trim().length === 0) {
      throw new Error("No valid image attachment was provided");
    }
    return finalPrompt;
  }

  // Wrap in an async iterable yielding a single SDKUserMessage
  const userMessage: SDKUserMessage = {
    type: "user",
    message: {
      role: "user",
      content: contentBlocks,
    },
    parent_tool_use_id: null,
  };

  async function* singleMessage(): AsyncIterable<SDKUserMessage> {
    yield userMessage;
  }

  return singleMessage();
}

export interface HeldSdkPrompt {
  prompt: AsyncIterable<SDKUserMessage>;
  close: () => void;
}

/**
 * Convert every prompt to streaming-input mode and keep that input open until
 * the bridge knows the whole turn (including background agents) is settled.
 *
 * The Agent SDK closes stdin on the first `result` for string prompts. An
 * AsyncIterable avoids that single-turn path, but only while the iterable
 * itself remains open; a one-message generator still closes at the first
 * result because `canUseTool` makes the SDK wait there before ending input.
 */
export function holdSdkPromptOpen(
  sdkPrompt: string | AsyncIterable<SDKUserMessage>,
  signal: AbortSignal,
): HeldSdkPrompt {
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    resolveClosed();
  };
  signal.addEventListener("abort", close, { once: true });
  if (signal.aborted) close();

  async function* stream(): AsyncIterable<SDKUserMessage> {
    try {
      if (typeof sdkPrompt === "string") {
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: sdkPrompt }],
          },
          parent_tool_use_id: null,
        };
      } else {
        for await (const message of sdkPrompt) {
          yield message;
        }
      }
      await closedPromise;
    } finally {
      close();
    }
  }

  return { prompt: stream(), close };
}

/**
 * How often streamed deltas are folded into a published message snapshot.
 *
 * Rebuilding every ordered part, every message part, and a full-message SSE
 * frame per subscriber on **every token** made streaming O(turn size) per
 * token — the dominant allocation source in a long turn. Deltas still
 * accumulate immediately; only the rebuild + emit is deferred. Anything that
 * is not a delta flushes synchronously first, so event ordering is unchanged.
 */

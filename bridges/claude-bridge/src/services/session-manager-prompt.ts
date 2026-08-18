// Session Manager Service
// Handles session state and interacts with Claude Agent SDK
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ImageBlockParam,
  TextBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
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
import { isRootAssistantRecord, normalizeBackendModelId } from "@orkestrator/protocol/model-id";
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
import * as persistence from "./session-manager-persistence.js";
import { createPromptStreamState } from "./session-manager-prompt-stream.js";
import { nextTurnGeneration } from "./session-manager-core.js";
import {
  ClaudeStructuredOutputError,
  PLAN_APPROVAL_TIMEOUT_MS,
  QUESTION_TIMEOUT_MS,
  applySessionPlanMode,
  buildClaudeUsageSnapshot,
  claimedPromptDispatches,
  claudeExecutableOptions,
  createStructuredUsageRefreshCoordinator,
  generateAndSetSessionTitle,
  generateMessageId,
  pendingPlanApprovals,
  pendingQuestions,
  persistSessionMetadata,
  planApprovalResolvers,
  questionResolvers,
  rateLimitResetToIso,
  recordStructuredOutput,
  sdkSessionIdFromBridgeId,
  sessionOperationError,
  sessions,
} from "./session-manager-core.js";
import {
  cleanupPendingInteractions,
  forgetPromptDispatch,
  getPromptDispatchRecord,
  recordPromptDispatch,
} from "./session-manager-lifecycle.js";
import {
  bashToolResultOutcomes,
  bashToolUseIdsFromAssistantMessage,
  buildMessageParts,
  parseMessageContent,
  provisionalBackgroundTaskId,
  provisionalBackgroundTaskLaunchesFromAssistantMessage,
} from "./session-manager-messages.js";
import {
  ClaudeAttachmentError,
  attachmentTag,
  buildSdkPrompt,
  getMessageTextFromParts,
  holdSdkPromptOpen,
  readPersistedSessionMessagesOnce,
} from "./session-manager-persistence.js";
import {
  LIVE_BACKGROUND_TASK_STATUSES,
  boundBackgroundTaskHistory,
  closeQueryControlIfUnused,
  emitBackgroundTaskSnapshot,
  forgetRetainedQueryControl,
  forgetSettlingBackgroundTasksOwnedBy,
  parkSettlingBackgroundTask,
  recordBackgroundTaskLaunch,
  registerBackgroundTaskCandidate,
  removeBackgroundTaskCandidatesOwnedBy,
  retainQueryControl,
  settleBackgroundTask,
  settleTasksOwnedByClosedControl,
  takeBackgroundTaskCandidate,
  takeProvisionalBackgroundTask,
  takeSettlingBackgroundTask,
} from "./session-manager-background-tasks.js";
type StructuredUsageRefreshCoordinator = core.StructuredUsageRefreshCoordinator;
type PlanApprovalResponse = core.PlanApprovalResponse;
type OrderedPartEntry = messageParts.OrderedPartEntry;
export const STREAM_EVENT_COALESCE_MS = 100;
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
 * Highest content-block index accepted from a streamed SDK event.
 *
 * Real assistant responses use a small, dense sequence of content blocks.
 * Treat a larger index as malformed instead of retaining attacker-controlled
 * sparse state for the rest of the turn. The map-based storage below also
 * keeps iteration proportional to the number of blocks actually received.
 */
export const MAX_STREAM_CONTENT_BLOCK_INDEX = 4_095;
/**
 * Send a prompt to a session and process the response
 */
export async function sendPrompt(
  sessionId: string,
  prompt: string,
  options?: PromptOptions,
  testHooks?: {
    afterAttachmentSymlinkValidation?: (filePath: string) => void | Promise<void>;
    afterAttachmentCanonicalValidation?: (filePath: string) => void | Promise<void>;
    afterAttachmentInitialValidation?: (filePath: string) => void | Promise<void>;
    onQueryStarted?: () => void;
    /** Shortens the retained-continuation watchdog so tests can observe it. */
    retainedContinuationTimeoutMs?: number;
  },
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }
  const dispatchRequestId = options?.requestId?.trim() || undefined;
  const structuredRequestId = options?.outputSchema
    ? (dispatchRequestId ?? crypto.randomUUID())
    : undefined;
  const claimedRequestId = !options?.outputSchema ? options?.requestId?.trim() : undefined;
  const ownsClaimedDispatch =
    claimedRequestId !== undefined && claimedPromptDispatches.get(sessionId) === claimedRequestId;
  // At-most-once dispatch, for plain prompts as much as structured ones. The
  // HTTP response may have been lost; reusing a request id attaches to the
  // original turn and never launches another SDK query.
  if (dispatchRequestId && getPromptDispatchRecord(sessionId, dispatchRequestId)) {
    return;
  }
  if (
    structuredRequestId &&
    session.structuredOutputRequestId === structuredRequestId &&
    (session.status === "running" || session.structuredOutput !== undefined)
  ) {
    return;
  }
  if (session.deleting) {
    throw sessionOperationError("conflict", "Session is being deleted");
  }
  if (session.status === "running" && !ownsClaimedDispatch) {
    throw new Error("Session is already processing a prompt");
  }
  if (session.rewindInProgress) {
    throw sessionOperationError("conflict", "Session is restoring files from a checkpoint");
  }
  const statusBeforeStartup = session.status;
  const turnStartedAtBeforeStartup = session.turnStartedAt;
  const abortControllerBeforeStartup = session.abortController;
  const errorBeforeStartup = session.error;
  const lastActivityBeforeStartup = session.lastActivity;
  const persistedMessagesLoadedBeforeStartup = session.persistedMessagesLoaded;
  const structuredOutputBeforeStartup = session.structuredOutput;
  const structuredOutputRequestIdBeforeStartup = session.structuredOutputRequestId;
  const latestTurnGenerationBeforeStartup = session.latestTurnGeneration;
  if (ownsClaimedDispatch) {
    claimedPromptDispatches.delete(sessionId);
  }
  if (structuredRequestId) {
    session.structuredOutput = undefined;
    session.structuredOutputRequestId = structuredRequestId;
  }
  // Claimed alongside the running status and before the first await, so a retry
  // that arrives while this turn is still setting up already sees `processing`.
  if (dispatchRequestId) {
    recordPromptDispatch(sessionId, dispatchRequestId, "processing");
  }
  // Claim the transcript before any await. A session materialized from disk by
  // `reconcilePersistedSessions` still reports `persistedMessagesLoaded ===
  // false`; leaving it false would let a concurrent `GET /:id/messages` replace
  // `session.messages` (and `taskRegistry`) out from under this turn.
  const needsTranscriptHydration = session.persistedMessagesLoaded === false;
  session.persistedMessagesLoaded = true;
  // Set when the pre-turn read fails. The claim above is still correct for the
  // duration of the turn, but leaving it set afterwards would hide the on-disk
  // history until the bridge restarted, so the turn's `finally` clears it.
  let transcriptHydrationFailed = false;
  // Create abort controller for this query
  const abortController = new AbortController();
  session.abortController = abortController;
  // Claimed with the controller: from here this turn owns the foreground, and
  // any turn still alive from an earlier release must stop reclaiming it.
  const turnGeneration = nextTurnGeneration();
  session.latestTurnGeneration = turnGeneration;
  session.status = "running";
  session.completionBlockedByBackgroundTasks = false;
  // Preserve the original user-turn clock across bridge-internal re-prompts.
  session.turnStartedAt ??= new Date().toISOString();
  // The UI maps its plan-mode toggle onto exactly these two permission modes,
  // so a prompt carrying one of them is an authoritative statement of the
  // toggle. Recording it here is a safety net behind the explicit preferences
  // endpoint (e.g. a toggle made before this session had a durable identity).
  // Other permission modes say nothing about the toggle and are left alone.
  if (
    (options?.permissionMode === "plan" || options?.permissionMode === "bypassPermissions") &&
    session.planMode !== (options.permissionMode === "plan")
  ) {
    try {
      await applySessionPlanMode(session, options.permissionMode === "plan");
      if (sessions.get(sessionId) !== session || session.deleting) {
        throw sessionOperationError(
          "conflict",
          "Session became unavailable before the prompt could start",
        );
      }
    } catch (error) {
      // No SDK query exists yet, so this is an unambiguous failed startup.
      // Restore every reservation made above and leave the request id retryable.
      if (sessions.get(sessionId) === session && !session.deleting) {
        if (session.abortController === abortController) {
          abortController.abort();
          session.abortController = abortControllerBeforeStartup;
        }
        // This turn never reached the SDK, so it must hand the foreground back
        // to whichever turn held it — including a released one still running.
        if (session.latestTurnGeneration === turnGeneration) {
          session.latestTurnGeneration = latestTurnGenerationBeforeStartup;
        }
        session.status = statusBeforeStartup;
        session.turnStartedAt = turnStartedAtBeforeStartup;
        session.error = errorBeforeStartup;
        session.lastActivity = lastActivityBeforeStartup;
        session.persistedMessagesLoaded = persistedMessagesLoadedBeforeStartup;
        session.structuredOutput = structuredOutputBeforeStartup;
        session.structuredOutputRequestId = structuredOutputRequestIdBeforeStartup;
      }
      if (dispatchRequestId) {
        forgetPromptDispatch(sessionId, dispatchRequestId);
      }
      throw error;
    }
  }
  session.error = undefined;
  session.lastActivity = new Date();
  // A suggestion belongs to the turn that produced it. Nothing else clears it,
  // and `GET /session/:id` replays it on every mount, restore and reconnect, so
  // without this the user is handed a stale follow-up turns later.
  if (session.promptSuggestion !== undefined) {
    session.promptSuggestion = undefined;
    eventEmitter.emit({
      type: "session.updated",
      sessionId,
      data: { promptSuggestion: null },
    });
  }
  if (needsTranscriptHydration) {
    try {
      const hydrated = await readPersistedSessionMessagesOnce(session);
      if (hydrated) {
        session.messages = hydrated.messages;
        session.taskRegistry = hydrated.taskRegistry;
        session.backgroundTasks = hydrated.backgroundTasks;
      }
    } catch (error) {
      // A turn that cannot read its own history is not a debug-level event: the
      // transcript the user is looking at is incomplete until the retry lands.
      transcriptHydrationFailed = true;
      console.error(
        "[session-manager] Failed to hydrate transcript before prompt:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  // Build the display prompt (what the user sees) - includes all attachment references
  let displayPrompt = prompt;
  if (options?.attachments && options.attachments.length > 0) {
    const attachmentTags = options.attachments.map(attachmentTag).join("\n");
    displayPrompt = `${prompt}\n\n<attached-files>\n${attachmentTags}\n</attached-files>`;
  }
  // Build the SDK text prompt - excludes image attachments since those are sent as
  // inline base64 content blocks (bypassing the Read tool's 2000x2000 pixel limit).
  // File attachments are still included as XML tags so Claude can read them.
  let sdkTextPrompt = prompt;
  const fileAttachments = options?.attachments?.filter((att) => att.type !== "image") ?? [];
  if (fileAttachments.length > 0) {
    const fileTags = fileAttachments.map(attachmentTag).join("\n");
    sdkTextPrompt = `${prompt}\n\n<attached-files>\n${fileTags}\n</attached-files>`;
  }
  // Build the final prompt for the SDK - includes planning mode instruction if enabled
  let finalPrompt = sdkTextPrompt;
  // If plan mode is enabled, instruct Claude to use the EnterPlanMode tool
  // This uses Claude's native planning mode which allows read-only exploration
  if (options?.permissionMode === "plan") {
    // The SDK injects its own read-only enforcement preamble + ExitPlanMode protocol
    // when permissionMode === "plan". We append guidance on *how* to plan well.
    const planModeInstruction = `<system-reminder>
The user has enabled PLANNING MODE via the UI. You are in plan mode.
Use this phase to:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Design a concrete implementation strategy
5. When ready, call ExitPlanMode with your plan to present it for approval
Plan mode is read-only: do not write or edit files until the user approves your plan via ExitPlanMode.
</system-reminder>
`;
    finalPrompt = planModeInstruction + sdkTextPrompt;
  }
  // Add user message with displayPrompt (what the user sees, without planning mode instruction).
  // Re-prompts (e.g. after plan rejection) use role "system" so they don't appear as user-typed.
  const messageRole = options?._isReprompt ? "system" : "user";
  const userMessage: NormalizedMessage = {
    id: generateMessageId(),
    role: messageRole,
    content: displayPrompt,
    parts: [{ type: "text", content: displayPrompt }],
    createdAt: new Date().toISOString(),
  };
  session.messages.push(userMessage);
  eventEmitter.emit({
    type: "message.updated",
    sessionId,
    data: { message: userMessage },
  });
  eventEmitter.emit({
    type: "session.updated",
    sessionId,
    data: {
      status: "running",
      turnStartedAt: session.turnStartedAt,
      completionBlockedByBackgroundTasks: false,
    },
  });

  const startedAt = Date.now();
  let lastSdkMessageAt = Date.now();
  let sdkMessageCount = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let earlyWarningTimeout: ReturnType<typeof setTimeout> | null = null;
  let queryIteratorControl: SessionState["queryControl"];
  let structuredUsageRefresh: StructuredUsageRefreshCoordinator | undefined;
  let queryStarted = false;
  let closeSdkInput: (() => void) | undefined;
  let finishTurnInputForThisTurn: (() => void) | undefined;
  let turnReleasedToBackgroundTasks = false;
  let releasedTurnStartedAt: string | undefined;
  // Armed while a released turn is waiting for the continuation a background
  // task notification triggers, so the `finally` can always disarm it.
  let retainedContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  // Hoisted out of the `try` so the error path can still publish whatever the
  // coalescing window was holding. Null until the streaming state it closes
  // over exists, which is everything before the SDK query is created.
  const stream = createPromptStreamState(session, sessionId, {
    flushIntervalMs: STREAM_EVENT_COALESCE_MS,
    maxBlockIndex: MAX_STREAM_CONTENT_BLOCK_INDEX,
  });
  const { toolTracker, taskRegistry, activeTaskIds } = stream;
  const recordInterruptedStructuredOutputIfCurrent = () => {
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
  };

  try {
    // Create the query with Claude Agent SDK
    // Determine effort level: default to "high" if not specified
    const effortLevel = options?.effort ?? "high";
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    // This allows the Claude SDK to operate on the actual project directory
    const cwd = process.env.CWD || process.cwd();

    // Load MCP servers and plugins from config files. Both resolutions read
    // the same on-disk config, so they run concurrently and each merges once.
    const [{ servers: mcpServers, names: mcpServerNames }, plugins] = await Promise.all([
      getMcpRuntimeConfig(cwd),
      getPluginsForSdk(cwd),
    ]);

    const mcpServerCount = Object.keys(mcpServers).length;
    const pluginCount = plugins.length;
    // Determine permission mode: use provided option or default to "bypassPermissions".
    // Why: when the user requests "plan" mode we forward it as the SDK's actual
    // `"plan"` permissionMode. The SDK enforces read-only and runs its built-in
    // ExitPlanMode tool natively — without this, ExitPlanMode fails because the
    // CLI has no plan-mode state to exit.
    const permissionMode = options?.permissionMode ?? "bypassPermissions";

    const fastMode = options?.fastMode === true;

    debugLog("[session-manager] Starting query", {
      sessionId,
      cwd,
      model: options?.model,
      resume: session.sdkSessionId ?? null,
      effortLevel,
      permissionMode,
      fastMode,
      mcpServerCount,
      mcpServerNames: Array.from(mcpServerNames),
      pluginCount,
      pluginPaths: plugins.map((p) => p.path),
    });
    const envPath = process.env.PATH;
    debugLog("[session-manager] SDK env PATH", { path: envPath });
    const sdkPrompt = await buildSdkPrompt(
      finalPrompt,
      options?.attachments,
      cwd,
      testHooks?.afterAttachmentSymlinkValidation,
      testHooks?.afterAttachmentCanonicalValidation,
      testHooks?.afterAttachmentInitialValidation,
    );
    const heldSdkPrompt = holdSdkPromptOpen(sdkPrompt, abortController.signal);
    closeSdkInput = heldSdkPrompt.close;
    let receivedResult = false;
    const ownsActiveTurn = () =>
      !abortController.signal.aborted &&
      sessions.get(sessionId) === session &&
      session.abortController === abortController;
    const setCompletionBlockedByBackgroundTasks = (blocked: boolean) => {
      if (!ownsActiveTurn()) return;
      if (session.completionBlockedByBackgroundTasks === blocked) return;
      session.completionBlockedByBackgroundTasks = blocked;
      eventEmitter.emit({
        type: "session.updated",
        sessionId,
        data: { completionBlockedByBackgroundTasks: blocked },
      });
    };
    const hasLiveTaskOwnedByThisQuery = () =>
      (Object.values(session.backgroundTasks ?? {}) as BackgroundTaskSnapshot[]).some(
        (task) =>
          LIVE_BACKGROUND_TASK_STATUSES.has(task.status) &&
          session.backgroundTaskControls?.get(task.id) === queryIteratorControl,
      );
    const hasBackgroundTaskCandidateOwnedByThisQuery = () =>
      Array.from(session.backgroundTaskCandidates?.values() ?? []).includes(queryIteratorControl!);
    const scheduleTitleGeneration = () => {
      const isDefaultTitle = session.title === `Session ${session.id.slice(-6)}`;
      if (isDefaultTitle && !options?._isReprompt && !session.titleGenerationPending) {
        session.titleGenerationPending = true;
        void generateAndSetSessionTitle(sessionId, prompt);
      }
    };
    const releaseCompletedTurnToBackgroundTasks = (backgroundTasksRunning: boolean) => {
      if (turnReleasedToBackgroundTasks || !ownsActiveTurn()) return;
      turnReleasedToBackgroundTasks = true;
      scheduleTitleGeneration();
      releasedTurnStartedAt = session.turnStartedAt;
      session.status = "idle";
      session.turnStartedAt = undefined;
      session.abortController = undefined;
      session.completionBlockedByBackgroundTasks = false;
      if (session.queryControl === queryIteratorControl) {
        session.queryControl = undefined;
      }
      if (dispatchRequestId) {
        recordPromptDispatch(sessionId, dispatchRequestId, "already-processed");
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
    };
    // The retained control is closed only by the paths that legitimately end
    // the turn — a continuation result, session teardown, or the watchdog
    // below. Everything else must find it, so retention is a tracked reference
    // rather than an absent one.
    const stopWaitingForContinuation = () => {
      if (retainedContinuationTimer) {
        clearTimeout(retainedContinuationTimer);
        retainedContinuationTimer = null;
      }
      if (queryIteratorControl) {
        forgetRetainedQueryControl(session, queryIteratorControl);
      }
    };
    // A silence watchdog, not a turn deadline: every frame received while it is
    // armed pushes it out again, so a slow continuation is never cut off.
    // Without a bound, a provider that answers the notification with nothing
    // would hold this query's stdin — and its CLI child — open forever.
    const armContinuationWatchdog = () => {
      if (retainedContinuationTimer) clearTimeout(retainedContinuationTimer);
      retainedContinuationTimer = setTimeout(() => {
        retainedContinuationTimer = null;
        if (hasLiveTaskOwnedByThisQuery() || hasBackgroundTaskCandidateOwnedByThisQuery()) {
          // Another task this query owns is still running, which is its own
          // reason to hold stdin open — closing it here would kill that task.
          // The control is reachable through `backgroundTaskControls` while
          // that is true, so only the bound needs re-arming.
          armContinuationWatchdog();
          return;
        }
        console.warn(
          "[session-manager] No continuation after a background task notification; releasing the retained query",
          { sessionId },
        );
        stopWaitingForContinuation();
        // No edge can arrive on a query that has gone silent this long. The
        // parked snapshots are already absent from the live set, so dropping
        // them only releases metadata that now has nothing to attach to.
        forgetSettlingBackgroundTasksOwnedBy(session, queryIteratorControl);
        heldSdkPrompt.close();
        closeQueryControlIfUnused(session, queryIteratorControl);
      }, testHooks?.retainedContinuationTimeoutMs ?? RETAINED_CONTINUATION_TIMEOUT_MS);
    };
    const waitForContinuationAfterNotification = () => {
      if (!queryIteratorControl) return;
      retainQueryControl(session, queryIteratorControl);
      armContinuationWatchdog();
    };
    const reclaimReleasedTurnForAssistant = (message: SdkMessageBase) => {
      if (!turnReleasedToBackgroundTasks || ownsActiveTurn()) return;
      const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
      if (
        !isRootAssistantRecord(
          parentToolUseId,
          (message as { isSidechain?: unknown }).isSidechain,
        ) ||
        sessions.get(sessionId) !== session ||
        session.deleting ||
        // Releasing lets a follow-up turn start, so more than one turn can be
        // mid-flight. Only the newest may publish `running` and take abort
        // ownership; an older one doing so would point stop at the wrong CLI
        // and lock the newer turn out of its own reclaim.
        session.latestTurnGeneration !== turnGeneration ||
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
      session.turnStartedAt = releasedTurnStartedAt ?? new Date().toISOString();
      session.abortController = abortController;
      session.queryControl = queryIteratorControl;
      // The continuation arrived, so `queryControl` references this handle
      // again and the standalone retention would only outlive its purpose.
      stopWaitingForContinuation();
      // This query can cross more than one result boundary: the resumed root
      // loop may launch another background task and need to release ownership
      // again. Treat each reclaim as the start of a fresh release cycle.
      turnReleasedToBackgroundTasks = false;
      eventEmitter.emit({
        type: "session.updated",
        sessionId,
        data: {
          status: "running",
          turnStartedAt: session.turnStartedAt,
          completionBlockedByBackgroundTasks: false,
        },
      });
    };
    const finishTurnInputIfSettled = () => {
      if (!receivedResult) return;
      const hasLiveTask = hasLiveTaskOwnedByThisQuery();
      if (hasLiveTask || hasBackgroundTaskCandidateOwnedByThisQuery()) {
        // The model turn is complete, but its CLI process owns work that must
        // survive the response boundary. Publish idle so a follow-up turn can
        // start, retain this query through backgroundTaskControls, and keep its
        // input open until the last task owned by this process settles.
        setCompletionBlockedByBackgroundTasks(false);
        releaseCompletedTurnToBackgroundTasks(hasLiveTask);
        return;
      }
      setCompletionBlockedByBackgroundTasks(false);
      // Nothing is owed to this query any more, so it must stop being retained
      // or `closeQueryControlIfUnused` would keep treating it as referenced.
      stopWaitingForContinuation();
      heldSdkPrompt.close();
    };
    finishTurnInputForThisTurn = finishTurnInputIfSettled;
    session.finishTurnInputIfSettled = finishTurnInputIfSettled;

    const queryEnvironment = await runtimeEnvironmentForAgentQuery();
    const queryIterator = query({
      prompt: heldSdkPrompt.prompt,
      options: {
        cwd,
        ...claudeExecutableOptions(),
        // The SDK replaces (rather than merges) the CLI environment when this
        // option is present. The snapshot therefore carries every ordinary
        // bridge variable plus the latest managed GitHub credential.
        env: queryEnvironment,
        model: options?.model,
        agent: options?.agent,
        ...(options?.outputSchema
          ? {
              outputFormat: {
                type: "json_schema" as const,
                schema: options.outputSchema,
              },
            }
          : {}),
        permissionMode,
        // Required when using bypassPermissions mode
        ...(permissionMode === "bypassPermissions" && { allowDangerouslySkipPermissions: true }),
        // Use effort level to control thinking depth (replaces maxThinkingTokens)
        ...(effortLevel && { effort: effortLevel }),
        // Opus 4.7 defaults adaptive thinking display to "omitted" (signature only,
        // redacted text). Opt back into "summarized" so thinking content renders in the UI.
        thinking: { type: "adaptive", display: "summarized" },
        includePartialMessages: true,
        // Preserve the full nested transcript. Every forwarded subagent block
        // carries parent_tool_use_id and is rendered inside its Agent card.
        forwardSubagentText: true,
        allowedTools: [
          "Read",
          "Edit",
          "Write",
          "Bash",
          "Glob",
          "Grep",
          "WebSearch",
          "WebFetch",
          "AskUserQuestion",
          "Task",
          "Agent",
          // Allow all MCP tools
          "mcp:*",
        ],
        abortController,
        // A deterministic UUID makes the bridge id recoverable from the SDK's
        // persisted session store after a bridge restart.
        ...(session.sdkSessionId
          ? { resume: session.sdkSessionId }
          : {
              sessionId: sdkSessionIdFromBridgeId(session.id) ?? crypto.randomUUID(),
            }),
        enableFileCheckpointing: true,
        promptSuggestions: options?.promptSuggestions === true,
        agentProgressSummaries: true,
        // Use Claude Code system prompt with additional instructions
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "IMPORTANT: You MUST read a file before editing or writing to it. The Edit and Write tools will fail if you have not first used the Read tool to read the file in this conversation. Always read files before attempting to modify them.",
        },
        // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
        // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
        settingSources: options?.includeLocalSettings
          ? ["user", "project", "local"]
          : ["user", "project"],
        // Fast mode is a Claude Code setting (Opus 4.6 priority service tier).
        // Pass it through the flag-layer settings so the user can opt in per prompt.
        ...(fastMode && { settings: { fastMode: true } }),
        // Also pass MCP servers explicitly for any project-local .mcp.json overrides
        mcpServers: mcpServerCount > 0 ? mcpServers : undefined,
        // Load plugins from user config
        plugins: pluginCount > 0 ? plugins : undefined,
        // Pinned against @anthropic-ai/claude-agent-sdk 0.3.228: although the
        // SDK warns that bypassPermissions shadows canUseTool for ordinary
        // tool permission checks, AskUserQuestion is a special case. A live
        // contract probe confirmed it still reaches this callback and the SDK
        // waits for the returned promise. This is therefore the future input-
        // request enforcement hook, but it is NOT sufficient for unattended
        // command/file/permission approvals; those need a PreToolUse hook or an
        // equivalent provider-authoritative policy path.
        // Handle AskUserQuestion tool to get user input.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        canUseTool: async (toolName: string, input: any) => {
          if (toolName === "AskUserQuestion") {
            const questions: QuestionInfo[] = Array.isArray(input.questions) ? input.questions : [];
            const questionTexts = questions.map((question) => question.question);
            if (new Set(questionTexts).size !== questionTexts.length) {
              // The Agent SDK answer contract is Record<questionText, string>.
              // Duplicate text cannot be represented without silently
              // overwriting one answer, so fail closed and let Claude ask again
              // with distinct wording.
              return {
                behavior: "deny" as const,
                message:
                  "AskUserQuestion contains duplicate question text. Ask the questions again with distinct wording.",
              };
            }
            // Create a question request and wait for user answer
            const questionId = generateMessageId();
            const questionRequest: QuestionRequest = {
              id: questionId,
              sessionId,
              questions,
              toolUseId: questionId,
              expiresAt: Date.now() + QUESTION_TIMEOUT_MS,
            };

            // Store the question
            pendingQuestions.set(questionId, questionRequest);

            // Emit event so frontend knows to show the question
            eventEmitter.emit({
              type: "question.asked",
              sessionId,
              data: questionRequest,
            });

            // Wait for answer with a Promise that can be resolved externally
            const answerPromise = new Promise<Record<string, string>>((resolve, reject) => {
              questionResolvers.set(questionId, { resolve, reject });
            });

            let questionTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              questionTimeoutId = setTimeout(() => {
                reject(new Error("Question timed out after 5 minutes"));
              }, QUESTION_TIMEOUT_MS);
            });

            try {
              const answers = await Promise.race([answerPromise, timeoutPromise]);
              console.log("[session-manager] Received question answers", {
                questionId,
                answerCount: Object.keys(answers).length,
              });

              // Return the answers to the SDK
              return {
                behavior: "allow" as const,
                updatedInput: {
                  questions: input.questions,
                  answers,
                },
              };
            } catch (error) {
              console.error("[session-manager] Error waiting for answer:", error);
              const message = error instanceof Error ? error.message : "Question was cancelled";
              if (pendingQuestions.has(questionId)) {
                eventEmitter.emit({
                  type: "question.answered",
                  sessionId,
                  data: { requestId: questionId, cancelled: true },
                });
              }
              return { behavior: "deny" as const, message };
            } finally {
              // Cleanup
              if (questionTimeoutId) clearTimeout(questionTimeoutId);
              pendingQuestions.delete(questionId);
              questionResolvers.delete(questionId);
            }
          }

          // Handle EnterPlanMode - emit event so frontend can update plan mode state
          if (toolName === "EnterPlanMode") {
            debugLog("[session-manager] EnterPlanMode requested", { sessionId });

            // The agent itself switched the session into plan mode; record it
            // like a user toggle so the preference survives a restart.
            try {
              await applySessionPlanMode(session, true);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Failed to persist plan mode";
              return {
                behavior: "deny" as const,
                message: `Plan mode could not be persisted safely: ${message}`,
              };
            }

            // Emit event so frontend knows to enter plan mode
            eventEmitter.emit({
              type: "plan.enter-requested",
              sessionId,
              data: { sessionId },
            });

            // Allow the tool to proceed
            return {
              behavior: "allow" as const,
              updatedInput: input,
            };
          }

          // Handle ExitPlanMode - wait for user approval before allowing
          if (toolName === "ExitPlanMode") {
            debugLog("[session-manager] ExitPlanMode requested, waiting for user approval", {
              sessionId,
            });

            // Create a plan approval request and wait for user decision
            const approvalId = generateMessageId();
            const approvalRequest: PlanApprovalRequest = {
              id: approvalId,
              sessionId,
              toolUseId: approvalId,
              expiresAt: Date.now() + PLAN_APPROVAL_TIMEOUT_MS,
            };

            // Store the approval request and set up the resolver BEFORE emitting,
            // so an instant response from the UI can never find a missing resolver.
            pendingPlanApprovals.set(approvalId, approvalRequest);

            const approvalPromise = new Promise<PlanApprovalResponse>((resolve, reject) => {
              planApprovalResolvers.set(approvalId, { resolve, reject });
            });

            // Emit event so frontend knows to show the approval UI
            eventEmitter.emit({
              type: "plan.approval-requested",
              sessionId,
              data: approvalRequest,
            });

            let approvalTimeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeoutPromise = new Promise<never>((_, reject) => {
              approvalTimeoutId = setTimeout(() => {
                reject(new Error("Plan approval timed out after 5 minutes"));
              }, PLAN_APPROVAL_TIMEOUT_MS);
            });

            try {
              const response = await Promise.race([approvalPromise, timeoutPromise]);
              console.log("[session-manager] Plan approval result", {
                approvalId,
                approved: response.approved,
                hasFeedback: typeof response.feedback === "string" && response.feedback.length > 0,
              });

              if (response.approved) {
                // User approved - emit exit event and allow the tool.
                // Mark `stream.planApprovedThisTurn` so the fallback below can detect
                // the case where the SDK still fails the ExitPlanMode tool
                // (override the failure + re-prompt Claude to continue).
                // Approval ends plan mode; record it so the preference the
                // next prompt rehydrates from matches what the UI shows.
                try {
                  await applySessionPlanMode(session, false);
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : "Failed to persist plan mode";
                  return {
                    behavior: "deny" as const,
                    message: `Plan mode could not be exited safely: ${message}`,
                  };
                }
                stream.planApprovedThisTurn = true;
                eventEmitter.emit({
                  type: "plan.exit-requested",
                  sessionId,
                  data: { sessionId },
                });

                return {
                  behavior: "allow" as const,
                  updatedInput: input,
                };
              } else {
                // User rejected - deny the tool and include feedback if provided.
                // Also capture the feedback so we can re-prompt Claude if the SDK
                // ends the turn after the denial (ExitPlanMode denial may terminate
                // the agent loop without Claude generating a revision).
                const feedbackMessage = response.feedback
                  ? `User feedback: "${response.feedback}"`
                  : "No specific feedback was provided.";
                const denyMessage = `User rejected the plan. ${feedbackMessage} Please revise your approach based on this feedback.`;

                // Store the raw feedback for potential re-prompt
                stream.pendingPlanRejectionFeedback = response.feedback
                  ? `I've reviewed the plan and I'd like changes: ${response.feedback}\n\nPlease revise the plan based on this feedback.`
                  : `I've reviewed the plan and I don't approve it as-is. Please revise your approach.`;

                return {
                  behavior: "deny" as const,
                  message: denyMessage,
                };
              }
            } catch (error) {
              console.error("[session-manager] Error waiting for plan approval:", error);
              const errorMessage =
                error instanceof Error ? error.message : "Plan approval was cancelled";
              if (pendingPlanApprovals.has(approvalId)) {
                eventEmitter.emit({
                  type: "plan.approval-responded",
                  sessionId,
                  data: {
                    requestId: approvalId,
                    approved: false,
                    cancelled: true,
                  },
                });
              }
              // If error (e.g., timeout or dismissed), deny the tool use
              return { behavior: "deny" as const, message: errorMessage };
            } finally {
              // Cleanup
              if (approvalTimeoutId) clearTimeout(approvalTimeoutId);
              pendingPlanApprovals.delete(approvalId);
              planApprovalResolvers.delete(approvalId);
            }
          }

          // Allow all other tools - pass input through unchanged
          return { behavior: "allow" as const, updatedInput: input };
        },
      },
    });
    session.queryControl = queryIterator;
    queryIteratorControl = queryIterator;
    queryStarted = true;
    testHooks?.onQueryStarted?.();
    let supportedAgents: NonNullable<SessionInitData["agents"]> = [];
    if (typeof queryIterator.supportedAgents === "function") {
      try {
        supportedAgents = (await queryIterator.supportedAgents()).map((agent) => ({
          name: agent.name,
          description: agent.description,
          model: agent.model,
        }));
      } catch (error) {
        debugLog("[session-manager] Agent discovery unavailable:", error);
      }
    }

    structuredUsageRefresh = createStructuredUsageRefreshCoordinator(session, queryIterator);
    // Prime the limits panel as soon as the live control channel is ready.
    // This intentionally runs off the SDK message-consumer path.
    void structuredUsageRefresh?.trigger();

    // Log an early warning if SDK doesn't respond within 5 seconds
    earlyWarningTimeout = setTimeout(() => {
      if (sdkMessageCount === 0) {
        console.warn("[session-manager] SDK has not responded after 5 seconds", {
          sessionId,
          cwd,
          model: options?.model,
          status: session.status,
        });
      }
    }, 5000);

    heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastSdkMessageAt;
      if (idleMs > 15000) {
        console.warn("[session-manager] No SDK messages yet", {
          sessionId,
          idleMs,
          sdkMessageCount,
          status: session.status,
        });
      }
    }, 15000);

    // Process the async generator
    for await (const message of queryIterator) {
      if (abortController.signal.aborted) {
        break;
      }

      sdkMessageCount += 1;
      lastSdkMessageAt = Date.now();
      // Any frame is evidence the provider is still answering the notification,
      // so the watchdog is pushed out rather than allowed to expire mid-stream.
      // Retention itself is dropped by the reclaim, the result, or the watchdog
      // firing — never by liveness alone.
      if (retainedContinuationTimer) armContinuationWatchdog();
      // Fires once per streamed delta — i.e. per token. Both the object
      // literal and the write are guarded, not just the write.
      if (isDebugLoggingEnabled) {
        debugLog("[session-manager] SDK event received", {
          sessionId,
          type: message.type,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          subtype: (message as any)?.subtype,
          sdkMessageCount,
        });
      }

      // Deltas are coalesced; everything else must observe them in order, so
      // settle the pending snapshot before handling a non-delta message.
      if (message.type !== "stream_event") stream.flushStreamedAssistantMessage();

      // SDKUserMessage.timestamp is optional (older emitters omit it). Capture
      // one receive-time clock for a record that can carry transcript content,
      // so a terminal tool result still records where its card settled. Do not
      // allocate an ISO string for each token-sized stream event.
      const receivedAt =
        message.type === "assistant" || message.type === "user"
          ? new Date().toISOString()
          : undefined;

      // Handle different message types from SDK
      if (message.type === "system" && message.subtype === "init") {
        // Store the SDK session ID for resume functionality
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const initMsg = message as any;
        const sdkSessionId = initMsg.session_id;
        if (sdkSessionId) {
          const gainedDurableIdentity = session.sdkSessionId !== sdkSessionId;
          session.sdkSessionId = sdkSessionId;
          debugLog("[session-manager] Session initialized, stored SDK session ID:", sdkSessionId);
          // A plan-mode preference set before the first turn had no durable key
          // to be written under; the id assigned here is that key.
          if (gainedDurableIdentity) await persistSessionMetadata(session);
        }

        // Capture MCP servers and plugins from init message
        // Note: Claude SDK sends MCP-provided plugins as MCP servers with "plugin:" prefix
        const allMcpServers = initMsg.mcp_servers || [];

        // Separate regular MCP servers from plugin-type MCP servers
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const regularMcpServers = allMcpServers.filter((s: any) => !s.name?.startsWith("plugin:"));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pluginMcpServers = allMcpServers.filter((s: any) => s.name?.startsWith("plugin:"));

        const mcpServerStatuses: McpServerRuntimeStatus[] = regularMcpServers.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (s: any) => ({
            name: s.name,
            status: s.status === "connected" ? "connected" : "failed",
            error: s.error,
            tools: s.tools,
          }),
        );

        // Convert plugin-type MCP servers to plugin statuses
        // Also include any traditional plugins from initMsg.plugins
        const pluginStatuses: PluginRuntimeStatus[] = [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...pluginMcpServers.map((s: any) => ({
            name: s.name,
            path: undefined,
            status: (s.status === "connected" ? "loaded" : "failed") as "loaded" | "failed",
            error: s.error,
          })),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...(initMsg.plugins || []).map((p: any) => ({
            name: p.name,
            path: p.path,
            status: (p.status === "loaded" ? "loaded" : "failed") as "loaded" | "failed",
            error: p.error,
          })),
        ];

        // Store init data in session
        session.initData = {
          mcpServers: mcpServerStatuses,
          plugins: pluginStatuses,
          slashCommands: initMsg.slash_commands,
          agents: supportedAgents,
        };

        debugLog("[session-manager] Session init data captured", {
          sessionId,
          mcpServerCount: mcpServerStatuses.length,
          pluginCount: pluginStatuses.length,
          slashCommandCount: initMsg.slash_commands?.length ?? 0,
        });

        // Emit session.init event so frontend can update UI
        eventEmitter.emit({
          type: "session.init",
          sessionId,
          data: session.initData,
        });
      } else if (isSdkCompactBoundaryMessage(message as SdkMessageBase)) {
        // Handle /compact command result
        const compactMsg = message as SdkCompactBoundaryMessage;
        const compactMetadata = compactMsg.compact_metadata || {};

        debugLog("[session-manager] Compact boundary received", {
          sessionId,
          preTokens: compactMetadata.pre_tokens,
          trigger: compactMetadata.trigger,
        });

        // Emit event so frontend can show feedback
        eventEmitter.emit({
          type: "system.compact",
          sessionId,
          data: {
            preTokens: compactMetadata.pre_tokens,
            postTokens: compactMetadata.post_tokens,
            trigger: compactMetadata.trigger,
          },
        });
      } else if (message.type === "prompt_suggestion") {
        const suggestion =
          typeof (message as { suggestion?: unknown }).suggestion === "string"
            ? (message as { suggestion: string }).suggestion.trim()
            : "";
        if (suggestion) {
          session.promptSuggestion = suggestion;
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: { promptSuggestion: suggestion },
          });
        }
      } else if (message.type === "rate_limit_event") {
        const info = (
          message as {
            rate_limit_info?: {
              rateLimitType?: string;
              utilization?: number;
              resetsAt?: number;
            };
          }
        ).rate_limit_info;
        if (info) {
          const label = (info.rateLimitType ?? "usage")
            .replaceAll("_", " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
          const nextWindow: SessionRateLimitWindow = {
            label,
            usedPercent: info.utilization,
            resetsAt: rateLimitResetToIso(info.resetsAt),
          };
          // Held on the session, not inside `usage`. Rate-limit events arrive
          // mid-turn and `usage` only exists after the first `result`, so
          // gating on it discarded every window a first turn reported.
          const existing = session.rateLimits ?? session.usage?.rateLimits ?? [];
          session.rateLimits = [
            ...existing.filter((window: SessionRateLimitWindow) => window.label !== label),
            nextWindow,
          ];
          if (session.usage) {
            session.usage = {
              ...session.usage,
              rateLimits: session.rateLimits,
              updatedAt: new Date().toISOString(),
            };
          }
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: {
              rateLimits: session.rateLimits,
              ...(session.usage ? { contextUsage: session.usage } : {}),
            },
          });
          // The notification is often only a threshold edge with no
          // utilization. Use it as a signal to fetch the complete `/usage`
          // snapshot, but never pause the SDK iterator while doing so.
          void structuredUsageRefresh?.trigger();
        }
      } else if (message.type === "system") {
        // Handle other system messages (log for debugging)
        const sysMsg = message as SdkSystemMessage;
        debugLog("[session-manager] System message received", {
          sessionId,
          subtype: sysMsg.subtype,
        });

        const taskMessage = message as {
          subtype?: string;
          task_id?: string;
          tool_use_id?: string;
          description?: string;
          summary?: string;
          /** Only on `task_notification`; the terminal edge of a task. */
          status?: "completed" | "failed" | "stopped";
          /** Only on `background_tasks_changed`; the full live set. */
          tasks?: Array<{
            task_id?: string;
            task_type?: string;
            description?: string;
          }>;
          patch?: {
            status?: BackgroundTaskSnapshot["status"];
            description?: string;
            end_time?: number;
            error?: string;
            is_backgrounded?: boolean;
          };
        };

        const emitBackgroundTasks = () => {
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: { backgroundTasks: session.backgroundTasks },
          });
        };

        if (
          (taskMessage.subtype === "task_started" ||
            taskMessage.subtype === "task_progress" ||
            taskMessage.subtype === "task_updated") &&
          taskMessage.task_id
        ) {
          const correlated = takeProvisionalBackgroundTask(session, taskMessage.tool_use_id);
          const previous = session.backgroundTasks?.[taskMessage.task_id] ?? correlated.task;
          const patchedStatus = taskMessage.patch?.status ?? previous?.status ?? "running";
          // Task ids are process-unique. Because level and edge messages may
          // be delivered in either order, a late start/progress edge must
          // enrich a terminal record rather than resurrect it.
          const status =
            previous &&
            !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status) &&
            LIVE_BACKGROUND_TASK_STATUSES.has(patchedStatus)
              ? previous.status
              : patchedStatus;
          const task: BackgroundTaskSnapshot = {
            id: taskMessage.task_id,
            toolUseId: taskMessage.tool_use_id ?? previous?.toolUseId,
            description:
              taskMessage.patch?.description ?? taskMessage.description ?? previous?.description,
            status,
            isBackgrounded: taskMessage.patch?.is_backgrounded ?? previous?.isBackgrounded,
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: taskMessage.patch?.end_time ?? previous?.endedAt,
            error: taskMessage.patch?.error ?? previous?.error,
          };
          session.backgroundTasks = boundBackgroundTaskHistory({
            ...session.backgroundTasks,
            [task.id]: task,
          });
          if (LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) {
            (session.backgroundTaskControls ??= new Map()).set(task.id, queryIterator);
          } else {
            const owner = session.backgroundTaskControls?.get(task.id);
            session.backgroundTaskControls?.delete(task.id);
            closeQueryControlIfUnused(session, owner);
          }
          closeQueryControlIfUnused(session, correlated.owner);
          emitBackgroundTasks();
        } else if (taskMessage.subtype === "task_notification" && taskMessage.task_id) {
          // A task notification can re-enter the root agent loop after an
          // earlier result. That earlier result is only the response boundary
          // before the notification, not permission to close streaming input.
          // Wait for the resumed loop's own result; otherwise stdin EOF lands
          // between its final tool result and final assistant message and the
          // rollout records `[Request interrupted by user]`.
          receivedResult = false;
          // The terminal edge. Without it nothing ever leaves `running`, so
          // `GET /session/:id` reported a finished task as live indefinitely.
          const correlated = takeProvisionalBackgroundTask(session, taskMessage.tool_use_id);
          // A level signal that preceded this edge has already removed the task
          // from the live set; its parked snapshot is the only remaining source
          // of the original description and start time.
          const parked = takeSettlingBackgroundTask(session, taskMessage.task_id);
          const previous =
            session.backgroundTasks?.[taskMessage.task_id] ?? parked?.task ?? correlated.task;
          const terminalStatus: BackgroundTaskSnapshot["status"] =
            taskMessage.status === "failed"
              ? "failed"
              : taskMessage.status === "stopped"
                ? "killed"
                : "completed";
          const task: BackgroundTaskSnapshot = {
            id: taskMessage.task_id,
            toolUseId: taskMessage.tool_use_id ?? previous?.toolUseId,
            description: previous?.description ?? taskMessage.description ?? taskMessage.summary,
            status: terminalStatus,
            isBackgrounded: previous?.isBackgrounded,
            startedAt: previous?.startedAt ?? Date.now(),
            endedAt: Date.now(),
            error:
              terminalStatus === "failed"
                ? (taskMessage.summary ?? previous?.error)
                : previous?.error,
          };
          session.backgroundTasks = boundBackgroundTaskHistory({
            ...session.backgroundTasks,
            [task.id]: task,
          });
          const owner =
            session.backgroundTaskControls?.get(task.id) ?? parked?.owner ?? correlated.owner;
          session.backgroundTaskControls?.delete(task.id);
          // The notification is injected into the same root loop and may be
          // followed by another assistant/result boundary. `Query.close()` is
          // destructive (it terminates the CLI and suppresses later frames),
          // so a released query must stay alive until that boundary arrives.
          // A later result closes held input, while abort/delete still closes
          // the control explicitly.
          if (owner === queryIteratorControl && turnReleasedToBackgroundTasks) {
            waitForContinuationAfterNotification();
          } else {
            closeQueryControlIfUnused(session, owner);
          }
          emitBackgroundTasks();
        } else if (
          taskMessage.subtype === "background_tasks_changed" &&
          Array.isArray(taskMessage.tasks)
        ) {
          // A level signal replaces live membership only. Terminal bookends
          // are retained (within the bounded history) because the SDK permits
          // this level to arrive after the terminal edge for the same
          // transition; replacing the whole snapshot here erased failures and
          // could even resurrect the task as running.
          const replacement: Record<string, BackgroundTaskSnapshot> = Object.fromEntries(
            (
              Object.entries(session.backgroundTasks ?? {}) as Array<
                [string, BackgroundTaskSnapshot]
              >
            ).filter(([, task]) => !LIVE_BACKGROUND_TASK_STATUSES.has(task.status)),
          ) as Record<string, BackgroundTaskSnapshot>;
          const previousControls = session.backgroundTaskControls;
          const previousOwners = new Set(previousControls?.values() ?? []);
          const replacementControls = new Map<string, NonNullable<SessionState["queryControl"]>>();
          // The SDK documents this level signal as per-process. A follow-up
          // turn can therefore publish its own empty set while an older CLI is
          // still running a background Bash task. Preserve every live member
          // owned by another control; only this query's slice is replaced.
          const previouslyLiveOwnedByThisQuery: BackgroundTaskSnapshot[] = [];
          for (const [id, task] of Object.entries(session.backgroundTasks ?? {}) as Array<
            [string, BackgroundTaskSnapshot]
          >) {
            if (!LIVE_BACKGROUND_TASK_STATUSES.has(task.status)) continue;
            const owner = previousControls?.get(id);
            if (owner && owner !== queryIterator) {
              replacement[id] = task;
              replacementControls.set(id, owner);
              continue;
            }
            // Owned by this query (or by no handle at all, which only this
            // query can still speak for). Whether it survives depends on the
            // payload below.
            previouslyLiveOwnedByThisQuery.push(task);
          }
          for (const entry of taskMessage.tasks) {
            const id = entry?.task_id;
            if (typeof id !== "string" || id.length === 0) continue;
            const previous = session.backgroundTasks?.[id];
            if (previous && !LIVE_BACKGROUND_TASK_STATUSES.has(previous.status)) {
              replacement[id] = previous;
              continue;
            }
            replacement[id] = {
              id,
              toolUseId: previous?.toolUseId,
              description: entry.description ?? previous?.description,
              status: LIVE_BACKGROUND_TASK_STATUSES.has(previous?.status ?? "running")
                ? (previous?.status ?? "running")
                : "running",
              isBackgrounded: previous?.isBackgrounded ?? true,
              startedAt: previous?.startedAt ?? Date.now(),
            };
            // An id already owned by another live control keeps that owner:
            // only the process that started a task can stop it, and a control
            // asked to stop an id it never started answers `ok` without
            // reaching anything. This query claims genuinely new ids only.
            replacementControls.set(id, previousControls?.get(id) ?? queryIterator);
          }
          session.backgroundTasks = boundBackgroundTaskHistory(replacement);
          session.backgroundTaskControls =
            replacementControls.size > 0 ? replacementControls : undefined;
          // Anything this query owned that the level no longer lists has
          // stopped running, but the level says nothing about *how* it ended.
          // The edge that does is documented to arrive after this frame, so
          // the query still owes a continuation and must not be torn down
          // here — that close is what silently dropped the "I'll report back
          // when it finishes" reply the model had already promised.
          const droppedByThisQuery = previouslyLiveOwnedByThisQuery.filter(
            (task) => replacement[task.id] === undefined,
          );
          if (droppedByThisQuery.length > 0 && turnReleasedToBackgroundTasks) {
            for (const task of droppedByThisQuery) {
              parkSettlingBackgroundTask(session, task, queryIterator);
            }
            // Mirrors the `task_notification` branch: the earlier result is
            // only the boundary before this transition, not permission to
            // close streaming input. Closing it here lands stdin EOF between
            // the model's final tool result and its final assistant message,
            // which the rollout records as `[Request interrupted by user]`.
            receivedResult = false;
            waitForContinuationAfterNotification();
          }
          // Retention above is what keeps this query out of the close below:
          // `closeQueryControlIfUnused` treats a retained control as still in
          // use. Every other owner is closed exactly as before.
          for (const owner of previousOwners) {
            closeQueryControlIfUnused(session, owner);
          }
          emitBackgroundTasks();
        }
        finishTurnInputIfSettled();

        // Emit generic system event for other subtypes
        if (sysMsg.subtype && sysMsg.subtype !== "init") {
          eventEmitter.emit({
            type: "system.message",
            sessionId,
            data: {
              subtype: sysMsg.subtype,
              message: sysMsg,
            },
          });
        }
      } else if (message.type === "assistant") {
        reclaimReleasedTurnForAssistant(message as SdkMessageBase);

        // If we receive a new assistant message after a plan denial, it means
        // the SDK continued the agent loop and Claude did see the feedback.
        // Clear the pending feedback so we don't re-prompt unnecessarily.
        if (stream.pendingPlanRejectionFeedback) {
          debugLog(
            "[session-manager] Claude responded after plan denial, clearing re-prompt feedback",
            { sessionId },
          );
          stream.pendingPlanRejectionFeedback = null;
        }

        // Assistant message - parse content and register tools with tracker
        const { orderedParts, newTaskIds, contentBlockCount } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds,
          taskRegistry,
          receivedAt,
        );

        // A foreground Bash call can become background work after a timeout or
        // Ctrl+B. Keep that possibility hidden from the task snapshot, but
        // retain this query's control until the correlated provider result
        // tells us whether it actually happened.
        for (const toolUseId of bashToolUseIdsFromAssistantMessage(message)) {
          registerBackgroundTaskCandidate(session, toolUseId, queryIterator);
        }

        // Establish liveness from the invocation itself. The provider can emit
        // the turn result before its Bash tool_result or task lifecycle frames;
        // waiting for either of those edges recreates the stdin-close race that
        // kills the just-launched process. The provisional id is replaced by
        // the provider task id as soon as either later edge supplies it.
        for (const launch of provisionalBackgroundTaskLaunchesFromAssistantMessage(message)) {
          recordBackgroundTaskLaunch(session, launch, queryIterator);
        }

        // Update active Task tracking - add new Tasks
        for (const taskId of newTaskIds) {
          activeTaskIds.add(taskId);
        }

        // Group by API message id so these blocks land on top of the partial
        // events that streamed them (see `blocksByApiMessage`). The SDK sends one
        // assistant message per content block, all sharing `message.id`, so the
        // running finalized-block count gives each block its stream index.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const apiMessageId = (message as any).message?.id as string | undefined;
        const messageKey =
          apiMessageId ??
          (message.uuid as string | undefined) ??
          `assistant-${(stream.syntheticMessageKeyCounter += 1)}`;

        const blocks = stream.getBlocksForMessage(messageKey);
        const blockIndexBase = stream.finalizedBlockCountByApiMessage.get(messageKey) ?? 0;
        for (const part of orderedParts) {
          const blockIndex = blockIndexBase + (part.blockOffset ?? 0);
          const streamedPart = blocks.get(blockIndex);
          blocks.set(blockIndex, {
            ...part,
            timestamp: streamedPart?.timestamp ?? part.timestamp ?? receivedAt,
            messageUuid: messageKey,
          });
        }
        stream.finalizedBlockCountByApiMessage.set(messageKey, blockIndexBase + contentBlockCount);
        stream.rebuildAccumulatedOrderedParts();

        // Build final parts maintaining chronological order
        const finalParts = buildMessageParts(stream.accumulatedOrderedParts, toolTracker);
        // Derive content from the accumulated parts rather than this SDK message
        // alone. The SDK splits one API message into one `assistant` message per
        // content block, so `content` here only holds the current block's text and
        // would blank out the turn's text whenever the block is thinking/tool_use.
        const accumulatedContent = getMessageTextFromParts(finalParts);

        // The transcript uuid of the record this block was written to. The SDK
        // emits one `assistant` message per content block, each its own
        // transcript record; the latest is the inclusive end of this message,
        // which is what a fork boundary must point at.
        const sdkMessageUuid = (message as { uuid?: unknown }).uuid;
        const observedModel = (message as { message?: { model?: unknown } }).message?.model;
        const parentToolUseId = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
        const isRootAssistant = isRootAssistantRecord(
          parentToolUseId,
          (message as { isSidechain?: unknown }).isSidechain,
        );
        const modelId = isRootAssistant ? normalizeBackendModelId(observedModel) : undefined;
        if (!stream.currentAssistantMessage) {
          stream.currentAssistantMessage = {
            id: messageKey,
            role: "assistant",
            content: accumulatedContent,
            parts: finalParts,
            createdAt: new Date().toISOString(),
            ...(modelId ? { modelId } : {}),
            ...(typeof sdkMessageUuid === "string" ? { sdkUuid: sdkMessageUuid } : {}),
          };
          session.messages.push(stream.currentAssistantMessage);
          debugLog("[session-manager] Created assistant message", {
            sessionId,
            messageId: stream.currentAssistantMessage.id,
          });
        } else {
          stream.currentAssistantMessage.content = accumulatedContent;
          stream.currentAssistantMessage.parts = finalParts;
          if (modelId) {
            stream.currentAssistantMessage.modelId = modelId;
          }
          if (typeof sdkMessageUuid === "string") {
            stream.currentAssistantMessage.sdkUuid = sdkMessageUuid;
          }
          debugLog("[session-manager] Updated assistant message", {
            sessionId,
            messageId: stream.currentAssistantMessage.id,
          });
        }

        stream.emitCurrentAssistantMessage();
      } else if (message.type === "user") {
        // User message with tool results - parse to update tool tracker
        const { completedTaskIds } = parseMessageContent(
          message,
          toolTracker,
          mcpServerNames,
          activeTaskIds,
          taskRegistry,
          receivedAt,
        );

        const sdkUserMessage = message as SDKUserMessage;
        let settledProvisionalTask = false;
        for (const outcome of bashToolResultOutcomes(sdkUserMessage, toolTracker)) {
          if (outcome.launch) {
            recordBackgroundTaskLaunch(session, outcome.launch, queryIterator);
            continue;
          }
          if (outcome.retainCandidate) continue;
          takeBackgroundTaskCandidate(session, outcome.toolUseId);
          const provisionalId = provisionalBackgroundTaskId(outcome.toolUseId);
          const provisional = session.backgroundTasks?.[provisionalId];
          if (
            outcome.failed &&
            provisional &&
            LIVE_BACKGROUND_TASK_STATUSES.has(provisional.status)
          ) {
            settleBackgroundTask(
              session,
              provisionalId,
              "failed",
              "The Bash invocation failed before its background task was confirmed",
            );
            settledProvisionalTask = true;
          }
        }
        if (settledProvisionalTask) emitBackgroundTaskSnapshot(session);
        finishTurnInputIfSettled();

        // Update active Task tracking - remove completed Tasks
        for (const taskId of completedTaskIds) {
          activeTaskIds.delete(taskId);
        }

        // Defensive fallback: if the user approved the plan this turn but the
        // SDK still reported the ExitPlanMode tool as a failure, rewrite the
        // tracked tool to "success" so the UI doesn't show a red failure for
        // something the user explicitly approved. Capture a continuation
        // re-prompt so Claude doesn't just abandon the turn. See the comment
        // block where `stream.planApprovedThisTurn` is declared for full context.
        if (stream.planApprovedThisTurn) {
          for (const tool of toolTracker.getTools()) {
            if (
              tool.toolName === "ExitPlanMode" &&
              tool.toolState === "failure" &&
              tool.toolUseId
            ) {
              console.warn(
                "[session-manager] ExitPlanMode reported failure despite user approval — overriding to success and scheduling continuation re-prompt",
                { sessionId, toolUseId: tool.toolUseId, sdkError: tool.toolError },
              );
              toolTracker.updateToolResult(tool.toolUseId, {
                state: "success",
                output: "Plan approved by the user. Proceeding with implementation.",
                error: undefined,
              });
              if (!stream.pendingPlanApprovalContinuation) {
                stream.pendingPlanApprovalContinuation =
                  "The user has approved your plan. Please proceed with implementing it now. You are no longer in plan mode and may write, edit, and run commands as needed.";
              }
            }
          }
        }

        // Rebuild message parts with updated tool results
        if (stream.currentAssistantMessage) {
          const finalParts = buildMessageParts(stream.accumulatedOrderedParts, toolTracker);
          stream.currentAssistantMessage.parts = finalParts;

          stream.emitCurrentAssistantMessage();
        }
        // Skip adding user message replay as we already added it
      } else if (isSdkResultMessage(message as SdkMessageBase)) {
        // Query completed - log full result for debugging
        const resultMsg = message as SdkResultMessage;
        receivedResult = true;
        debugLog("[session-manager] Query result", {
          sessionId,
          subtype: resultMsg.subtype,
          result: resultMsg.result,
          costUSD: resultMsg.total_cost_usd,
          durationMs: resultMsg.duration_ms,
        });

        // The only authoritative link between the id this bridge minted for the
        // prompt and the transcript record it became. Everything destructive
        // (fork boundary, file rewind) resolves through it, so it is recorded
        // and republished rather than inferred from message ordering.
        if (
          typeof resultMsg.user_message_uuid === "string" &&
          resultMsg.user_message_uuid.length > 0 &&
          userMessage.sdkUuid !== resultMsg.user_message_uuid
        ) {
          userMessage.sdkUuid = resultMsg.user_message_uuid;
          eventEmitter.emit({
            type: "message.updated",
            sessionId,
            data: { message: userMessage },
          });
        }

        // Account allocation can advance during the last model request. Queue
        // one final coalesced refresh before publishing the completed token
        // snapshot, preserving the previous end-of-turn exactness.
        await structuredUsageRefresh?.trigger();
        const exactUsage = await buildClaudeUsageSnapshot(
          session,
          resultMsg,
          session.queryControl,
          options?.model,
        );
        if (!ownsActiveTurn()) {
          if (abortController.signal.aborted) {
            // The provider accepted this request, so the caller needs a
            // terminal outcome even though abort won the race with the final
            // usage snapshot. A newer structured turn replaces the request id
            // before taking ownership; never let this old turn overwrite it.
            recordInterruptedStructuredOutputIfCurrent();
          }
          heldSdkPrompt.close();
          return;
        }
        if (exactUsage) {
          session.usage = exactUsage;
        }
        if (exactUsage || session.rateLimits !== undefined) {
          eventEmitter.emit({
            type: "session.updated",
            sessionId,
            data: {
              ...(exactUsage ? { contextUsage: exactUsage } : {}),
              ...(session.rateLimits !== undefined ? { rateLimits: session.rateLimits } : {}),
            },
          });
        }

        if (resultMsg.subtype === "success") {
          if (options?.outputSchema) {
            if (resultMsg.structured_output === undefined) {
              const failure = structuredOutputFailure(
                "claude",
                "malformed_output",
                "Claude completed the turn without a structured result.",
                { requestId: structuredRequestId },
              );
              recordStructuredOutput(session, failure);
              throw new ClaudeStructuredOutputError(failure);
            }
            recordStructuredOutput(session, {
              ok: true,
              provider: "claude",
              requestId: structuredRequestId,
              value: resultMsg.structured_output,
            });
          }
          debugLog("[session-manager] Query completed successfully", { sessionId });
          finishTurnInputIfSettled();
        } else {
          console.error("[session-manager] Query error:", resultMsg.subtype, { sessionId });
          const resultError =
            resultMsg.errors?.filter(Boolean).join("\n") ||
            `Claude query failed: ${resultMsg.subtype}`;
          if (options?.outputSchema) {
            const failure = structuredOutputFailure(
              "claude",
              resultMsg.subtype === "error_max_structured_output_retries"
                ? "schema_retry_exhausted"
                : "provider_error",
              resultError,
              {
                requestId: structuredRequestId,
                details: { subtype: resultMsg.subtype ?? "unknown" },
              },
            );
            recordStructuredOutput(session, failure);
            throw new ClaudeStructuredOutputError(failure);
          }
          throw new Error(resultError);
        }
      } else if (message.type === "stream_event") {
        stream.applyPartialAssistantMessage(message);
      }
      // Note: AskUserQuestion tool handling is done in the canUseTool callback above
    }

    // The stream can end on a delta (abort, SDK hang-up) with a snapshot still
    // pending; publish it so the transcript holds everything that streamed.
    stream.flushStreamedAssistantMessage();

    if (abortController.signal.aborted) {
      if (options?.outputSchema && structuredRequestId) {
        recordInterruptedStructuredOutputIfCurrent();
      }
      return;
    }

    // If a plan was rejected with feedback but the SDK ended the turn without
    // Claude revising, re-send the feedback as a follow-up prompt so Claude
    // actually sees it and generates a revised plan.
    // Guard: only re-prompt once (skip if this call is itself a re-prompt).
    if (
      stream.pendingPlanRejectionFeedback &&
      !abortController.signal.aborted &&
      !options?._isReprompt
    ) {
      const feedbackPrompt = stream.pendingPlanRejectionFeedback;
      stream.pendingPlanRejectionFeedback = null;

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
        permissionMode: "plan",
        _isReprompt: true,
      };

      try {
        await sendPrompt(sessionId, feedbackPrompt, repromptOptions);
        // sendPrompt handles setting idle status and emitting events, so return early
        return;
      } catch (repromptError) {
        console.error("[session-manager] Failed to re-prompt with plan feedback:", repromptError);
        return Promise.reject(repromptError);
      }
    }

    // Defensive fallback continuation: see the comment block on
    // `stream.planApprovedThisTurn` above. If the SDK failed the ExitPlanMode tool
    // despite an approval (we already overrode the tool state to success in
    // the message loop), re-prompt Claude WITHOUT plan mode so it actually
    // implements the approved plan instead of ending the turn.
    // Guard: skip if this call is itself a re-prompt to avoid recursion.
    if (
      stream.pendingPlanApprovalContinuation &&
      !abortController.signal.aborted &&
      !options?._isReprompt
    ) {
      const continuationPrompt = stream.pendingPlanApprovalContinuation;
      stream.pendingPlanApprovalContinuation = null;

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
      // the stream.pendingPlanRejectionFeedback re-prompt path above.
      const repromptOptions: PromptOptions = {
        model: options?.model,
        effort: options?.effort,
        fastMode: options?.fastMode,
        _isReprompt: true,
      };

      try {
        await sendPrompt(sessionId, continuationPrompt, repromptOptions);
        return;
      } catch (repromptError) {
        console.error("[session-manager] Failed to re-prompt after plan approval:", repromptError);
        return Promise.reject(repromptError);
      }
    }

    // An abort or immediate restart can take ownership while an awaited control
    // request above is still resolving. The old turn must not publish a second
    // idle edge or clear the new turn's controller.
    if (!ownsActiveTurn()) return;

    scheduleTitleGeneration();

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
      sdkMessageCount,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // The turn died mid-stream with deltas still coalescing. Publish them
    // before anything else here: the alternative is that the last window of
    // streamed text is silently dropped from the transcript, and the `finally`
    // below discards the pending timer, so this is the last chance to emit it.
    // Ordered before the failure is recorded so the client sees the completed
    // message first and `session.error` stays terminal.
    stream.flushStreamedAssistantMessage();

    if (abortController.signal.aborted) {
      recordInterruptedStructuredOutputIfCurrent();
      return;
    }
    console.error("[session-manager] Error processing prompt:", error);

    if (session.abortController === abortController) {
      if (options?.outputSchema && structuredRequestId && !session.structuredOutput) {
        recordStructuredOutput(
          session,
          structuredOutputFailure(
            "claude",
            "provider_error",
            error instanceof Error ? error.message : String(error),
            { requestId: structuredRequestId },
          ),
        );
      }
      session.status = "error";
      session.turnStartedAt = undefined;
      session.error = error instanceof Error ? error.message : String(error);
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
  } finally {
    // The turn has stopped producing frames. From here the `revision` counters
    // it stamped only matter for as long as a disconnected client could still
    // be resuming from them; see `evictIdleHydratedTranscripts`.
    session.lastStreamedRevisionAt = Date.now();
    closeSdkInput?.();
    if (session.finishTurnInputIfSettled === finishTurnInputForThisTurn) {
      session.finishTurnInputIfSettled = undefined;
    }
    // Once the SDK accepted the query, a retry must replay the outcome rather
    // than risk running its side effects twice. Before that startup barrier,
    // failure is unambiguous and the caller must be able to retry.
    if (dispatchRequestId && sessions.get(sessionId) === session) {
      if (queryStarted) {
        recordPromptDispatch(sessionId, dispatchRequestId, "already-processed");
      } else {
        forgetPromptDispatch(sessionId, dispatchRequestId);
      }
    }
    // The stream is over, so there is no continuation left to wait for and the
    // watchdog has nothing to guard.
    if (retainedContinuationTimer) {
      clearTimeout(retainedContinuationTimer);
      retainedContinuationTimer = null;
    }
    // The loop above is the only consumer of this iterator, and it ends either
    // exhausted or through an abrupt exit — which invokes `return()`, i.e. the
    // SDK's `cleanup()` → `transport.close()`. So the handle is dead either
    // way: nothing more can arrive on it and `stopTask` would answer a stop
    // request with a transport error. Settle what it owned instead of retaining
    // a handle that can only fail, and never leave a task at `running`.
    if (queryIteratorControl) {
      // Dropping the retention is what lets the close below actually run.
      forgetRetainedQueryControl(session, queryIteratorControl);
      removeBackgroundTaskCandidatesOwnedBy(session, queryIteratorControl);
      // The handle is dead, so no edge can still arrive to claim these.
      forgetSettlingBackgroundTasksOwnedBy(session, queryIteratorControl);
      const settled = settleTasksOwnedByClosedControl(
        session,
        queryIteratorControl,
        "The Claude session that owned this task ended before it reported a result",
      );
      if (session.queryControl === queryIteratorControl) {
        session.queryControl = undefined;
      }
      closeQueryControlIfUnused(session, queryIteratorControl);
      if (settled) emitBackgroundTaskSnapshot(session);
    }
    // The pre-turn transcript read failed, so `persistedMessagesLoaded` claims
    // a hydration that never happened. Clearing it once the turn is over lets
    // the next transcript request retry; leaving it set hid the on-disk history
    // until the bridge restarted.
    if (transcriptHydrationFailed && sessions.get(sessionId) === session && !session.deleting) {
      session.persistedMessagesLoaded = false;
    }
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (earlyWarningTimeout) {
      clearTimeout(earlyWarningTimeout);
    }
    stream.clearFlushTimer();
  }
}

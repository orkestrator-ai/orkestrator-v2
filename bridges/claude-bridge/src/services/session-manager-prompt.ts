import { observeClaudeMessage } from "./diagnostics.js";
import { reportUltracodeRuntime, requestsUltracode } from "./ultracode.js";
// Session Manager Service
// Handles session state and interacts with Claude Agent SDK
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  HookCallback,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import type { NormalizedMessage, PromptOptions } from "../types/index.js";
import {} from "../types/index.js";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { structuredOutputFailure } from "@orkestrator/protocol/structured-output";
import { eventEmitter } from "./event-emitter.js";
import { markTranscriptChanged, resetTranscriptEpoch } from "./transcript-revision.js";
import { runtimeEnvironmentForAgentQuery } from "./runtime-env.js";
import { backgroundCommandInstruction } from "./background-commands.js";
import { debugLog, flushDebugLogs, isDebugLoggingEnabled } from "./logger.js";
import {
  AGENT_MCP_SERVER_NAME,
  getMcpRuntimeConfig,
  mcpSourceScopeForPolicy,
} from "./mcp-config.js";
import {
  claudeDeniedTools,
  claudeReadOnlyAllowedTools,
  claudeReadOnlySandbox,
  createCoordinatorReadOnlyHook,
  isCoordinatorReadOnlyPolicy,
} from "./read-only-policy.js";
import { getPluginsForSdk } from "./plugin-config.js";
import {
  claudeSettingSources,
  claudeTurnPolicy,
  claudeWorkspaceCwd,
} from "./claude-query-config.js";
import { readLiveCommandInventory } from "./session-manager-commands.js";

import { createPromptStreamState } from "./session-manager-prompt-stream.js";
import { captureTurnStartup, createTurnState } from "./session-manager-prompt-turn.js";
import { promptMessageHandler } from "./session-manager-prompt-handlers/dispatch.js";
import { commandChangeHookFor } from "./session-manager-prompt-hooks.js";
import { createClaudeRuntimeTurn } from "./session-manager-prompt-runtime-turn.js";
import {
  armContinuationWatchdog,
  recordInterruptedStructuredOutputIfCurrent,
  closeTurnInput,
  diagnosticErrorClass,
  finishTurnInputIfSettled,
  ownsActiveTurn,
} from "./session-manager-prompt-turn-lifecycle.js";
export { RETAINED_CONTINUATION_TIMEOUT_MS } from "./session-manager-prompt-turn-lifecycle.js";
import {
  appendTranscriptNotice,
  settlePendingApiRetry,
} from "./session-manager-prompt-handlers/transcript-notice.js";
import { nextTurnGeneration } from "./session-manager-core.js";
import {
  applySessionPlanMode,
  claimedPromptDispatches,
  claudeExecutableOptions,
  createStructuredUsageRefreshCoordinator,
  generateMessageId,
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
import {} from "./session-manager-messages.js";
export { memoryRecallPart } from "./session-manager-messages.js";
import {
  ClaudeAttachmentError,
  attachmentTag,
  buildSdkPrompt,
  holdSdkPromptOpen,
  readPersistedSessionMessagesOnce,
  sdkPromptMessages,
} from "./session-manager-persistence.js";
import {
  applyClaudeLiveSettings,
  assertClaudeRuntimeAccepts,
  assertClaudeRuntimeStaticAccepts,
  claudeLaunchResourceProfile,
  effectiveClaudeContext1m,
  claudeLaunchedProfile,
  claudeLiveSettings,
  createClaudeRuntime,
  openClaudeRuntime,
  retireDrainingClaudeRuntime,
  routeClaudeFrame,
  submitClaudeTurn,
  type ClaudeRuntime,
  type ClaudeRuntimeTurn,
} from "./session-manager-runtime.js";
import {
  closeQueryControlIfUnused,
  emitBackgroundTaskSnapshot,
  forgetRetainedQueryControl,
  forgetSettlingBackgroundTasksOwnedBy,
  removeBackgroundTaskCandidatesOwnedBy,
  settleTasksOwnedByClosedControl,
} from "./session-manager-background-tasks.js";
export const STREAM_EVENT_COALESCE_MS = 100;
/**
 * Highest content-block index accepted from a streamed SDK event.
 *
 * Real assistant responses use a small, dense sequence of content blocks.
 * Treat a larger index as malformed instead of retaining attacker-controlled
 * sparse state for the rest of the turn. The map-based storage below also
 * keeps iteration proportional to the number of blocks actually received.
 */
export const MAX_STREAM_CONTENT_BLOCK_INDEX = 4_095;

export { THINKING_TOKENS_EMIT_INTERVAL_MS } from "./session-manager-prompt-handlers/system.js";
export { applyClaudeUsageReport } from "./session-manager-prompt-handlers/assistant.js";
export { claudeStartupFailureMessage } from "./session-manager-prompt-handlers/result.js";

export const PLAN_MODE_INSTRUCTIONS = `The user has enabled planning mode. Use this phase to:
1. Thoroughly explore the codebase and its existing patterns.
2. Consider viable approaches and their trade-offs.
3. Design a concrete implementation strategy.
4. When ready, call ExitPlanMode with the plan for approval.
Do not write or edit files until the plan is approved.`;

/**
 * The single consumer of a runtime's frames, for the life of its process.
 *
 * Each frame goes to the turn it belongs to (`routeClaudeFrame`). A turn whose
 * handler throws ends the process — leaving the loop is the SDK's
 * `transport.close()` — and that turn's `sendPrompt` reports the error.
 */
async function consumeClaudeRuntime(
  runtime: ClaudeRuntime,
  frames: AsyncIterable<SDKMessage>,
  markEnded: () => void,
): Promise<void> {
  let failure: { turn: ClaudeRuntimeTurn; error: unknown } | undefined;
  try {
    for await (const message of frames) {
      if (runtime.abortController.signal.aborted) break;
      const turn = routeClaudeFrame(runtime, message);
      try {
        await turn.handleMessage(message);
      } catch (error) {
        failure = { turn, error };
        break;
      }
    }
  } catch (error) {
    failure = { turn: runtime.latestTurn, error };
  } finally {
    endClaudeRuntime(runtime, failure);
    markEnded();
  }
}

/**
 * Settle everything a finished process owned and release its turns.
 *
 * The consumer ends either exhausted or through an abrupt exit, which invokes
 * `return()`, i.e. the SDK's `cleanup()` → `transport.close()`. So the handle
 * is dead either way: nothing more can arrive on it and `stopTask` would answer
 * a stop request with a transport error. Settle what it owned instead of
 * retaining a handle that can only fail, and never leave a task at `running`.
 */
function endClaudeRuntime(
  runtime: ClaudeRuntime,
  failure: { turn: ClaudeRuntimeTurn; error: unknown } | undefined,
): void {
  runtime.state = "ended";
  const { session, control } = runtime;
  if (session.claudeRuntime === runtime) session.claudeRuntime = undefined;
  // Dropping the retention is what lets the close below actually run.
  forgetRetainedQueryControl(session, control);
  removeBackgroundTaskCandidatesOwnedBy(session, control);
  // The handle is dead, so no edge can still arrive to claim these.
  forgetSettlingBackgroundTasksOwnedBy(session, control);
  const settled = settleTasksOwnedByClosedControl(
    session,
    control,
    "The Claude session that owned this task ended before it reported a result",
  );
  if (session.queryControl === control) session.queryControl = undefined;
  if (session.queryControlDraining === control) session.queryControlDraining = undefined;
  closeQueryControlIfUnused(session, control);
  if (settled) emitBackgroundTaskSnapshot(session);
  // A turn that failed after it stopped waiting still ended the process; the
  // turn the user is waiting on is the one that has to say so.
  const failedTurn =
    failure && (runtime.waitingTurns.has(failure.turn) ? failure.turn : runtime.latestTurn);
  const turns = Array.from(runtime.waitingTurns);
  runtime.waitingTurns.clear();
  for (const turn of turns) {
    turn.runtimeEnded(turn === failedTurn && failure ? { error: failure.error } : undefined);
  }
}

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
  // Before anything is claimed: a prompt the session's running CLI cannot take
  // is refused outright, never accepted and then dropped.
  assertClaudeRuntimeStaticAccepts(session, options);
  const beforeStartup = captureTurnStartup(session);
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
  // Read before the claim below; see `TurnState.bootstrapClaudeUsage`.
  const bootstrapClaudeUsage =
    session.claudeUsageBaseline === undefined &&
    (needsTranscriptHydration || session.messages.length > 0 || session.usage !== undefined);
  session.persistedMessagesLoaded = true;
  // The flip from preview to loaded is itself a new history for readers, even
  // before the read below installs its messages.
  if (needsTranscriptHydration) resetTranscriptEpoch(session);
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
  session.inProgressUsage = undefined;
  session.inProgressUsageGeneration = turnGeneration;
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
          session.abortController = beforeStartup.abortController;
        }
        // This turn never reached the SDK, so it must hand the foreground back
        // to whichever turn held it — including a released one still running.
        if (session.latestTurnGeneration === turnGeneration) {
          session.latestTurnGeneration = beforeStartup.latestTurnGeneration;
        }
        session.status = beforeStartup.status;
        session.turnStartedAt = beforeStartup.turnStartedAt;
        session.error = beforeStartup.error;
        session.lastActivity = beforeStartup.lastActivity;
        session.persistedMessagesLoaded = beforeStartup.persistedMessagesLoaded;
        if (needsTranscriptHydration) resetTranscriptEpoch(session);
        session.structuredOutput = beforeStartup.structuredOutput;
        session.structuredOutputRequestId = beforeStartup.structuredOutputRequestId;
        session.inProgressUsage = beforeStartup.inProgressUsage;
        session.inProgressUsageGeneration = beforeStartup.inProgressUsageGeneration;
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
        resetTranscriptEpoch(session);
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
  const displayPrompt =
    options?.attachments && options.attachments.length > 0
      ? `${prompt}\n\n<attached-files>\n${options.attachments.map(attachmentTag).join("\n")}\n</attached-files>`
      : prompt;
  // Build the SDK text prompt - excludes image attachments since those are sent as
  // inline base64 content blocks (bypassing the Read tool's 2000x2000 pixel limit).
  // File attachments are still included as XML tags so Claude can read them.
  // A selected command sends its canonical SDK spelling plus the argument
  // suffix exactly as typed; the transcript above still shows what the user
  // wrote. The Claude CLI owns command semantics from here.
  const providerPrompt = options?.providerPrompt ?? prompt;
  const fileAttachments = options?.attachments?.filter((att) => att.type !== "image") ?? [];
  const sdkTextPrompt =
    fileAttachments.length > 0
      ? `${providerPrompt}\n\n<attached-files>\n${fileAttachments.map(attachmentTag).join("\n")}\n</attached-files>`
      : providerPrompt;
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
  markTranscriptChanged(session);
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

  // A turn written into a running CLI shares its tool tracker, so reports for
  // tools an earlier turn started still find their rows.
  const runningRuntime = openClaudeRuntime(session);
  // Hoisted out of the `try` so the error path can still publish whatever the
  // coalescing window was holding.
  const stream = createPromptStreamState(session, sessionId, {
    flushIntervalMs: STREAM_EVENT_COALESCE_MS,
    maxBlockIndex: MAX_STREAM_CONTENT_BLOCK_INDEX,
    ...(runningRuntime
      ? { toolTracker: runningRuntime.toolTracker, activeTaskIds: runningRuntime.activeTaskIds }
      : {}),
  });
  const turn = createTurnState(session, sessionId, {
    options,
    structuredRequestId,
    userMessage,
    dispatchRequestId,
    retainedContinuationTimeoutMs: testHooks?.retainedContinuationTimeoutMs,
    beforeStartup,
    abortController,
    turnGeneration,
    stream,
    bootstrapClaudeUsage,
    transcriptHydrationFailed,
  });
  // Fixed for the life of the turn, so aliasing them is safe. Everything that
  // changes is read through `turn` when it is needed, never copied out.
  const { diagnostics, streamUsage } = turn;
  const observeAbort = () => {
    diagnostics?.requestCancellation();
  };
  abortController.signal.addEventListener("abort", observeAbort, { once: true });
  const splitAssistantAfterSteer = () => {
    stream.beginPostSteerScope();
  };
  session.splitAssistantAfterSteer = splitAssistantAfterSteer;
  const advanceBaselineForInterruptedStream = () => {
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
  };
  try {
    // Create the query with Claude Agent SDK
    // Determine effort level: default to "high" if not specified
    const effortLevel = options?.effort ?? "high";
    // Use CWD env var if set (for local environments where bridge runs from its own dir)
    // This allows the Claude SDK to operate on the actual project directory
    const cwd = claudeWorkspaceCwd();

    // Re-derived at every turn, not read once at create. A session restored
    // from disk, or configured before this process took over, must not carry a
    // policy weaker than the one this process was launched to enforce.
    const policy: NativeAgentExecutionPolicy | undefined = claudeTurnPolicy(
      session.executionPolicy,
      options?.readOnly,
    );
    // What a cold command-discovery probe must reproduce to answer for this
    // session rather than for a default CLI (see `claude-query-config.ts`).
    session.commandDiscoveryInputs = {
      readOnly: options?.readOnly === true,
      includeLocalSettings: options?.includeLocalSettings === true,
    };
    const includeProjectResources = policy?.projectResources !== false;
    // Load MCP servers and plugins from config files. Both resolutions read
    // the same on-disk config, so they run concurrently and each merges once.
    // A coordinator's inline set is the injected Orkestrator server(s) only:
    // `mcpSourceScopeForPolicy` answers `none` for it, so a user-scope stdio
    // server cannot ride in through the one channel the CLI still honours
    // when `settingSources` is empty.
    const [{ servers: mcpServers, names: mcpServerNames, revision: mcpConfigRevision }, plugins] =
      await Promise.all([
        getMcpRuntimeConfig(cwd, process.env, options?.agentMcp, mcpSourceScopeForPolicy(policy)),
        getPluginsForSdk(cwd, includeProjectResources),
      ]);
    turn.mcpServerNames = mcpServerNames;

    const mcpServerCount = Object.keys(mcpServers).length;
    const pluginCount = plugins.length;
    // Determine permission mode: use provided option or default to "bypassPermissions".
    // Why: when the user requests "plan" mode we forward it as the SDK's actual
    // `"plan"` permissionMode. The SDK enforces read-only and runs its built-in
    // ExitPlanMode tool natively — without this, ExitPlanMode fails because the
    // CLI has no plan-mode state to exit.
    const policyPermissionMode =
      policy?.approvals === "ask"
        ? "default"
        : policy?.approvals === "deny"
          ? "dontAsk"
          : "bypassPermissions";
    const permissionMode = options?.permissionMode ?? policyPermissionMode;
    turn.permissionMode = permissionMode;
    const defaultAllowedTools = [
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
    ];
    const coordinatorReadOnly = isCoordinatorReadOnlyPolicy(policy);
    const allowedTools = coordinatorReadOnly
      ? claudeReadOnlyAllowedTools({
          agentMcpServerNames: mcpServerNames.has(AGENT_MCP_SERVER_NAME)
            ? [AGENT_MCP_SERVER_NAME]
            : [],
        })
      : (policy?.toolPolicy?.allow ?? defaultAllowedTools);
    // Provider tool names, not the policy's own: `toolPolicy.deny` carries
    // Codex's vocabulary, and passing it to `disallowedTools` matches nothing.
    const disallowedTools = coordinatorReadOnly
      ? claudeDeniedTools(policy)
      : policy?.toolPolicy?.deny;

    const fastMode = options?.fastMode === true;
    const ultracode = requestsUltracode(options?.parameterValues);
    session.ultracode = ultracode;
    session.ultracodeApplied = ultracode;

    debugLog("[session-manager] Starting query", {
      sessionId,
      cwd,
      model: options?.model,
      resume: session.sdkSessionId ?? null,
      effortLevel,
      permissionMode,
      fastMode,
      ultracode,
      mcpServerCount,
      mcpServerNames: Array.from(mcpServerNames),
      pluginCount,
      pluginPaths: plugins.map((p) => p.path),
    });
    const envPath = process.env.PATH;
    debugLog("[session-manager] SDK env PATH", { path: envPath });
    const sdkPrompt = await buildSdkPrompt(
      sdkTextPrompt,
      options?.attachments,
      cwd,
      testHooks?.afterAttachmentSymlinkValidation,
      testHooks?.afterAttachmentCanonicalValidation,
      testHooks?.afterAttachmentInitialValidation,
    );
    turn.closeSdkInput = () => closeTurnInput(turn);
    turn.finishTurnInputForThisTurn = () => finishTurnInputIfSettled(turn);

    const queryEnvironment = await runtimeEnvironmentForAgentQuery();
    // One SDK frame routed to this turn by the runtime's single consumer.
    const handleMessage = async (message: SDKMessage): Promise<void> => {
      if (abortController.signal.aborted) {
        return;
      }

      turn.sdkMessageCount += 1;
      // A superseded turn still draws frames for its own tools, after its
      // diagnostics have closed.
      if (diagnostics && !turn.queryEnded) observeClaudeMessage(diagnostics, message);
      // Any frame is evidence the provider is still answering the notification,
      // so the watchdog is pushed out rather than allowed to expire mid-stream.
      // Retention itself is dropped by the reclaim, the result, or the watchdog
      // firing — never by liveness alone.
      if (turn.retainedContinuationTimer) armContinuationWatchdog(turn);
      // Fires once per streamed delta — i.e. per token. Both the object
      // literal and the write are guarded, not just the write.
      if (isDebugLoggingEnabled) {
        debugLog("[session-manager] SDK event received", {
          sessionId,
          type: message.type,
          subtype: "subtype" in message ? message.subtype : undefined,
          sdkMessageCount: turn.sdkMessageCount,
        });
      }

      // Deltas are coalesced; everything else must observe them in order, so
      // settle the pending snapshot before handling a non-delta message.
      if (message.type !== "stream_event") stream.flushStreamedAssistantMessage();

      // Only the handlers that must finish a control round trip before the
      // next frame return a promise; the rest complete synchronously, exactly
      // as the branches they replaced did.
      const handled = promptMessageHandler(message.type)(turn, message);
      if (handled) await handled;
    };
    turn.thisTurn = createClaudeRuntimeTurn(turn, handleMessage);
    const liveSettings = claudeLiveSettings({
      model: options?.model,
      permissionMode,
      effort: effortLevel,
      parameterValues: options?.parameterValues,
      fastMode,
    });
    // Content-free identity of the inline MCP servers, which carry credentials.
    const mcpServersKey = createHash("sha256").update(JSON.stringify(mcpServers)).digest("hex");
    const recordMcpConfigRevision = () => {
      // The configuration the CLI actually has, recorded only once it has it:
      // a save made while the previous turn ran is "pending" until here, and
      // one made after here is pending for the next turn.
      if (!mcpConfigRevision) return;
      session.mcpConfigRevision = {
        ...mcpConfigRevision,
        sources: { ...mcpConfigRevision.sources },
        queryStartedAt: new Date().toISOString(),
      };
    };

    // The session's CLI is still running when an earlier turn left background
    // work in it. This prompt is written into that process: a second CLI
    // resumed from the same rollout would run its own root loop beside it.
    const running = openClaudeRuntime(session);
    if (running) {
      // Launch-only settings may have changed while this turn was preparing.
      await assertClaudeRuntimeAccepts(
        session,
        options,
        claudeLaunchResourceProfile(plugins, queryEnvironment),
      );
      // Held from here so the process is not closed as unused while the
      // settings below are applied.
      session.queryControl = running.control;
      turn.queryIteratorControl = running.control;
      try {
        await applyClaudeLiveSettings(running, liveSettings);
        if (running.mcpServers !== mcpServersKey) {
          if (!running.control.setMcpServers) {
            throw sessionOperationError(
              "conflict",
              "Claude MCP configuration cannot be updated on this runtime",
            );
          }
          // A partial update invalidates the previous identity too. Retrying
          // either configuration must actually restate it on the CLI.
          running.mcpServers = "";
          const result = await running.control.setMcpServers(mcpServers).catch(() => {
            throw sessionOperationError(
              "conflict",
              "Claude MCP configuration could not be applied; retry the prompt",
            );
          });
          if (
            !result ||
            typeof result !== "object" ||
            !("errors" in result) ||
            !result.errors ||
            typeof result.errors !== "object" ||
            Array.isArray(result.errors) ||
            Object.keys(result.errors).length > 0
          ) {
            throw sessionOperationError(
              "conflict",
              "Claude MCP configuration could not be applied; retry the prompt",
            );
          }
        }
        // Required injected servers can disconnect even without a config change.
        if (mcpServers[AGENT_MCP_SERVER_NAME]) {
          const statuses = await running.control.mcpServerStatus?.().catch(() => {
            running.mcpServers = "";
            throw sessionOperationError(
              "conflict",
              "Claude required MCP server could not be confirmed; retry the prompt",
            );
          });
          const required = [
            AGENT_MCP_SERVER_NAME,
            ...(options?.agentMcp?.design ? ["orkestrator-design"] : []),
          ];
          if (
            !required.every((name) =>
              statuses?.some((server) => server.name === name && server.status === "connected"),
            )
          ) {
            running.mcpServers = "";
            throw sessionOperationError(
              "conflict",
              "Claude required MCP server is not connected; retry the prompt",
            );
          }
        }
        running.mcpServers = mcpServersKey;
        recordMcpConfigRevision();
        const messages = await sdkPromptMessages(sdkPrompt, turn.promptUuid);
        turn.runtime = running;
        if (!submitClaudeTurn(running, turn.thisTurn, messages)) {
          throw sessionOperationError(
            "conflict",
            "Claude runtime could not accept prompt input; retry after it has stopped",
          );
        }
      } catch (error) {
        turn.runtime = undefined;
        if (session.queryControl === running.control) session.queryControl = undefined;
        turn.queryIteratorControl = undefined;
        // A setup failure never authorizes killing or replacing shared work.
        // Leave the previous turn and retention intact, and restore foreground
        // ownership in the startup failure handler below.
        throw error;
      }
    }

    if (!turn.runtime) {
      // Stopped while joining a process that was ending: nothing was written,
      // and stopping must not start another one.
      if (abortController.signal.aborted) return;
      // A previous CLI that is still exiting must be gone before another one
      // opens the same rollout.
      await retireDrainingClaudeRuntime(session);
      if (abortController.signal.aborted || session.deleting || sessions.get(sessionId) !== session)
        return;
      const heldSdkPrompt = holdSdkPromptOpen(sdkPrompt, abortController.signal, turn.promptUuid);
      let launched: ClaudeRuntime | undefined;
      // Hooks and callbacks fire on the runtime's behalf for whichever turn
      // they concern: the one whose row holds the tool, else the latest turn.
      const turnFor = (toolUseId?: string): ClaudeRuntimeTurn =>
        (toolUseId ? launched?.toolOwners.get(toolUseId) : undefined) ??
        launched?.latestTurn ??
        turn.thisTurn!;
      const latestTurnHook =
        (pick: (target: ClaudeRuntimeTurn) => HookCallback): HookCallback =>
        (...args) =>
          pick(turnFor())(...args);
      const backgroundTaskHook = latestTurnHook((target) => target.recordBackgroundTaskHook);
      const commandChangeHook = commandChangeHookFor(turnFor);
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
          title: session.title,
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
          // Always given: a later turn can switch this running CLI into plan mode.
          planModeInstructions: PLAN_MODE_INSTRUCTIONS,
          // Required when using bypassPermissions mode, and whenever the policy
          // allows it: a later turn can switch this running CLI into it.
          ...((permissionMode === "bypassPermissions" ||
            policyPermissionMode === "bypassPermissions") && {
            allowDangerouslySkipPermissions: true,
          }),
          // Use effort level to control thinking depth (replaces maxThinkingTokens)
          ...(effortLevel && { effort: effortLevel }),
          // Opus 4.7 defaults adaptive thinking display to "omitted" (signature only,
          // redacted text). Opt back into "summarized" so thinking content renders in the UI.
          thinking:
            options?.parameterValues?.thinking === "disabled"
              ? { type: "disabled" }
              : typeof options?.parameterValues?.thinking === "string" &&
                  options.parameterValues.thinking.startsWith("budget-")
                ? {
                    type: "enabled",
                    budgetTokens: Number(options.parameterValues.thinking.slice("budget-".length)),
                    display: "summarized",
                  }
                : { type: "adaptive", display: "summarized" },
          ...(effectiveClaudeContext1m(options)
            ? { betas: ["context-1m-2025-08-07" as const] }
            : {}),
          // Explicit flags override ambient CLAUDE_CODE_ENABLE_CFC. Chrome is
          // opt-in, and a coordinator's read-only boundary always excludes
          // driving the user's signed-in browser.
          extraArgs:
            options?.parameterValues?.chrome === true && !coordinatorReadOnly
              ? { chrome: null }
              : { "no-chrome": null },
          ...(typeof options?.maxBudgetUsd === "number" && options.maxBudgetUsd > 0
            ? { maxBudgetUsd: options.maxBudgetUsd }
            : {}),
          includePartialMessages: true,
          // Preserve the full nested transcript. Every forwarded subagent block
          // carries parent_tool_use_id and is rendered inside its Agent card.
          forwardSubagentText: true,
          allowedTools,
          ...(disallowedTools?.length ? { disallowedTools } : {}),
          ...(coordinatorReadOnly && policy
            ? { sandbox: claudeReadOnlySandbox(policy) }
            : policy?.sandbox === "provider"
              ? {
                  sandbox: {
                    enabled: true,
                    autoAllowBashIfSandboxed: policy.approvals === "auto-approve",
                    network: { allowLocalBinding: policy.networkAccess === "full" },
                  },
                }
              : {}),
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
          perTaskStopAffordance: true,
          // Use Claude Code system prompt with additional instructions
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: [
              "IMPORTANT: You MUST read a file before editing or writing to it. The Edit and Write tools will fail if you have not first used the Read tool to read the file in this conversation. Always read files before attempting to modify them.",
              // Since Claude Code 2.1.285 an Agent SDK session stops a background
              // shell command at its `timeout`, so a dev server Claude starts here
              // does not outlive the ceiling configured in Settings.
              backgroundCommandInstruction(queryEnvironment),
              // The claude.ai Claude Docs connector and docs skill steer reports
              // into remote docs that only an Artifact tool can open, and
              // Orkestrator has none, so the report never shows up here.
              "When the user asks for a document (a report, design doc, plan, analysis, guide, or other writing to keep), prefer writing it as a Markdown file in a `docs/` folder at the root of the working directory over creating a Claude Doc or claude.ai artifact, and tell the user the file's path. Project instructions (such as CLAUDE.md or AGENTS.md), local skills, and the user's own request take priority over this default when they say where or how to write documents.",
            ].join("\n\n"),
          },
          // Load user settings (from ~/.claude.json including MCP servers) and project settings (CLAUDE.md files)
          // Using "user" lets the SDK handle MCP server loading natively, which supports all transport types
          // A coordinator loads nothing: user settings can declare their own
          // hooks and MCP servers, both of which run programs this boundary is
          // supposed to exclude.
          settingSources: claudeSettingSources(policy, options?.includeLocalSettings),
          // Fast mode (priority service tier) and Ultracode are Claude Code
          // flag-layer settings, so the user can opt into each per prompt. The
          // CLI keeps neither across processes, and each turn is its own query.
          ...((fastMode || ultracode) && {
            settings: {
              ...(fastMode && { fastMode: true }),
              ...(ultracode && { ultracode: true }),
            },
          }),
          // Also pass MCP servers explicitly for any project-local .mcp.json overrides.
          // The CLI (2.1.280) also loads the servers of every enabled settings
          // source itself — `user` reads `$CLAUDE_CONFIG_DIR/.claude.json` (else
          // `~/.claude.json`), `project` reads `.mcp.json`, `local` reads
          // `projects[cwd]` — and an inline entry wins over a same-named native
          // one. `strictMcpConfig` is deliberately NOT set: it would also drop
          // every plugin-provided MCP server. The coordinator boundary instead
          // rests on `settingSources: []` plus an inline set of `none` scope.
          mcpServers: mcpServerCount > 0 ? mcpServers : undefined,
          // Load plugins from user config
          plugins: pluginCount > 0 ? plugins : undefined,
          hooks: {
            // Registered here rather than through settings so a workspace cannot
            // remove the one control that actually holds the boundary.
            // The read-only hook runs first: a call it denies must never be
            // snapshotted, and the measuring hook only opens a window.
            PreToolUse: [
              ...(coordinatorReadOnly && policy
                ? [{ hooks: [createCoordinatorReadOnlyHook(policy)] }]
                : []),
              commandChangeHook.PreToolUse,
            ],
            PostToolUse: [commandChangeHook.PostToolUse],
            PostToolUseFailure: [commandChangeHook.PostToolUseFailure],
            TaskCreated: [{ hooks: [backgroundTaskHook] }],
            TaskCompleted: [{ hooks: [backgroundTaskHook] }],
            SubagentStart: [{ hooks: [backgroundTaskHook] }],
            SubagentStop: [{ hooks: [backgroundTaskHook] }],
            PreCompact: [{ hooks: [latestTurnHook((target) => target.recordPreCompact)] }],
            PostCompact: [{ hooks: [latestTurnHook((target) => target.recordPostCompact)] }],
          },
          // Hook failures are observable provider-health data. Without these
          // events a failed lifecycle hook would silently leave task or
          // compaction projection stale.
          includeHookEvents: true,
          // Pinned against @anthropic-ai/claude-agent-sdk 0.3.296: although the
          // SDK warns that bypassPermissions shadows canUseTool for ordinary
          // tool permission checks, AskUserQuestion is a special case. A live
          // contract probe confirmed it still reaches this callback and the SDK
          // waits for the returned promise. This is therefore the future input-
          // request enforcement hook, but it is NOT sufficient for unattended
          // command/file/permission approvals; those need a PreToolUse hook or an
          // equivalent provider-authoritative policy path.
          // Handle AskUserQuestion tool to get user input.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          // The SDK's own type, rather than a hand-written subset. The third
          // argument carries `suggestions`, `blockedPath`, `decisionReason` and
          // `title` — the last of which is the prompt sentence the CLI already
          // composed, so reconstructing one from `toolName` and `input` produces
          // a worse question than the one the SDK offered.
          canUseTool: ((toolName, input, permissionContext) =>
            turnFor(permissionContext?.toolUseID).canUseTool(
              toolName,
              input,
              permissionContext,
            )) as CanUseTool,
          /**
           * An MCP server asking the user for input.
           *
           * Answered rather than left to the CLI's park deadline. Unset, these
           * requests sat unanswered until the deadline expired, which the user
           * saw as the tab freezing for minutes with nothing to explain it.
           *
           * Declined, not accepted: this host has no form to render an arbitrary
           * JSON Schema into and no browser to complete a `url` flow in, and MCP
           * defines `decline` as an outcome the server is expected to handle. The
           * status row is what turns a silent refusal into something the user can
           * act on — the elicitation names its server, so they know where to go.
           */
          onElicitation: async (request) => {
            appendTranscriptNotice(session, sessionId, (event) => eventEmitter.emit(event), {
              type: "status",
              severity: "warning",
              content:
                request.mode === "url"
                  ? `${request.serverName} asked you to sign in through a link, which this tab cannot open. Complete it in a terminal and try again.`
                  : `${request.serverName} asked for input this tab cannot collect, so it was declined.`,
              createdAt: new Date().toISOString(),
            });
            return { action: "decline" };
          },
          /**
           * The CLI asking the host to render a blocking dialog.
           *
           * `supportedDialogKinds` is deliberately not declared: this host can
           * render none of them. The SDK documents that a kind is only *sent* to
           * clients that declared it, so in practice this callback should not
           * fire — but a multi-client transport delivers the request to every
           * attached client, so it can. `cancelled` is the correct answer for a
           * kind this host cannot render: the CLI then applies the dialog's own
           * default rather than waiting out its deadline.
           */
          onUserDialog: async () => ({ behavior: "cancelled" as const }),
        },
      });
      const liveQuery = Object.assign(queryIterator, {
        pushInput: (message: SDKUserMessage) => turnFor().pushSteerInput(message),
      });
      const created = createClaudeRuntime({
        session,
        control: liveQuery,
        heldInput: heldSdkPrompt,
        abortController,
        toolTracker: stream.toolTracker,
        activeTaskIds: stream.activeTaskIds,
        launch: {
          ...claudeLaunchedProfile(session, options),
          ...claudeLaunchResourceProfile(plugins, queryEnvironment),
        },
        mcpServers: mcpServersKey,
        firstTurn: turn.thisTurn,
      });
      launched = created.runtime;
      turn.runtime = launched;
      session.claudeRuntime = launched;
      session.queryControl = liveQuery;
      turn.queryIteratorControl = liveQuery;
      recordMcpConfigRevision();
      if (typeof queryIterator.supportedAgents === "function") {
        try {
          launched.supportedAgents = (await queryIterator.supportedAgents()).map((agent) => ({
            name: agent.name,
            description: agent.description,
            model: agent.model,
          }));
        } catch (error) {
          debugLog("[session-manager] Agent discovery unavailable:", error);
        }
      }
      void consumeClaudeRuntime(launched, queryIterator, created.markEnded);
    }
    const control = turn.queryIteratorControl!;
    const turnRuntime = turn.runtime;
    // Abort ownership follows the turn: stopping the latest turn stops the
    // process it runs on, exactly as stopping a turn that launched it does.
    abortController.signal.addEventListener(
      "abort",
      () => {
        if (turnRuntime.latestTurn === turn.thisTurn) turnRuntime.abortController.abort();
      },
      { once: true },
    );
    session.finishTurnInputIfSettled = turn.finishTurnInputForThisTurn;
    turn.queryStarted = true;
    testHooks?.onQueryStarted?.();
    // One control read per turn, off the message path, so the inventory a
    // selected command is validated against is the session's own.
    readLiveCommandInventory(session, control);
    reportUltracodeRuntime(session, control);

    turn.structuredUsageRefresh = createStructuredUsageRefreshCoordinator(session, control);
    // Prime the limits panel as soon as the live control channel is ready.
    // This intentionally runs off the SDK message-consumer path.
    void turn.structuredUsageRefresh?.trigger();

    diagnostics?.sent(sessionId);

    // Frames arrive through the runtime's consumer. This turn is done waiting
    // once a newer turn takes over or the process ends.
    await turn.turnEnded;
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
      return;
    }

    // If a plan was rejected with feedback but the SDK ended the turn without
    // Claude revising, re-send the feedback as a follow-up prompt so Claude
    // actually sees it and generates a revised plan.
    // Guard: only re-prompt once (skip if this call is itself a re-prompt).
    if (
      stream.pendingPlanRejectionFeedback &&
      !abortController.signal.aborted &&
      !options?._isReprompt &&
      !turn.superseded
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
        parameterValues: options?.parameterValues,
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
      !options?._isReprompt &&
      !turn.superseded
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
        parameterValues: options?.parameterValues,
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
    if (!ownsActiveTurn(turn)) return;

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
  } catch (error) {
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
    console.error("[session-manager] Error processing prompt", {
      errorClass: diagnosticErrorClass(error),
    });

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
    turn.queryEnded = true;
    diagnostics?.close();
    flushDebugLogs();
    abortController.signal.removeEventListener("abort", observeAbort);
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
        advanceBaselineForInterruptedStream();
        session.usage = session.inProgressUsage;
      }
      session.inProgressUsage = undefined;
      session.inProgressUsageGeneration = undefined;
    }
    turn.closeSdkInput?.();
    if (session.finishTurnInputIfSettled === turn.finishTurnInputForThisTurn) {
      session.finishTurnInputIfSettled = undefined;
    }
    if (session.splitAssistantAfterSteer === splitAssistantAfterSteer) {
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
    // The stream is over, so there is no continuation left to wait for and the
    // watchdog has nothing to guard.
    if (turn.retainedContinuationTimer) {
      clearTimeout(turn.retainedContinuationTimer);
      turn.retainedContinuationTimer = null;
    }
    if (dispatchRequestId) {
      session.retainedContinuationRequestIds?.delete(dispatchRequestId);
      if (session.retainedContinuationRequestIds?.size === 0) {
        session.retainedContinuationRequestIds = undefined;
      }
    }
    // What the process owned is settled by the runtime when it ends
    // (`endClaudeRuntime`), not here: a turn that is superseded or released to
    // background work finishes while the process it ran on keeps going.
    // The pre-turn transcript read failed, so `persistedMessagesLoaded` claims
    // a hydration that never happened. Clearing it once the turn is over lets
    // the next transcript request retry; leaving it set hid the on-disk history
    // until the bridge restarted.
    if (
      turn.transcriptHydrationFailed &&
      sessions.get(sessionId) === session &&
      !session.deleting
    ) {
      session.persistedMessagesLoaded = false;
      resetTranscriptEpoch(session);
    }
    stream.clearFlushTimer();
  }
}

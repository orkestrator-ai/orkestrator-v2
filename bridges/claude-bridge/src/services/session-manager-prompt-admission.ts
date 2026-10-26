import type { NormalizedMessage, PromptOptions, SessionState } from "../types/index.js";
import { eventEmitter } from "./event-emitter.js";
import {
  applySessionPlanMode,
  claimedPromptDispatches,
  generateMessageId,
  nextTurnGeneration,
  sessionOperationError,
  sessions,
} from "./session-manager-core.js";
import {
  forgetPromptDispatch,
  getPromptDispatchRecord,
  recordPromptDispatch,
} from "./session-manager-lifecycle.js";
import { attachmentTag, readPersistedSessionMessagesOnce } from "./session-manager-persistence.js";
import {
  createPromptStreamState,
  MAX_STREAM_CONTENT_BLOCK_INDEX,
} from "./session-manager-prompt-stream.js";
import {
  captureTurnStartup,
  createTurnState,
  type TurnStartupSnapshot,
  type TurnState,
} from "./session-manager-prompt-turn.js";
import { assertClaudeRuntimeStaticAccepts, openClaudeRuntime } from "./session-manager-runtime.js";
import { reconcileIdleClaudeRuntime } from "./session-manager-runtime-idle.js";
import { markTranscriptChanged, resetTranscriptEpoch } from "./transcript-revision.js";

export { MAX_STREAM_CONTENT_BLOCK_INDEX } from "./session-manager-prompt-stream.js";

// Everything a turn does before it touches the SDK: admission, the claims it
// makes on the session, the plan-mode toggle, the transcript read, the prompt
// row and the TurnState itself. Each async step ends at an await the turn
// always made, so splitting it out adds no new point where other work can run.

export const STREAM_EVENT_COALESCE_MS = 100;
/** What `admitPrompt` claimed for this turn, before its first await. */
export interface PromptAdmission {
  readonly session: SessionState;
  readonly sessionId: string;
  readonly dispatchRequestId: string | undefined;
  readonly structuredRequestId: string | undefined;
  readonly beforeStartup: TurnStartupSnapshot;
  readonly needsTranscriptHydration: boolean;
  /** See `TurnState.bootstrapClaudeUsage`. */
  readonly bootstrapClaudeUsage: boolean;
  readonly abortController: AbortController;
  readonly turnGeneration: number;
}

/**
 * Refuse, deduplicate or admit a prompt, and claim the foreground for it.
 *
 * Synchronous on purpose: everything here is claimed before the first await,
 * so a retry or a second prompt that arrives meanwhile already sees it.
 * Answers undefined for a request that was already dispatched.
 */
export function admitPrompt(
  sessionId: string,
  options: PromptOptions | undefined,
): PromptAdmission | undefined {
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
    return undefined;
  }
  if (
    structuredRequestId &&
    session.structuredOutputRequestId === structuredRequestId &&
    (session.status === "running" || session.structuredOutput !== undefined)
  ) {
    return undefined;
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
  return {
    session,
    sessionId,
    dispatchRequestId,
    structuredRequestId,
    beforeStartup,
    needsTranscriptHydration,
    bootstrapClaudeUsage,
    abortController,
    turnGeneration,
  };
}

/**
 * The plan-mode toggle a prompt states, when it differs from the session's.
 *
 * The UI maps its plan-mode toggle onto `plan` and the session's approval
 * mode (`bypassPermissions` unless the user picked another), so a prompt
 * carrying one of them is an authoritative statement of the toggle. Recording it here is a safety net behind the explicit preferences
 * endpoint (e.g. a toggle made before this session had a durable identity).
 * Other permission modes say nothing about the toggle and are left alone.
 */
export function promptPlanModeChange(
  session: SessionState,
  options: PromptOptions | undefined,
): boolean | undefined {
  const mode = options?.permissionMode;
  const statesToggle =
    mode === "plan" ||
    mode === "bypassPermissions" ||
    (mode !== undefined && mode !== "dontAsk" && mode === options?.approvalMode);
  return statesToggle && session.planMode !== (mode === "plan") ? mode === "plan" : undefined;
}

/** Record the prompt's plan-mode toggle; a failure hands every claim back. */
export async function applyPromptPlanMode(
  admission: PromptAdmission,
  planMode: boolean,
): Promise<void> {
  const {
    session,
    sessionId,
    dispatchRequestId,
    beforeStartup,
    needsTranscriptHydration,
    abortController,
    turnGeneration,
  } = admission;
  try {
    await applySessionPlanMode(session, planMode);
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
      session.interruption = beforeStartup.interruption;
      session.interruptedRequestId = beforeStartup.interruptedRequestId;
      session.lastActivity = beforeStartup.lastActivity;
      session.persistedMessagesLoaded = beforeStartup.persistedMessagesLoaded;
      if (needsTranscriptHydration) resetTranscriptEpoch(session);
      session.structuredOutput = beforeStartup.structuredOutput;
      session.structuredOutputRequestId = beforeStartup.structuredOutputRequestId;
      session.inProgressUsage = beforeStartup.inProgressUsage;
      session.inProgressUsageGeneration = beforeStartup.inProgressUsageGeneration;
      reconcileIdleClaudeRuntime(session);
    }
    if (dispatchRequestId) {
      forgetPromptDispatch(sessionId, dispatchRequestId);
    }
    throw error;
  }
}

/** The turn has started: clear what belonged to the previous one. */
export function beginPromptActivity(admission: PromptAdmission): void {
  const { session, sessionId } = admission;
  session.error = undefined;
  // This turn is the continuation of one a restart cut short, if there was one.
  session.interruption = undefined;
  session.interruptedRequestId = undefined;
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
}

/** `readTranscriptForPrompt` could not read the session's history. */
export const TRANSCRIPT_READ_FAILED = Symbol("transcript-read-failed");

/** Read the persisted transcript a turn needs before it can add to it. */
export async function readTranscriptForPrompt(
  session: SessionState,
): Promise<
  Awaited<ReturnType<typeof readPersistedSessionMessagesOnce>> | typeof TRANSCRIPT_READ_FAILED
> {
  try {
    return await readPersistedSessionMessagesOnce(session);
  } catch (error) {
    // A turn that cannot read its own history is not a debug-level event: the
    // transcript the user is looking at is incomplete until the retry lands.
    console.error(
      "[session-manager] Failed to hydrate transcript before prompt:",
      error instanceof Error ? error.message : String(error),
    );
    return TRANSCRIPT_READ_FAILED;
  }
}

/**
 * Install what `readTranscriptForPrompt` read. Answers whether the read
 * failed; see `TurnState.transcriptHydrationFailed`.
 */
export function installPromptTranscript(
  session: SessionState,
  read: Awaited<ReturnType<typeof readTranscriptForPrompt>>,
): boolean {
  if (read === TRANSCRIPT_READ_FAILED) return true;
  if (read) {
    session.messages = read.messages;
    session.taskRegistry = read.taskRegistry;
    session.backgroundTasks = read.backgroundTasks;
    resetTranscriptEpoch(session);
  }
  return false;
}

/** Add the prompt's own row, and build the text the SDK receives. */
export function appendPromptMessage(
  admission: PromptAdmission,
  prompt: string,
  options: PromptOptions | undefined,
): { userMessage: NormalizedMessage; sdkTextPrompt: string } {
  const { session, sessionId } = admission;
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
  return { userMessage, sdkTextPrompt };
}

/** The turn's state, with its stream and the session hooks it registers. */
export function createClaudeTurn(
  admission: PromptAdmission,
  input: {
    options: PromptOptions | undefined;
    userMessage: NormalizedMessage;
    transcriptHydrationFailed: boolean;
  },
): TurnState {
  const { session, sessionId } = admission;
  // A turn written into a running CLI shares its tool tracker, so reports for
  // tools an earlier turn started still find their rows.
  const runningRuntime = openClaudeRuntime(session);
  // Created before the turn's `try`, so the error path can still publish
  // whatever the coalescing window was holding.
  const stream = createPromptStreamState(session, sessionId, {
    flushIntervalMs: STREAM_EVENT_COALESCE_MS,
    maxBlockIndex: MAX_STREAM_CONTENT_BLOCK_INDEX,
    ...(runningRuntime
      ? { toolTracker: runningRuntime.toolTracker, activeTaskIds: runningRuntime.activeTaskIds }
      : {}),
  });
  const turn = createTurnState(session, sessionId, {
    options: input.options,
    structuredRequestId: admission.structuredRequestId,
    userMessage: input.userMessage,
    dispatchRequestId: admission.dispatchRequestId,
    beforeStartup: admission.beforeStartup,
    abortController: admission.abortController,
    turnGeneration: admission.turnGeneration,
    stream,
    bootstrapClaudeUsage: admission.bootstrapClaudeUsage,
    transcriptHydrationFailed: input.transcriptHydrationFailed,
  });
  admission.abortController.signal.addEventListener("abort", turn.observeAbort, { once: true });
  session.splitAssistantAfterSteer = turn.splitAssistantAfterSteer;
  return turn;
}

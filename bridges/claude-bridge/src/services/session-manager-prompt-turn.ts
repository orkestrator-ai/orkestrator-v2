import { createBridgeDiagnostics } from "@orkestrator/protocol/node/bridge-diagnostics";
import type { MeasuredWorkspaceChange } from "@orkestrator/protocol/tool-diff";
import type {
  NormalizedMessage,
  PermissionMode,
  PromptOptions,
  SessionState,
} from "../types/index.js";
import type { StructuredUsageRefreshCoordinator } from "./session-manager-core.js";
import type { PromptStreamState } from "./session-manager-prompt-stream.js";
import type { ClaudeRuntime, ClaudeRuntimeTurn } from "./session-manager-runtime.js";
import { finishTurnInputIfSettled } from "./session-manager-prompt-turn-lifecycle.js";
import { ClaudeStreamUsageAccumulator } from "./session-manager-usage.js";

/** Seams `sendPrompt` exposes to tests; never set in production. */
export interface PromptTestHooks {
  afterAttachmentSymlinkValidation?: (filePath: string) => void | Promise<void>;
  afterAttachmentCanonicalValidation?: (filePath: string) => void | Promise<void>;
  afterAttachmentInitialValidation?: (filePath: string) => void | Promise<void>;
  onQueryStarted?: () => void;
}

/**
 * The session fields a turn claims, as they were before it claimed them.
 *
 * Captured once, before the first reservation, so a startup that fails before
 * the SDK accepted the query can hand everything back exactly as it found it.
 */
export interface TurnStartupSnapshot {
  readonly runtime: SessionState["claudeRuntime"];
  readonly status: SessionState["status"];
  readonly turnStartedAt: SessionState["turnStartedAt"];
  readonly abortController: SessionState["abortController"];
  readonly error: SessionState["error"];
  readonly interruption: SessionState["interruption"];
  readonly lastActivity: SessionState["lastActivity"];
  readonly persistedMessagesLoaded: SessionState["persistedMessagesLoaded"];
  readonly structuredOutput: SessionState["structuredOutput"];
  readonly structuredOutputRequestId: SessionState["structuredOutputRequestId"];
  readonly latestTurnGeneration: SessionState["latestTurnGeneration"];
  readonly inProgressUsage: SessionState["inProgressUsage"];
  readonly inProgressUsageGeneration: SessionState["inProgressUsageGeneration"];
}

export function captureTurnStartup(session: SessionState): TurnStartupSnapshot {
  return {
    runtime: session.claudeRuntime,
    status: session.status,
    turnStartedAt: session.turnStartedAt,
    abortController: session.abortController,
    error: session.error,
    interruption: session.interruption,
    lastActivity: session.lastActivity,
    persistedMessagesLoaded: session.persistedMessagesLoaded,
    structuredOutput: session.structuredOutput,
    structuredOutputRequestId: session.structuredOutputRequestId,
    latestTurnGeneration: session.latestTurnGeneration,
    inProgressUsage: session.inProgressUsage,
    inProgressUsageGeneration: session.inProgressUsageGeneration,
  };
}

/**
 * Everything one `sendPrompt` turn shares between its closures.
 *
 * Mutable fields are read through the turn at the moment they are needed,
 * never copied out: `runtime` and `thisTurn` are assigned after the closures
 * that read them exist, and the flags change while frames are handled.
 */
export interface TurnState {
  readonly session: SessionState;
  readonly sessionId: string;
  readonly options: PromptOptions | undefined;
  /** Names this turn's structured result; set only when it asked for one. */
  readonly structuredRequestId: string | undefined;
  /** The transcript row of the prompt itself. */
  readonly userMessage: NormalizedMessage;
  /** Names this prompt on every result that answers it; see `resultAnswersOtherInput`. */
  readonly promptUuid: string;
  /** The caller's idempotency key, when it sent one. */
  readonly dispatchRequestId: string | undefined;
  readonly beforeStartup: TurnStartupSnapshot;
  readonly abortController: AbortController;
  readonly turnGeneration: number;
  readonly startedAt: number;
  readonly stream: PromptStreamState;
  readonly streamUsage: ClaudeStreamUsageAccumulator;
  readonly diagnostics: ReturnType<typeof createBridgeDiagnostics>;
  /**
   * Settled when this turn stops waiting on its runtime: superseded by a newer
   * turn, or the process ended. Rejected with the error a frame raised.
   */
  readonly turnEnded: Promise<void>;
  readonly resolveTurnEnded: () => void;
  readonly rejectTurnEnded: (error: unknown) => void;
  /**
   * Set when the pre-turn transcript read failed. The turn's `finally` clears
   * the hydration claim so the next transcript request retries.
   */
  readonly transcriptHydrationFailed: boolean;
  /**
   * Client uuids of the steers pushed into this turn: every one, and those no
   * result has named yet. See `resultSupersededBySteer`.
   */
  readonly steerUuids: Set<string>;
  readonly unansweredSteerUuids: Set<string>;
  /** Informational rows by the tool use they report on, so a repeat updates in place. */
  readonly informationalRowsByToolUse: Map<string, string>;
  /**
   * A measurement usually lands on a call the tracker already holds; one that
   * outruns the assistant message carrying the call waits here for its tool
   * result, which cannot precede it.
   */
  readonly pendingCommandChanges: Map<string, MeasuredWorkspaceChange>;
  /** This turn's `session.finishTurnInputIfSettled`, recognized by identity when it ends. */
  readonly finishTurnInputForThisTurn: () => void;
  /** Reports a stop to the diagnostics; the listener is removed when the turn ends. */
  readonly observeAbort: () => void;
  /** This turn's `session.splitAssistantAfterSteer`, recognized by identity when it ends. */
  readonly splitAssistantAfterSteer: () => void;

  sdkMessageCount: number;
  /** The mode this turn asked the CLI for. Set once the query policy is resolved. */
  permissionMode: PermissionMode | undefined;
  /** Names of the MCP servers this turn configured. Set once they are resolved. */
  mcpServerNames: Set<string>;
  /**
   * A bridge that attaches after the transcript already exists has no
   * in-memory cumulative origin. Its first result must be bootstrapped from
   * this query's streamed calls, or the whole transcript is published as one
   * new turn.
   */
  bootstrapClaudeUsage: boolean;
  queryIteratorControl: SessionState["queryControl"];
  /**
   * The CLI this turn runs on: the session's running one when it is still
   * alive, otherwise one this turn launches. Never a second one.
   */
  runtime: ClaudeRuntime | undefined;
  /** This turn as its runtime sees it. Assigned once the handlers exist. */
  thisTurn: ClaudeRuntimeTurn | undefined;
  /** Set when a newer turn took over the root conversation. */
  superseded: boolean;
  /**
   * A continuation the superseded turn was still waiting for when this turn
   * took over; see `inheritContinuation`.
   */
  inheritedContinuation: boolean;
  structuredUsageRefresh: StructuredUsageRefreshCoordinator | undefined;
  queryStarted: boolean;
  queryEnded: boolean;
  turnReleasedToBackgroundTasks: boolean;
  releasedTurnStartedAt: string | undefined;
  /**
   * Set while a released turn is waiting for the continuation a background
   * task notification triggers; the runtime's idle window bounds the wait.
   */
  awaitingContinuation: boolean;
  latestSteerUuid: string | undefined;
  receivedResult: boolean;
  /**
   * Unlike `receivedResult`, never reset: a task notification re-arms the turn
   * for a continuation whose result names no prompt at all.
   */
  receivedPromptResult: boolean;
  /**
   * True while the result handler awaits its final control round trips. The
   * handler settles the turn itself once they return; a hook or stop that
   * released the turn in that gap took ownership away from the handler, whose
   * ownership check then ended the loop early — and leaving the loop closes
   * the query, killing every background agent the turn had just released to.
   */
  settlingResult: boolean;
  localCommandOutputSeen: boolean;
  lastThinkingTokensEmitAt: number;
  compactedTokensBefore: number | undefined;
  /**
   * Feedback from a rejected plan, to re-send once the turn ends. When
   * ExitPlanMode is denied the SDK may end the turn without Claude seeing the
   * feedback, so `settleTurnEnd` re-prompts with it; an assistant response
   * after the denial shows Claude saw it, and clears it.
   */
  pendingPlanRejectionFeedback: string | null;
  /**
   * Set when the user approved a plan this turn: the defensive fallback for
   * the ExitPlanMode "approved but failed" case.
   *
   * The primary fix lives in `resolveQueryPlan`
   * (`session-manager-prompt-query.ts`): it forwards `permissionMode: "plan"`
   * to the SDK, so the SDK is genuinely in plan mode and its native
   * ExitPlanMode tool runs to success.
   *
   * The fallback covers the SDK's plan-mode handling misbehaving (older SDK
   * builds, future regressions, unforeseen edge cases): if the user approved
   * the plan but the SDK still marked the ExitPlanMode tool as `is_error`, we
   * neither surface a red "failure" nor let Claude abandon the turn. So:
   *   1) `turnCanUseTool` sets this flag when the user approves.
   *   2) After every tool_result is parsed, the `user` handler rewrites any
   *      ExitPlanMode tool in "failure" state to "success" with an
   *      explanatory output, so the UI renders it the way the user expects.
   *   3) It also sets `pendingPlanApprovalContinuation`, so that when the SDK
   *      ends the turn (as it usually does after a failed ExitPlanMode),
   *      `settleTurnEnd` re-prompts Claude, outside plan mode, to implement.
   *
   * When the SDK behaves correctly the tool is already in "success" state and
   * none of the override or re-prompt logic fires.
   */
  planApprovedThisTurn: boolean;
  /** The continuation prompt the fallback on `planApprovedThisTurn` owes. */
  pendingPlanApprovalContinuation: string | null;
}

export function createTurnState(
  session: SessionState,
  sessionId: string,
  init: {
    options: PromptOptions | undefined;
    structuredRequestId: string | undefined;
    userMessage: NormalizedMessage;
    dispatchRequestId: string | undefined;
    beforeStartup: TurnStartupSnapshot;
    abortController: AbortController;
    turnGeneration: number;
    stream: PromptStreamState;
    bootstrapClaudeUsage: boolean;
    transcriptHydrationFailed: boolean;
  },
): TurnState {
  let resolveTurnEnded!: () => void;
  let rejectTurnEnded!: (error: unknown) => void;
  const turnEnded = new Promise<void>((resolve, reject) => {
    resolveTurnEnded = resolve;
    rejectTurnEnded = reject;
  });
  // The process can fail before this turn reaches its `await` (while agent
  // discovery is in flight, say). The await still observes the error; this
  // only keeps an early rejection from being reported as unhandled.
  turnEnded.catch(() => {});
  const state: Omit<TurnState, "diagnostics"> = {
    ...init,
    session,
    sessionId,
    promptUuid: crypto.randomUUID(),
    startedAt: Date.now(),
    streamUsage: new ClaudeStreamUsageAccumulator(),
    turnEnded,
    resolveTurnEnded,
    rejectTurnEnded,
    steerUuids: new Set(),
    unansweredSteerUuids: new Set(),
    informationalRowsByToolUse: new Map(),
    pendingCommandChanges: new Map(),
    finishTurnInputForThisTurn: () => finishTurnInputIfSettled(state as TurnState),
    observeAbort: () => {
      (state as TurnState).diagnostics?.requestCancellation();
    },
    splitAssistantAfterSteer: () => {
      init.stream.beginPostSteerScope();
    },
    sdkMessageCount: 0,
    permissionMode: undefined,
    mcpServerNames: new Set(),
    queryIteratorControl: undefined,
    runtime: undefined,
    thisTurn: undefined,
    superseded: false,
    inheritedContinuation: false,
    structuredUsageRefresh: undefined,
    queryStarted: false,
    queryEnded: false,
    turnReleasedToBackgroundTasks: false,
    releasedTurnStartedAt: undefined,
    awaitingContinuation: false,
    latestSteerUuid: undefined,
    receivedResult: false,
    receivedPromptResult: false,
    settlingResult: false,
    localCommandOutputSeen: false,
    lastThinkingTokensEmitAt: 0,
    compactedTokensBefore: undefined,
    pendingPlanRejectionFeedback: null,
    planApprovedThisTurn: false,
    pendingPlanApprovalContinuation: null,
  };
  // Reports its first line from the constructor, so the metrics it reads must
  // already exist; they are read from the turn itself, never copied.
  const diagnostics = createBridgeDiagnostics(
    "claude",
    {
      id: sessionId,
      get status() {
        return session.status;
      },
    },
    () => ({
      sdkMessageCount: state.sdkMessageCount,
      cancelled: init.abortController.signal.aborted,
    }),
  );
  return Object.assign(state, { diagnostics });
}

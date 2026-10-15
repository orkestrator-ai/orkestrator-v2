import { createBridgeDiagnostics } from "@orkestrator/protocol/node/bridge-diagnostics";
import type { SessionState } from "../types/index.js";
import type { StructuredUsageRefreshCoordinator } from "./session-manager-core.js";
import type { PromptStreamState } from "./session-manager-prompt-stream.js";
import type { ClaudeRuntime, ClaudeRuntimeTurn } from "./session-manager-runtime.js";
import { ClaudeStreamUsageAccumulator } from "./session-manager-usage.js";

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

  sdkMessageCount: number;
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
  closeSdkInput: (() => void) | undefined;
  finishTurnInputForThisTurn: (() => void) | undefined;
  turnReleasedToBackgroundTasks: boolean;
  releasedTurnStartedAt: string | undefined;
  /**
   * Armed while a released turn is waiting for the continuation a background
   * task notification triggers, so the `finally` can always disarm it.
   */
  retainedContinuationTimer: ReturnType<typeof setTimeout> | null;
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
}

export function createTurnState(
  session: SessionState,
  sessionId: string,
  init: {
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
    startedAt: Date.now(),
    streamUsage: new ClaudeStreamUsageAccumulator(),
    turnEnded,
    resolveTurnEnded,
    rejectTurnEnded,
    sdkMessageCount: 0,
    queryIteratorControl: undefined,
    runtime: undefined,
    thisTurn: undefined,
    superseded: false,
    inheritedContinuation: false,
    structuredUsageRefresh: undefined,
    queryStarted: false,
    queryEnded: false,
    closeSdkInput: undefined,
    finishTurnInputForThisTurn: undefined,
    turnReleasedToBackgroundTasks: false,
    releasedTurnStartedAt: undefined,
    retainedContinuationTimer: null,
    latestSteerUuid: undefined,
    receivedResult: false,
    receivedPromptResult: false,
    settlingResult: false,
    localCommandOutputSeen: false,
    lastThinkingTokensEmitAt: 0,
    compactedTokensBefore: undefined,
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

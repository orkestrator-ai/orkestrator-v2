import type { AgentTabState } from "@orkestrator/protocol/agent-registry";

/**
 * Is this delegation finished? The one place that answers it, for all three
 * paths that ask. Reads stay in the callers (`coordinator-service.ts`), which
 * gather what is true now and act on the answer; closing and waking are theirs.
 *
 * | Evidence | Decision |
 * | --- | --- |
 * | Turn end, failed | close `failed`, whatever else is true |
 * | Environment missing or deleting | close `stopped`, whatever else is true |
 * | Environment in error | close `failed`, whatever else is true |
 * | Any other, with a request not yet delivered | stay open: this turn cannot be its answer |
 * | Turn end, stopped | close `stopped` |
 * | Environment stopped | close `stopped` (remote: after the rule below) |
 * | Turn running, waiting, unreadable, or environment creating | stay open |
 * | Idle, inside the grace period, never seen working | stay open: it may not have started |
 * | Idle, with a goal running | stay open: that idle is the loop's, not the worker's answer |
 * | Turn ended or idle, coordinator stopped it or a person is needed | close `completed` |
 * | Same, background work not yet read | `check-background` |
 * | Same, no background work, or a report is already held | close `completed` |
 * | Same, background work running, within the hold | stay open |
 * | Same, background work running, past the hold | close `completed`, saying so |
 *
 * The three paths differ in these ways, each on purpose:
 *
 * - **A turn-end edge ignores grace, seen-working and goals.** The edge is itself
 *   proof the turn ended, and its callers have settled the goal question: the
 *   activity edge skips settling while a goal holds the turn, and the goal's own
 *   release and an acknowledged `stop_worker_turn` are ends that should settle.
 * - **Only the remote path has seen-working.** A remote turn end has no edge here,
 *   so idle after working stands in for one. Locally it is always false, and the
 *   edge covers that case.
 * - **Only a remote stopped environment waits for grace.** A worker launched
 *   moments ago can still read as stopped on its node, and a node may not report
 *   the pending startup prompt. Locally that prompt counts as undelivered.
 * - **A background read costs a process probe or a mail read**, and the remote
 *   path must collect mail before reading held reports, so it is asked for only
 *   when it can change the answer (`check-background`).
 */
export type DelegationOutcome = "completed" | "failed" | "stopped";

export type DelegationEnvironment =
  "missing" | "deleting" | "error" | "stopped" | "running" | "creating";

export type DelegationEvidence =
  /** An observed turn-end edge. */
  | { source: "turn-end"; outcome: DelegationOutcome }
  /** A read of a local worker, or of a worker on another node. */
  | { source: "sweep" | "remote"; environment: DelegationEnvironment; turn: AgentTabState };

/** What the delegation itself remembers. */
export interface DelegationDecisionState {
  /** When the coordinator last asked; a value that cannot be read never ends the grace period. */
  askedAt: number;
  /** The coordinator stopped this turn (`stop_worker_turn`): the end is the answer. */
  stopRequested: boolean;
  /** Remote only: seen working or waiting since it was last asked. */
  seenWorking: boolean;
  /** When this request's current background hold began, if one has. */
  backgroundHoldSince?: number;
}

/** What is true now, gathered by the caller. */
export interface DelegationObservations {
  now: number;
  evidence: DelegationEvidence;
  undeliveredRequest: boolean;
  goalRunning: boolean;
  /** A command in the worker's environment is waiting on the user. */
  needsHuman: boolean;
  /** Absent until read; see `check-background`. */
  backgroundWork?: { running: boolean; reportHeld: boolean };
  graceMs: number;
  backgroundHoldMs: number;
}

export type DelegationStayReason =
  "request-undelivered" | "turn-running" | "not-started" | "goal-running" | "background-work";

export type DelegationDecision =
  | {
      action: "stay-open";
      reason: DelegationStayReason;
      /** Set while held for background work: when that hold began. */
      backgroundHoldSince?: number;
      /** The worker was seen working, which starts a fresh hold budget. */
      resetBackgroundHold?: boolean;
    }
  | { action: "check-background" }
  | { action: "close"; state: DelegationOutcome; backgroundWorkTimeoutMs?: number };

function close(state: DelegationOutcome): DelegationDecision {
  return { action: "close", state };
}

function stay(reason: DelegationStayReason): DelegationDecision {
  return { action: "stay-open", reason };
}

/** The turn has ended and nothing else holds it: only background work can still. */
function decideEndedTurn(
  state: DelegationDecisionState,
  observations: DelegationObservations,
): DelegationDecision {
  if (state.stopRequested || observations.needsHuman) return close("completed");
  const background = observations.backgroundWork;
  if (!background) return { action: "check-background" };
  // A worker that reported has answered, however much is still running.
  if (!background.running || background.reportHeld) return close("completed");
  const since = state.backgroundHoldSince ?? observations.now;
  return observations.now - since < observations.backgroundHoldMs
    ? { action: "stay-open", reason: "background-work", backgroundHoldSince: since }
    : {
        action: "close",
        state: "completed",
        backgroundWorkTimeoutMs: observations.backgroundHoldMs,
      };
}

export function decideDelegation(
  state: DelegationDecisionState,
  observations: DelegationObservations,
): DelegationDecision {
  const { evidence } = observations;
  if (evidence.source === "turn-end") {
    if (evidence.outcome === "failed") return close("failed");
    if (observations.undeliveredRequest) return stay("request-undelivered");
    if (evidence.outcome === "stopped") return close("stopped");
    return decideEndedTurn(state, observations);
  }
  const started = state.seenWorking || observations.now - state.askedAt >= observations.graceMs;
  switch (evidence.environment) {
    case "missing":
    case "deleting":
      return close("stopped");
    case "error":
      return close("failed");
    case "creating":
      return stay("turn-running");
    case "stopped":
      if (observations.undeliveredRequest) return stay("request-undelivered");
      if (evidence.source === "remote" && !started) return stay("not-started");
      return close("stopped");
    case "running":
      if (evidence.turn === "working") {
        return { action: "stay-open", reason: "turn-running", resetBackgroundHold: true };
      }
      if (evidence.turn !== "idle") return stay("turn-running");
      if (!started) return stay("not-started");
      if (observations.undeliveredRequest) return stay("request-undelivered");
      if (observations.goalRunning) return stay("goal-running");
      return decideEndedTurn(state, observations);
  }
}

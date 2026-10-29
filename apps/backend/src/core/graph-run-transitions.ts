/**
 * Pure state transitions of a graph run and its activations (plan P2.2,
 * P2.3; report §8.1).
 *
 * The pass builds the next record from the current one with these functions
 * and saves it with compare-and-swap; nothing here reads storage, the clock or
 * an executor. Every transition is checked against an explicit table, so an
 * executor that reports an impossible move (a terminal activation starting
 * again) cannot corrupt the record: the pass turns the refusal into a
 * `system-error` failure of that activation instead.
 *
 * Run statuses:
 *
 * | From | To |
 * | --- | --- |
 * | `provisioning` | `running`, `cancelling`, `failed`, `cancelled` |
 * | `running` | `waiting`, `paused`, `cancelling`, `complete`, `failed` |
 * | `waiting` | `running`, `paused`, `cancelling`, `complete`, `failed` |
 * | `paused` | `running`, `waiting`, `cancelling`, `complete`, `failed` |
 * | `cancelling` | `cancelled`, `failed` |
 *
 * A run that fails while activations are admitted goes through `cancelling`
 * (its error already recorded) so their executors are stopped first, and ends
 * `failed`; a cancelled one ends `cancelled`.
 */
import {
  GRAPH_RUN_BOUNDS,
  boundGraphError,
  isGraphActivationTerminal,
  replaceGraphActivation,
  type GraphActivationState,
  type GraphRun,
  type GraphRunStatus,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type { GraphActivationReport } from "./graph-run-executors.js";

export const GRAPH_RUN_STATUS_TRANSITIONS: Readonly<
  Record<GraphRunStatus, readonly GraphRunStatus[]>
> = {
  provisioning: ["running", "cancelling", "failed", "cancelled"],
  running: ["waiting", "paused", "cancelling", "complete", "failed"],
  waiting: ["running", "paused", "cancelling", "complete", "failed"],
  paused: ["running", "waiting", "cancelling", "complete", "failed"],
  cancelling: ["cancelled", "failed"],
  complete: [],
  failed: [],
  cancelled: [],
};

/**
 * Activation states. `ready → admitting` is the scheduler's; executors move
 * an admitted activation. `waiting` and `ready` activations end `skipped` or
 * `cancelled` without an executor.
 */
export const GRAPH_ACTIVATION_TRANSITIONS: Readonly<
  Record<GraphActivationState, readonly GraphActivationState[]>
> = {
  waiting: ["ready", "skipped", "cancelled", "failed"],
  ready: ["admitting", "skipped", "cancelled", "failed"],
  admitting: ["running", "awaiting-human", "complete", "failed", "cancelled"],
  running: ["running", "awaiting-human", "complete", "failed", "cancelled"],
  "awaiting-human": ["running", "awaiting-human", "complete", "failed", "cancelled"],
  complete: [],
  failed: [],
  skipped: [],
  cancelled: [],
  superseded: [],
};

/** States in which an executor owns the activation (it holds locks and slots). */
export const GRAPH_ADMITTED_ACTIVATION_STATES = [
  "admitting",
  "running",
  "awaiting-human",
] as const satisfies readonly GraphActivationState[];

export function isGraphActivationAdmitted(state: GraphActivationState): boolean {
  return (GRAPH_ADMITTED_ACTIVATION_STATES as readonly string[]).includes(state);
}

export class GraphRunTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphRunTransitionError";
  }
}

export function canTransitionGraphRun(from: GraphRunStatus, to: GraphRunStatus): boolean {
  return from === to || GRAPH_RUN_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The run in `status`, stamping `startedAt` on the first `running`,
 * `finishedAt` on a terminal status and `cancelRequestedAt` on `cancelling`.
 * Throws {@link GraphRunTransitionError} for a move the table does not allow.
 */
export function transitionGraphRun(
  run: GraphRun,
  status: GraphRunStatus,
  at: string,
  failure?: { error: string; cause: GraphErrorCause },
): GraphRun {
  if (!canTransitionGraphRun(run.status, status)) {
    throw new GraphRunTransitionError(`A ${run.status} run cannot become ${status}`);
  }
  const next: GraphRun = { ...run, status };
  if (status === "running" && next.startedAt === undefined) next.startedAt = at;
  if (status === "cancelling" && next.cancelRequestedAt === undefined) {
    next.cancelRequestedAt = at;
  }
  if (status === "complete" || status === "failed" || status === "cancelled") {
    next.finishedAt ??= at;
  }
  if (failure && next.error === undefined) {
    next.error = boundGraphError(failure.error);
    next.errorCause = failure.cause;
  }
  return next;
}

export type GraphReportOutcome =
  | { ok: true; run: GraphRun; activation: NodeActivation; changed: boolean }
  | { ok: false; message: string };

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Applies one executor report to activation `key`. Returns the next run, or a
 * refusal when the report moves the activation somewhere the table does not
 * allow (or names a field the record cannot hold). A report for an
 * activation that is already terminal changes nothing.
 */
export function applyGraphActivationReport(
  run: GraphRun,
  key: string,
  report: GraphActivationReport,
  at: string,
): GraphReportOutcome {
  const current = run.activations.find((activation) => activation.key === key);
  if (!current) return { ok: false, message: "The run has no such activation" };
  if (isGraphActivationTerminal(current.state)) {
    return { ok: true, run, activation: current, changed: false };
  }
  const target: GraphActivationState = report.state === "unchanged" ? current.state : report.state;
  if (target !== current.state && !GRAPH_ACTIVATION_TRANSITIONS[current.state].includes(target)) {
    return {
      ok: false,
      message: `An executor cannot move a ${current.state} activation to ${target}`,
    };
  }
  if (
    report.state === "unchanged" &&
    current.state !== "running" &&
    current.state !== "awaiting-human" &&
    current.state !== "admitting"
  ) {
    return { ok: false, message: `An executor does not own a ${current.state} activation` };
  }
  const next: NodeActivation = { ...current, state: target };
  if (report.session) next.session = { ...report.session };
  if (report.policy) next.policy = report.policy;
  if (report.enforcement) next.enforcement = report.enforcement;
  if (report.enforcementReason !== undefined) next.enforcementReason = report.enforcementReason;
  if (report.baseline) next.baseline = { ...report.baseline };
  if (report.worktree) next.worktree = { ...report.worktree };
  if (report.guards) next.guards = report.guards.slice(-GRAPH_RUN_BOUNDS.maxGuardResults);
  if (report.human) next.human = { ...report.human };
  if ((target === "running" || target === "awaiting-human") && next.startedAt === undefined) {
    next.startedAt = at;
  }
  if (report.state === "complete") {
    next.outputs = { ...report.outputs };
    if (report.outlet !== undefined) next.outlet = report.outlet;
  }
  if (report.state === "failed") {
    if (report.outputs) next.outputs = { ...report.outputs };
    next.error = boundGraphError(report.error);
    next.errorCause = report.cause;
  }
  if (report.state === "cancelled" && report.error !== undefined) {
    next.error = boundGraphError(report.error);
  }
  if (isGraphActivationTerminal(target)) {
    next.startedAt ??= at;
    next.finishedAt = at;
  }
  if (next.session && (next.policy === undefined || next.enforcement === undefined)) {
    return {
      ok: false,
      message: "An activation records its policy and enforcement tier before its session",
    };
  }
  const replaced = replaceGraphActivation(run, key, () => next);
  if (!replaced.ok) return { ok: false, message: replaced.message };
  let updated = replaced.run;
  if (report.usage && (report.usage.tokens > 0 || (report.usage.cacheReadTokens ?? 0) > 0)) {
    const tokens = Math.max(0, Math.floor(report.usage.tokens));
    const cacheRead = Math.max(0, Math.floor(report.usage.cacheReadTokens ?? 0));
    updated = {
      ...updated,
      usage: {
        ...updated.usage,
        tokens: updated.usage.tokens + tokens,
        ...(cacheRead > 0 || updated.usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: (updated.usage.cacheReadTokens ?? 0) + cacheRead }
          : {}),
      },
    };
  }
  const changed = updated.usage !== replaced.run.usage || !sameJson(current, next);
  return { ok: true, run: changed ? updated : run, activation: next, changed };
}

/** Moves activation `key` to a terminal state the scheduler decides (skip, cancel, fail). */
export function settleGraphActivation(
  run: GraphRun,
  key: string,
  state: "skipped" | "cancelled" | "failed",
  at: string,
  /** A cancelled activation may carry an explanation without a cause. */
  failure?: { error: string; cause?: GraphErrorCause },
): GraphRun {
  const replaced = replaceGraphActivation(run, key, (activation) => {
    if (
      activation.state !== state &&
      !GRAPH_ACTIVATION_TRANSITIONS[activation.state].includes(state)
    ) {
      throw new GraphRunTransitionError(`A ${activation.state} activation cannot become ${state}`);
    }
    return {
      ...activation,
      state,
      finishedAt: at,
      ...(failure ? { error: boundGraphError(failure.error) } : {}),
      ...(failure?.cause ? { errorCause: failure.cause } : {}),
    };
  });
  if (!replaced.ok) throw new GraphRunTransitionError(replaced.message);
  return replaced.run;
}

/** The scheduler's `ready → admitting`, counting an agent session against the run's budget. */
export function admitGraphActivation(run: GraphRun, key: string, agentSession: boolean): GraphRun {
  const replaced = replaceGraphActivation(run, key, (activation) => {
    if (activation.state !== "ready") {
      throw new GraphRunTransitionError(`A ${activation.state} activation cannot be admitted`);
    }
    return { ...activation, state: "admitting" };
  });
  if (!replaced.ok) throw new GraphRunTransitionError(replaced.message);
  if (!agentSession) return replaced.run;
  return {
    ...replaced.run,
    usage: { ...replaced.run.usage, agentSessions: replaced.run.usage.agentSessions + 1 },
  };
}

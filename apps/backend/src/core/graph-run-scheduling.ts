/**
 * Scheduling decisions of a graph run pass (plan P2.3, decision D3, report
 * §6.7, §8.2, §5.11). Pure functions over the run record:
 *
 * 1. **Planning** ({@link planGraphRun}) to a fixpoint: retries and
 *    `onFailure` of failed activations, loop progress (`graph-run-loops.ts`)
 *    and the ready set (`graph-run-ready-set.ts`). The 200 live-activation
 *    hard cap and the history bound refuse an append; the run then fails with
 *    `budget-exceeded`.
 * 2. **Workspace locks** (D3, §6.7): at most one writing activation per
 *    workspace, and no reader while a writer holds it, across every run on
 *    the environment ({@link GraphWorkspaceLocks}). A blocked writer is not
 *    overtaken by later workspace users in the same pass, so it cannot starve.
 * 3. **Admission** ({@link selectGraphAdmissions}): `limits.maxConcurrentAgents`
 *    admitted agent activations at once, and `limits.maxAgentSessions` agent
 *    activations over the run's life (`usage.agentSessions`, counted at
 *    admission). An agent activation that can never get a session fails with
 *    `budget-exceeded`. The per-operation caps (4 starting, 8 observing, 4 per
 *    provider, ceiling 16) and the shared `workflow-provider` pool apply in
 *    the pass (`graph-run-pass.ts`).
 *
 * The compiler already proves the worst case fits these limits and that no
 * reader and writer can overlap; the runtime checks are the enforcement, so
 * a restart, a rewind or a bug cannot exceed them either.
 */
import type { GraphPlanNode, GraphPlanRunOutput } from "@orkestrator/protocol/graphs/compile";
import {
  appendGraphActivation,
  graphActivationKey,
  isGraphActivationTerminal,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphWorkspaceAccess } from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import { graphLoopState } from "./graph-run-loops.js";
import { computeGraphReadySet, resolveGraphEdgeSource } from "./graph-run-ready-set.js";
import { isGraphActivationAdmitted } from "./graph-run-transitions.js";
import { GraphRunView, type GraphValueCache } from "./graph-run-view.js";

export interface GraphRunFailure {
  error: string;
  cause: GraphErrorCause;
}

export interface GraphPlanningResult {
  run: GraphRun;
  /** Activations created: ready, skipped, failed inputs and retries. */
  created: number;
  skipped: number;
  retried: number;
  loopsAdvanced: number;
  /** Artifact values a `when` or `until` needs before planning can go further. */
  needValues: string[];
  /** Node positions still waiting on inputs. */
  waiting: number;
  /** Loops that are done at their current iteration. */
  doneLoops: string[];
  /** Set when an activation failed with `onFailure: fail-run`, or a bound refused an append. */
  failure?: GraphRunFailure;
}

/** Planning rounds per call; each round creates an activation or advances a loop. */
const MAX_PLANNING_ROUNDS = 1_000;

function retryActivation(view: GraphRunView, failed: NodeActivation, at: string): NodeActivation {
  const attempt = view.nextAttempt(failed.nodeId, failed.iteration, failed.branchKey);
  const parts = {
    nodeId: failed.nodeId,
    iteration: failed.iteration,
    attempt,
    ...(failed.branchKey !== undefined ? { branchKey: failed.branchKey } : {}),
  };
  return {
    key: graphActivationKey(parts),
    ...parts,
    state: "ready",
    // A retry reruns the node position with the same inputs.
    inputs: structuredClone(failed.inputs),
    outputs: {},
    createdAt: at,
  };
}

/**
 * Retries and `onFailure` for the latest failed activation of each node
 * position. Returns the retries to create, or the run failure.
 */
function failurePolicy(
  view: GraphRunView,
  at: string,
): { retries: NodeActivation[]; failure?: GraphRunFailure } {
  const retries: NodeActivation[] = [];
  for (const activation of view.latestActivations()) {
    if (activation.state !== "failed") continue;
    const node = view.node(activation.nodeId);
    const cause = activation.errorCause;
    if (
      cause !== undefined &&
      (node.retry.on as readonly GraphErrorCause[]).includes(cause) &&
      view.liveAttempts(activation) < node.retry.attempts
    ) {
      retries.push(retryActivation(view, activation, at));
      continue;
    }
    if (node.onFailure === "fail-run") {
      return {
        retries: [],
        failure: {
          error: `Node ${node.id} failed${activation.error ? `: ${activation.error}` : ""}`,
          cause: cause ?? "system-error",
        },
      };
    }
    // `skip` and `route`: the failed activation's outputs (none, or the
    // routed error artifact) are what its consumers see.
  }
  return { retries };
}

function append(
  run: GraphRun,
  activation: NodeActivation,
): { run: GraphRun } | { failure: GraphRunFailure } {
  const change = appendGraphActivation(run, activation);
  if (change.ok) return { run: change.run };
  return { failure: { error: change.message, cause: "budget-exceeded" } };
}

/**
 * Plans a run to a fixpoint: every activation that can be created now is,
 * every loop that can advance does. `values` holds the artifact values loaded
 * so far; `needValues` lists what to load before calling again.
 */
export function planGraphRun(
  run: GraphRun,
  options: { at: string; values: GraphValueCache },
): GraphPlanningResult {
  let current = run;
  const result: Omit<GraphPlanningResult, "run"> = {
    created: 0,
    skipped: 0,
    retried: 0,
    loopsAdvanced: 0,
    needValues: [],
    waiting: 0,
    doneLoops: [],
  };
  const needValues = new Set<string>();
  for (let round = 0; round < MAX_PLANNING_ROUNDS; round++) {
    needValues.clear();
    const view = new GraphRunView(current, options.values);
    const failures = failurePolicy(view, options.at);
    if (failures.failure) return { ...result, run: current, failure: failures.failure };
    if (failures.retries.length > 0) {
      for (const retry of failures.retries) {
        const appended = append(current, retry);
        if ("failure" in appended) return { ...result, run: current, failure: appended.failure };
        current = appended.run;
      }
      result.created += failures.retries.length;
      result.retried += failures.retries.length;
      continue;
    }
    const done = new Set<string>();
    let advanced = false;
    for (const loop of view.plan.loops) {
      const state = graphLoopState(view, loop);
      if (state.state === "done") done.add(loop.id);
      else if (state.state === "needs-values") state.ids.forEach((id) => needValues.add(id));
      else if (state.state === "next") {
        current = {
          ...current,
          loopIterations: { ...current.loopIterations, [loop.id]: state.iteration },
        };
        advanced = true;
        result.loopsAdvanced += 1;
      }
    }
    if (advanced) continue;
    const ready = computeGraphReadySet(view, { at: options.at, loopDone: (id) => done.has(id) });
    ready.needValues.forEach((id) => needValues.add(id));
    result.waiting = ready.waiting;
    result.doneLoops = [...done];
    for (const activation of ready.created) {
      const appended = append(current, activation);
      if ("failure" in appended) return { ...result, run: current, failure: appended.failure };
      current = appended.run;
      result.created += 1;
      if (activation.state === "skipped") result.skipped += 1;
    }
    if (ready.created.length === 0) break;
  }
  result.needValues = [...needValues];
  return { ...result, run: current };
}

// ---------------------------------------------------------------- outputs

/** Required run outputs that were not produced, by name (checked when a run settles). */
export function missingGraphRunOutputs(run: GraphRun): string[] {
  const view = new GraphRunView(run);
  return run.plan.outputs.flatMap((output: GraphPlanRunOutput) => {
    if (!output.required) return [];
    const resolved = resolveGraphEdgeSource(view, output.from, {
      consumer: null,
      port: null,
      iteration: 1,
      zip: false,
      loopDone: () => true,
    });
    return resolved.kind === "live" ? [] : [output.name];
  });
}

// ---------------------------------------------------------------- workspace locks

/** What a run's admitted activations hold on its workspace. */
export interface GraphWorkspaceHold {
  writers: number;
  readers: number;
}

const NO_HOLD: GraphWorkspaceHold = { writers: 0, readers: 0 };

/** D3 and §6.7: one writer and nobody else, or any number of readers. */
export function graphWorkspaceAllows(
  hold: GraphWorkspaceHold,
  access: GraphWorkspaceAccess,
): boolean {
  if (access === "none") return true;
  if (access === "write") return hold.writers === 0 && hold.readers === 0;
  return hold.writers === 0;
}

function addHold(hold: GraphWorkspaceHold, access: GraphWorkspaceAccess): GraphWorkspaceHold {
  if (access === "write") return { ...hold, writers: hold.writers + 1 };
  if (access === "read") return { ...hold, readers: hold.readers + 1 };
  return hold;
}

/** The holds of a run's admitted activations. */
export function graphRunWorkspaceHold(run: GraphRun): GraphWorkspaceHold {
  const nodes = new Map(run.plan.nodes.map((node) => [node.id, node]));
  let hold = NO_HOLD;
  for (const activation of run.activations) {
    if (!isGraphActivationAdmitted(activation.state)) continue;
    const node = nodes.get(activation.nodeId);
    if (node) hold = addHold(hold, node.workspaceAccess);
  }
  return hold;
}

/**
 * In-memory workspace locks across runs, keyed by environment. A projection
 * of the stored runs' admitted activations: each pass replaces its run's
 * holds, and startup recovery seeds every run's before any admission.
 */
export class GraphWorkspaceLocks {
  private readonly byWorkspace = new Map<string, Map<string, GraphWorkspaceHold>>();
  private readonly workspaceOf = new Map<string, string>();

  /** Replaces a run's holds. Returns true when it released something another run may wait for. */
  set(runId: string, workspace: string | undefined, hold: GraphWorkspaceHold): boolean {
    const previousWorkspace = this.workspaceOf.get(runId);
    const previous =
      previousWorkspace === undefined
        ? NO_HOLD
        : (this.byWorkspace.get(previousWorkspace)?.get(runId) ?? NO_HOLD);
    if (previousWorkspace !== undefined && previousWorkspace !== workspace) this.release(runId);
    if (workspace === undefined || (hold.writers === 0 && hold.readers === 0)) {
      this.release(runId);
    } else {
      let runs = this.byWorkspace.get(workspace);
      if (!runs) {
        runs = new Map();
        this.byWorkspace.set(workspace, runs);
      }
      runs.set(runId, { ...hold });
      this.workspaceOf.set(runId, workspace);
    }
    return hold.writers < previous.writers || hold.readers < previous.readers;
  }

  release(runId: string): void {
    const workspace = this.workspaceOf.get(runId);
    if (workspace === undefined) return;
    this.workspaceOf.delete(runId);
    const runs = this.byWorkspace.get(workspace);
    runs?.delete(runId);
    if (runs?.size === 0) this.byWorkspace.delete(workspace);
  }

  /** What every other run holds on `workspace`. */
  others(workspace: string, runId: string): GraphWorkspaceHold {
    let total = NO_HOLD;
    for (const [owner, hold] of this.byWorkspace.get(workspace) ?? []) {
      if (owner === runId) continue;
      total = { writers: total.writers + hold.writers, readers: total.readers + hold.readers };
    }
    return total;
  }

  /** Workspaces with at least one hold (diagnostics). */
  size(): number {
    return this.byWorkspace.size;
  }
}

// ---------------------------------------------------------------- admission

export type GraphAdmissionBlock =
  /** `limits.maxConcurrentAgents` agent activations are admitted. */
  | "concurrency"
  /** A writer holds the workspace, or this writer waits for readers (D3). */
  | "workspace-lock"
  /** Startup recovery has not yet seeded the other runs' locks. */
  | "recovering";

export interface GraphAdmissionCandidate {
  key: string;
  node: GraphPlanNode;
  /** Takes an agent session: counts against both limits. */
  agent: boolean;
}

export interface GraphAdmissionDecision {
  admit: GraphAdmissionCandidate[];
  blocked: { key: string; reason: GraphAdmissionBlock }[];
  /** Agent activations the session budget can never admit: fail them (`budget-exceeded`). */
  exhausted: string[];
}

/**
 * Chooses which ready activations to admit now, in record order (plan order
 * within a round). `others` is what other runs hold on this run's workspace;
 * `workspaceKnown` is false until startup recovery seeded the lock table.
 */
export function selectGraphAdmissions(
  run: GraphRun,
  options: { others: GraphWorkspaceHold; workspaceKnown: boolean },
): GraphAdmissionDecision {
  const nodes = new Map(run.plan.nodes.map((node) => [node.id, node]));
  const decision: GraphAdmissionDecision = { admit: [], blocked: [], exhausted: [] };
  let mine = graphRunWorkspaceHold(run);
  let agents = run.activations.filter(
    (activation) =>
      isGraphActivationAdmitted(activation.state) && nodes.get(activation.nodeId)?.kind === "agent",
  ).length;
  let sessions = run.usage.agentSessions;
  let writerWaiting = false;
  for (const activation of run.activations) {
    if (activation.state !== "ready") continue;
    const node = nodes.get(activation.nodeId);
    if (!node) continue;
    const agent = node.kind === "agent";
    if (agent && sessions >= run.plan.limits.maxAgentSessions) {
      decision.exhausted.push(activation.key);
      continue;
    }
    if (agent && agents >= run.plan.limits.maxConcurrentAgents) {
      decision.blocked.push({ key: activation.key, reason: "concurrency" });
      continue;
    }
    const access = node.workspaceAccess;
    if (access !== "none") {
      if (!options.workspaceKnown) {
        decision.blocked.push({ key: activation.key, reason: "recovering" });
        continue;
      }
      const held = {
        writers: mine.writers + options.others.writers,
        readers: mine.readers + options.others.readers,
      };
      if (writerWaiting || !graphWorkspaceAllows(held, access)) {
        decision.blocked.push({ key: activation.key, reason: "workspace-lock" });
        if (access === "write") writerWaiting = true;
        continue;
      }
      mine = addHold(mine, access);
    }
    if (agent) {
      agents += 1;
      sessions += 1;
    }
    decision.admit.push({ key: activation.key, node, agent });
  }
  return decision;
}

// ---------------------------------------------------------------- run status

export interface GraphRunActivity {
  admitted: number;
  /** Admitted activations a person must act on. */
  awaitingHuman: number;
  ready: number;
}

export function graphRunActivity(run: GraphRun): GraphRunActivity {
  const activity: GraphRunActivity = { admitted: 0, awaitingHuman: 0, ready: 0 };
  for (const activation of run.activations) {
    if (isGraphActivationAdmitted(activation.state)) activity.admitted += 1;
    if (activation.state === "awaiting-human") activity.awaitingHuman += 1;
    if (activation.state === "ready") activity.ready += 1;
  }
  return activity;
}

/** True when nothing is admitted, ready or waiting and every activation is terminal. */
export function graphRunSettled(
  run: GraphRun,
  planning: Pick<GraphPlanningResult, "waiting" | "needValues">,
): boolean {
  if (planning.waiting > 0 || planning.needValues.length > 0) return false;
  return run.activations.every((activation) => isGraphActivationTerminal(activation.state));
}

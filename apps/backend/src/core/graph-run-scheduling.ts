/**
 * Scheduling decisions of a graph run pass (plan P2.3, decision D3, report
 * §6.7, §8.2, §5.11). Pure functions over the run record:
 *
 * 1. **Planning** ({@link planGraphRun}) to a fixpoint: retries and
 *    `onFailure` of failed activations, loop progress (`graph-run-loops.ts`)
 *    and the ready set (`graph-run-ready-set.ts`). The 200 live-activation
 *    hard cap and the history bound refuse an append; the run then fails with
 *    `budget-exceeded`. Artifacts the runtime makes itself (edge transforms,
 *    routed `error@1`) come back as `needArtifacts` for the pass to store.
 *
 * ## Failure handling (item 206)
 *
 * The latest failed activation of a node position is retried (a new attempt,
 * the same inputs) while its node's `retry.attempts` allow and its cause is
 * one of `retry.on` (`provider-error`, `invalid-result`, `timeout`; other
 * causes never retry). Then `onFailure`:
 *
 * - `fail-run` (the default, except for replicated nodes) fails the run and
 *   stops its other admitted work;
 * - `skip`: the failed activation delivers nothing, so consumers whose
 *   required input it was are skipped, as behind an untaken outlet;
 * - `route`: unless the executor already named one, the runtime stores an
 *   `error@1` artifact (node, cause, a code derived from the cause, the
 *   bounded error message, attempts, whether the cause is retryable) and
 *   records it as the activation's `error` output. Consumers of `error` run
 *   (they wait while it is stored); consumers of the other outputs skip. On
 *   success nothing is emitted on `error`, so the recovery branch skips.
 *
 * A replicated node's failed branch (after its retries) also gets an
 * `error@1` artifact on its `error` output when a fan-in reading the node
 * passes failure markers on (`includeFailures`, item 205), so the collected
 * list can say which branch failed and why.
 * 2. **Workspace locks** (D3, §6.7): at most one writing activation per
 *    workspace, and no reader while a writer holds it, across every run on
 *    the environment ({@link GraphWorkspaceLocks}). A blocked writer is not
 *    overtaken by later workspace users in the same pass, so it cannot starve.
 *    An isolated branch (item 403) writes only its own worktree, so it holds
 *    a *reader* on the run's workspace; the environment admits at most
 *    `GRAPH_ISOLATION_BOUNDS.maxLiveWorktreesPerEnvironment` branch
 *    worktrees at once (`worktree-limit`).
 * 3. **Admission** ({@link selectGraphAdmissions}): `limits.maxConcurrentAgents`
 *    admitted agent activations at once, and `limits.maxAgentSessions` agent
 *    activations over the run's life (`usage.agentSessions`, counted at
 *    admission). An agent activation that can never get a session fails with
 *    `budget-exceeded`. `limits.maxTokens` is a soft meter over
 *    `usage.tokens` (what finished agent activations reported): once reached,
 *    no new agent activation is admitted while the agents already running
 *    finish, and a ready agent activation then fails with `budget-exceeded`
 *    naming the meter (its `onFailure` decides the run). Mock runs report no
 *    tokens and are never metered. The per-operation caps (4 starting, 8
 *    observing, 4 per provider, ceiling 16) and the shared
 *    `workflow-provider` pool apply in the pass (`graph-run-pass.ts`), which
 *    also enforces `limits.maxWallClockMs` ({@link graphRunWallClockExceeded}).
 *
 * The compiler already proves the worst case fits these limits and that no
 * reader and writer can overlap; the runtime checks are the enforcement, so
 * a restart, a rewind or a bug cannot exceed them either.
 */
import type { GraphPlanNode, GraphPlanRunOutput } from "@orkestrator/protocol/graphs/compile";
import {
  appendGraphActivation,
  GRAPH_ISOLATION_BOUNDS,
  graphActivationKey,
  graphMainWorkspaceAccess,
  graphNodeIsolated,
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_RUN_BOUNDS,
  isGraphActivationTerminal,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import {
  GRAPH_RETRY_CAUSES,
  type GraphWorkspaceAccess,
} from "@orkestrator/protocol/graphs/template";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import { graphLoopState } from "./graph-run-loops.js";
import {
  computeGraphReadySet,
  GRAPH_ERROR_PORT,
  graphActivationDelivery,
  graphCollectPolicy,
  graphFailureMarkersWanted,
  graphPredicatePaths,
  resolveGraphEdgeSource,
} from "./graph-run-ready-set.js";
import { isGraphActivationAdmitted } from "./graph-run-transitions.js";
import {
  GraphRunView,
  type GraphArtifactOutcomes,
  type GraphArtifactRequest,
  type GraphValueCache,
} from "./graph-run-view.js";

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
  /** `items` fan-outs recorded (item 401). */
  fanOuts: number;
  /** Artifact values a `when`, `until` or edge delivery needs before planning can go further. */
  needValues: string[];
  /** Artifacts to store (edge deliveries, routed errors) before planning can go further. */
  needArtifacts: GraphArtifactRequest[];
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

/** Characters of an activation error an `error@1` message keeps (under its 4 KiB string budget). */
const ERROR_MESSAGE_CHARS = 1_300;

/** The `error@1` value of a routed failure. Content-free: the activation's error is already bounded. */
export function graphRoutedErrorValue(
  node: GraphPlanNode,
  activation: NodeActivation,
  attempts: number,
): Record<string, unknown> {
  const cause = activation.errorCause ?? "system-error";
  const message = (activation.error ?? `Node ${node.id} failed`).slice(0, ERROR_MESSAGE_CHARS);
  return {
    node: node.id,
    cause,
    code: cause.replaceAll("-", "_"),
    message: message.length > 0 ? message : `Node ${node.id} failed`,
    attempts: Math.max(1, attempts),
    retryable: (GRAPH_RETRY_CAUSES as readonly string[]).includes(cause),
  };
}

/** The outcome key of a routed failure's error artifact. */
function errorKey(activation: NodeActivation): string {
  return `error\u0000${activation.key}`;
}

interface FailureDecisions {
  retries: NodeActivation[];
  /** Routed failures whose stored `error@1` artifact the record does not name yet. */
  routed: { key: string; id: string }[];
  requests: GraphArtifactRequest[];
  failure?: GraphRunFailure;
}

/**
 * Retries and `onFailure` for the latest failed activation of each node
 * position: the retries to create, the routed error artifacts to record or
 * store, or the run failure.
 */
function failurePolicy(view: GraphRunView, at: string): FailureDecisions {
  const decisions: FailureDecisions = { retries: [], routed: [], requests: [] };
  for (const activation of view.latestActivations()) {
    if (activation.state !== "failed") continue;
    const node = view.node(activation.nodeId);
    const cause = activation.errorCause;
    if (
      cause !== undefined &&
      (node.retry.on as readonly GraphErrorCause[]).includes(cause) &&
      view.liveAttempts(activation) < node.retry.attempts
    ) {
      decisions.retries.push(retryActivation(view, activation, at));
      continue;
    }
    if (node.onFailure === "fail-run") {
      return {
        retries: [],
        routed: [],
        requests: [],
        failure: {
          error: `Node ${node.id} failed${activation.error ? `: ${activation.error}` : ""}`,
          cause: cause ?? "system-error",
        },
      };
    }
    // `route`, or a replicated node's failed branch some fan-in passes on as a
    // failure marker (`includeFailures`, item 205): the `error@1` artifact is
    // recorded as the activation's `error` output before consumers read it.
    const routed = node.onFailure === "route";
    const replicated = (node.kind === "agent" || node.kind === "subgraph") && !!node.replicate;
    const marker = !routed && replicated && graphFailureMarkersWanted(view.plan, node.id);
    if ((!routed && !marker) || activation.outputs[GRAPH_ERROR_PORT] !== undefined) continue;
    const key = errorKey(activation);
    const known = view.outcomes.get(key);
    if (known?.ok && known.ids[0] !== undefined) {
      decisions.routed.push({ key: activation.key, id: known.ids[0] });
    } else if (known && !known.ok) {
      return {
        retries: [],
        routed: [],
        requests: [],
        failure: {
          error: `Node ${node.id} failed and its ${routed ? "error could not be routed" : "failure marker could not be stored"}: ${known.message}`,
          cause: "system-error",
        },
      };
    } else {
      const lineage = [...new Set(Object.values(activation.inputs).flat())].slice(
        0,
        GRAPH_ARTIFACT_BUDGETS.maxInputs,
      );
      // A failed `items` branch's marker names the item it failed on (item 401).
      const item =
        activation.branchKey === undefined
          ? undefined
          : view.branchAt(node, activation.iteration, activation.branchKey)?.item;
      decisions.requests.push({
        key,
        purpose: "error",
        producer: { nodeId: node.id, activation: activation.key, port: GRAPH_ERROR_PORT },
        type: "error@1",
        values: [graphRoutedErrorValue(node, activation, view.liveAttempts(activation))],
        inputs: lineage,
        ...(item ? { sourceItems: [item.id] } : {}),
      });
    }
  }
  return decisions;
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
  options: { at: string; values: GraphValueCache; outcomes?: GraphArtifactOutcomes },
): GraphPlanningResult {
  let current = run;
  const outcomes: GraphArtifactOutcomes = options.outcomes ?? new Map();
  const result: Omit<GraphPlanningResult, "run"> = {
    created: 0,
    skipped: 0,
    retried: 0,
    loopsAdvanced: 0,
    fanOuts: 0,
    needValues: [],
    needArtifacts: [],
    waiting: 0,
    doneLoops: [],
  };
  const needValues = new Set<string>();
  const needArtifacts = new Map<string, GraphArtifactRequest>();
  for (let round = 0; round < MAX_PLANNING_ROUNDS; round++) {
    needValues.clear();
    needArtifacts.clear();
    const view = new GraphRunView(current, options.values, outcomes);
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
    if (failures.routed.length > 0) {
      const routed = new Map(failures.routed.map((entry) => [entry.key, entry.id]));
      current = {
        ...current,
        activations: current.activations.map((activation) => {
          const id = routed.get(activation.key);
          return id === undefined
            ? activation
            : { ...activation, outputs: { ...activation.outputs, [GRAPH_ERROR_PORT]: id } };
        }),
      };
      continue;
    }
    failures.requests.forEach((request) => needArtifacts.set(request.key, request));
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
    view.requests.forEach((request, key) => needArtifacts.set(key, request));
    result.waiting = ready.waiting;
    result.doneLoops = [...done];
    if (ready.fanOuts.length > 0) {
      const fanOuts = [...(current.fanOuts ?? []), ...ready.fanOuts];
      if (fanOuts.length > GRAPH_RUN_BOUNDS.maxFanOuts) {
        return {
          ...result,
          run: current,
          failure: {
            error: `A run records at most ${GRAPH_RUN_BOUNDS.maxFanOuts} items fan-outs`,
            cause: "budget-exceeded",
          },
        };
      }
      current = { ...current, fanOuts };
      result.fanOuts += ready.fanOuts.length;
    }
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
  result.needArtifacts = [...needArtifacts.values()];
  return { ...result, run: current };
}

// ---------------------------------------------------------------- surplus branches

/**
 * Branches a `first` fan-in no longer needs (item 205; report §4.4: "first:
 * cancel the rest"): the not yet terminal activations of a replicated node at
 * an iteration, once every reader of the node is a fan-in edge into a port
 * collecting `first` and each of them has its `count` (and `minSuccessful`)
 * successes at that iteration. A node also read some other way (a zip edge,
 * a port waiting for all branches or a quorum, a loop carry, a run output, a
 * loop's `until`) keeps its branches: that reader wants them. The pass
 * settles the unadmitted ones `cancelled` and stops the admitted ones with
 * reason `surplus`.
 */
export function graphSurplusBranches(run: GraphRun): NodeActivation[] {
  const view = new GraphRunView(run);
  const surplus: NodeActivation[] = [];
  const open = new Map<string, NodeActivation[]>();
  for (const activation of view.latestActivations()) {
    if (activation.branchKey === undefined || isGraphActivationTerminal(activation.state)) continue;
    const slot = `${activation.nodeId}\u0000${activation.iteration}`;
    open.set(slot, [...(open.get(slot) ?? []), activation]);
  }
  for (const activations of open.values()) {
    const { nodeId, iteration } = activations[0]!;
    const node = view.node(nodeId);
    const branches = view.branchKeysAt(node, iteration);
    const readers = run.plan.edges.filter(
      (edge) => "node" in edge.from && edge.from.node === nodeId,
    );
    if (readers.length === 0) continue;
    if (run.plan.outputs.some((output) => output.from.node === nodeId)) continue;
    if (
      run.plan.loops.some(
        (loop) =>
          loop.carry.some((carry) => carry.from.node === nodeId) ||
          graphPredicatePaths(loop.until).some((path) => path.split(".")[0] === nodeId),
      )
    ) {
      continue;
    }
    const satisfied = readers.every((edge) => {
      const port = view.inputPort(edge.to.node, edge.to.port) ?? null;
      const policy = graphCollectPolicy(port);
      if (edge.zip || !edge.fanIn || policy.wait !== "first") return false;
      const from = edge.from as { node: string; port: string; outlet?: string };
      let successes = 0;
      for (const branchKey of branches) {
        const delivery = graphActivationDelivery(
          view.latestAt(nodeId, iteration, branchKey),
          from.port,
          from.outlet,
          node,
        );
        if (delivery.kind === "live") successes += 1;
      }
      const target = Math.max(Math.min(policy.count ?? 1, branches.length), policy.minSuccessful);
      return successes >= target;
    });
    if (satisfied) surplus.push(...activations);
  }
  return surplus;
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
  /** Admitted isolated branches, each with its own worktree (item 403); absent: none. */
  worktrees?: number;
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

function addHold(
  hold: GraphWorkspaceHold,
  access: GraphWorkspaceAccess,
  worktree = false,
): GraphWorkspaceHold {
  let next = hold;
  if (access === "write") next = { ...next, writers: next.writers + 1 };
  if (access === "read") next = { ...next, readers: next.readers + 1 };
  if (worktree) next = { ...next, worktrees: (next.worktrees ?? 0) + 1 };
  return next;
}

/** The holds of a run's admitted activations. */
export function graphRunWorkspaceHold(run: GraphRun): GraphWorkspaceHold {
  const nodes = new Map(run.plan.nodes.map((node) => [node.id, node]));
  let hold = NO_HOLD;
  for (const activation of run.activations) {
    if (!isGraphActivationAdmitted(activation.state)) continue;
    const node = nodes.get(activation.nodeId);
    if (node) hold = addHold(hold, graphMainWorkspaceAccess(node), graphNodeIsolated(node));
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
    if (
      workspace === undefined ||
      (hold.writers === 0 && hold.readers === 0 && !(hold.worktrees ?? 0))
    ) {
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
    return (
      hold.writers < previous.writers ||
      hold.readers < previous.readers ||
      (hold.worktrees ?? 0) < (previous.worktrees ?? 0)
    );
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
    let worktrees = 0;
    for (const [owner, hold] of this.byWorkspace.get(workspace) ?? []) {
      if (owner === runId) continue;
      total = { writers: total.writers + hold.writers, readers: total.readers + hold.readers };
      worktrees += hold.worktrees ?? 0;
    }
    return worktrees > 0 ? { ...total, worktrees } : total;
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
  /** `limits.maxTokens` is reached; agents already running finish first. */
  | "token-budget"
  /** A writer holds the workspace, or this writer waits for readers (D3). */
  | "workspace-lock"
  /** The environment already runs its most isolated branch worktrees (item 403). */
  | "worktree-limit"
  /** Startup recovery has not yet seeded the other runs' locks. */
  | "recovering";

export interface GraphAdmissionCandidate {
  key: string;
  node: GraphPlanNode;
  /** Takes an agent session: counts against both limits. */
  agent: boolean;
}

/** The run limit an agent activation can never be admitted under. */
export type GraphRunMeter = "agent-sessions" | "tokens";

export interface GraphAdmissionDecision {
  admit: GraphAdmissionCandidate[];
  blocked: { key: string; reason: GraphAdmissionBlock }[];
  /** Agent activations a run budget can never admit: fail them (`budget-exceeded`). */
  exhausted: { key: string; meter: GraphRunMeter }[];
}

/**
 * True when the run's token meter is reached (`limits.maxTokens`, a soft
 * limit over the tokens finished agent activations reported). Mock runs are
 * never metered: their executors report no tokens.
 */
export function graphRunTokensExhausted(run: Pick<GraphRun, "plan" | "usage" | "mock">): boolean {
  const max = run.plan.limits.maxTokens;
  return max !== undefined && !run.mock && run.usage.tokens >= max;
}

/** Why an exhausted agent activation fails, naming the meter (bounded; no payload). */
export function graphRunMeterError(
  run: Pick<GraphRun, "plan" | "usage">,
  meter: GraphRunMeter,
): string {
  return meter === "tokens"
    ? `The run reached its token limit (limits.maxTokens ${run.plan.limits.maxTokens}; ${run.usage.tokens} used), so no further agent session starts`
    : `The run reached its limit of ${run.plan.limits.maxAgentSessions} agent sessions (limits.maxAgentSessions)`;
}

/**
 * The wall-clock deadline of a started run (`limits.maxWallClockMs` after
 * `startedAt`), in epoch milliseconds; undefined without the limit or before
 * the run started. Paused time counts: the limit bounds the run's lifetime.
 */
export function graphRunWallClockDeadline(
  run: Pick<GraphRun, "plan" | "startedAt">,
): number | undefined {
  const max = run.plan.limits.maxWallClockMs;
  if (max === undefined || run.startedAt === undefined) return undefined;
  const started = Date.parse(run.startedAt);
  return Number.isFinite(started) ? started + max : undefined;
}

/** True when a started run has run past `limits.maxWallClockMs` at `now`. */
export function graphRunWallClockExceeded(
  run: Pick<GraphRun, "plan" | "startedAt">,
  now: number,
): boolean {
  const deadline = graphRunWallClockDeadline(run);
  return deadline !== undefined && now > deadline;
}

/** Why a run failed on its wall clock (bounded; no payload). */
export function graphRunWallClockError(run: Pick<GraphRun, "plan">): string {
  const max = run.plan.limits.maxWallClockMs ?? 0;
  return `The run exceeded its wall-clock limit of ${formatGraphDuration(max)} (limits.maxWallClockMs)`;
}

function formatGraphDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${Math.round(ms / 1_000)} s`;
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
  const tokensExhausted = graphRunTokensExhausted(run);
  let writerWaiting = false;
  for (const activation of run.activations) {
    if (activation.state !== "ready") continue;
    const node = nodes.get(activation.nodeId);
    if (!node) continue;
    const agent = node.kind === "agent";
    if (agent && sessions >= run.plan.limits.maxAgentSessions) {
      decision.exhausted.push({ key: activation.key, meter: "agent-sessions" });
      continue;
    }
    if (agent && tokensExhausted) {
      // Soft meter: the agents already running finish (and report) first.
      if (agents > 0) decision.blocked.push({ key: activation.key, reason: "token-budget" });
      else decision.exhausted.push({ key: activation.key, meter: "tokens" });
      continue;
    }
    if (agent && agents >= run.plan.limits.maxConcurrentAgents) {
      decision.blocked.push({ key: activation.key, reason: "concurrency" });
      continue;
    }
    const access = graphMainWorkspaceAccess(node);
    const worktree = graphNodeIsolated(node);
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
      if (
        worktree &&
        (mine.worktrees ?? 0) + (options.others.worktrees ?? 0) >=
          GRAPH_ISOLATION_BOUNDS.maxLiveWorktreesPerEnvironment
      ) {
        decision.blocked.push({ key: activation.key, reason: "worktree-limit" });
        continue;
      }
      mine = addHold(mine, access, worktree);
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
  planning: Pick<GraphPlanningResult, "waiting" | "needValues" | "needArtifacts">,
): boolean {
  if (planning.waiting > 0 || planning.needValues.length > 0) return false;
  if (planning.needArtifacts.length > 0) return false;
  return run.activations.every((activation) => isGraphActivationTerminal(activation.state));
}

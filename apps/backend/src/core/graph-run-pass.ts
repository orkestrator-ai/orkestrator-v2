/**
 * One scheduler pass over one graph run (plan P2.2, P2.3; report §8.2).
 *
 * A pass runs under the run's lock (the service's per-run lock, joined by the
 * keyed supervisor's one-pass-per-key rule) and reads only its own row. It
 *
 * 1. provisions the run's environment while the run is `provisioning`;
 * 2. stops admitted work while the run is `cancelling` (executors' `cancel`),
 *    cancels what never started, and settles the run `cancelled` (or
 *    `failed`, when a failure caused it) once nothing is admitted;
 * 3. otherwise hands each admitted activation to its executor: `recover`
 *    once per backend process, `start` again for one still `admitting` (the
 *    dispatch is idempotent per key), `observe` when its observation is due
 *    (3 s plus a stable per-run spread, or sooner when the run was woken for
 *    it), and `cancel` when it ran past its node's `timeoutMs`;
 * 4. unless the run is paused, plans to a fixpoint (retries, `onFailure`,
 *    loops, the ready set; `graph-run-scheduling.ts`), admits under the
 *    workspace locks and the run's limits, saves the record (the journal
 *    point), and starts what it admitted; activations that settle at once
 *    (gates, merges) feed another planning round in the same pass;
 * 5. derives the run's status (`running`, `waiting`, `complete`, `failed`)
 *    and saves once more if anything changed.
 *
 * Executor calls run concurrently under the shared per-operation caps: 4
 * starting, 8 observing, 4 per provider (`runBoundedTasks`, ceiling 16). A
 * save is compare-and-swap; a conflict ends the pass and the next one starts
 * from the stored record (executors are idempotent, so nothing is lost but
 * time). Logs and stats carry counts, ids and states only.
 */
import {
  boundGraphError,
  graphBranchBinding,
  graphNodeBranches,
  type GraphBranch,
  isGraphActivationTerminal,
  isGraphRunTerminal,
  type GraphModelBinding,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import {
  GraphActivationJournalFenceError,
  type GraphActivationFacts,
  type GraphActivationReport,
  type GraphCancelReason,
  type GraphExecutorContext,
  type GraphExecutorOperation,
  type GraphNodeExecutorRegistry,
} from "./graph-run-executors.js";
import {
  graphRunActivity,
  graphRunSettled,
  graphRunWorkspaceHold,
  missingGraphRunOutputs,
  planGraphRun,
  selectGraphAdmissions,
  type GraphPlanningResult,
  type GraphRunFailure,
  type GraphWorkspaceLocks,
} from "./graph-run-scheduling.js";
import {
  admitGraphActivation,
  applyGraphActivationReport,
  isGraphActivationAdmitted,
  settleGraphActivation,
  transitionGraphRun,
} from "./graph-run-transitions.js";
import { runBoundedTasks, type ReviewFanoutConcurrency } from "./review-fanout-scheduler.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import type { AdmissionLease } from "./work-admission.js";
import { stableSpreadMs } from "./workflow-supervisor.js";

/** Default observation cadence of a running activation (report §8.2: as reviewers are). */
export const GRAPH_RUN_OBSERVATION_MS = 3_000;
/** Cadence of a run that is provisioning, cancelling or has new work to plan. */
export const GRAPH_RUN_PROGRESS_MS = 1_000;
/** Safety cadence of a run that only waits for a person. */
export const GRAPH_RUN_HUMAN_WAIT_MS = 30_000;
/** Cancel calls that may report `unchanged` before the activation is settled regardless. */
export const GRAPH_RUN_MAX_CANCEL_ATTEMPTS = 3;
/** Planning and admission rounds in one pass (activations that settle at once feed the next). */
const MAX_PASS_ROUNDS = 16;
/** Value loads per planning call: a bound, not an expected depth. */
const MAX_VALUE_LOADS = 32;

/** Creates or starts the environment of a run launched without one (D7; items 207, 214). */
export interface GraphRunProvisioner {
  provision(
    run: Readonly<GraphRun>,
    signal: AbortSignal,
  ): Promise<
    | { state: "pending" }
    | { state: "ready"; environmentId: string }
    | { state: "failed"; error: string }
  >;
}

/**
 * What this process remembers about one run between passes. Never durable:
 * after a restart every admitted activation is recovered and observed once.
 */
export class GraphRunMemory {
  /** Admitted activations this process has already handed to their executor. */
  readonly handled = new Set<string>();
  readonly observedAt = new Map<string, number>();
  /** An executor's requested next observation (`null`: only when woken). */
  readonly observeAfter = new Map<string, number | null>();
  /** Activations to observe at the next pass (an accepted result slot, an answer). */
  readonly flagged = new Set<string>();
  readonly cancelAttempts = new Map<string, number>();
  /** The delay the last pass asked for; `null` when nothing is owed. */
  nextDelayMs: number | null = null;

  /** Forgets activations that are no longer admitted. */
  prune(run: GraphRun): void {
    const admitted = new Set(
      run.activations
        .filter((activation) => isGraphActivationAdmitted(activation.state))
        .map((activation) => activation.key),
    );
    for (const table of [this.handled, this.flagged]) {
      for (const key of table) if (!admitted.has(key)) table.delete(key);
    }
    for (const table of [this.observedAt, this.observeAfter, this.cancelAttempts]) {
      for (const key of table.keys()) if (!admitted.has(key)) table.delete(key);
    }
  }
}

/** Content-free counts of one pass (the efficiency benchmark reads them). */
export interface GraphRunPassStats {
  saves: number;
  rounds: number;
  created: number;
  admitted: number;
  starts: number;
  observes: number;
  recovers: number;
  cancels: number;
  valueLoads: number;
  /** Most executor calls in flight at once. */
  maxConcurrentCalls: number;
}

export interface GraphRunPassDependencies {
  storage: Pick<GraphRunsStorage, "getGraphRun" | "saveGraphRun" | "getGraphArtifact">;
  artifacts: GraphArtifactStore;
  executors: GraphNodeExecutorRegistry;
  locks: GraphWorkspaceLocks;
  /** False until startup recovery seeded every run's workspace holds. */
  workspaceKnown(): boolean;
  provisioner: GraphRunProvisioner | null;
  concurrency: ReviewFanoutConcurrency;
  observationIntervalMs: number;
  progressIntervalMs: number;
  /** Monotonic milliseconds for cadences. */
  monotonic(): number;
  /** Wall clock for record timestamps. */
  clock(): Date;
  memory(runId: string): GraphRunMemory;
  /** Wakes a run for a pass soon. */
  wake(runId: string): void;
  /** A run released workspace holds; other runs on the environment may proceed. */
  released(environmentId: string, runId: string): void;
}

export interface GraphRunPassOptions {
  signal: AbortSignal;
  lease?: AdmissionLease;
  /** False once a newer pass or a stop fenced this one; no further writes. */
  isCurrent?: () => boolean;
}

export class GraphRunPassFencedError extends Error {
  constructor() {
    super("The graph run pass was fenced");
    this.name = "GraphRunPassFencedError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

type Call = {
  activation: NodeActivation;
  node: GraphPlanNode;
  operation: GraphExecutorOperation;
  reason?: GraphCancelReason;
};

class GraphRunPass {
  private run: GraphRun;
  private saved: GraphRun;
  private readonly memory: GraphRunMemory;
  readonly stats: GraphRunPassStats = {
    saves: 0,
    rounds: 0,
    created: 0,
    admitted: 0,
    starts: 0,
    observes: 0,
    recovers: 0,
    cancels: 0,
    valueLoads: 0,
    maxConcurrentCalls: 0,
  };
  private readonly values = new Map<string, { value: unknown }>();
  private planning: GraphPlanningResult | null = null;
  /** Branches per replicated node; bindings are frozen, so one computation per pass. */
  private readonly branches = new Map<string, GraphBranch[] | null>();
  /** Tail of the serialized journal writes; never rejects. */
  private journalTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: GraphRunPassDependencies,
    run: GraphRun,
    private readonly options: GraphRunPassOptions,
  ) {
    this.run = run;
    this.saved = run;
    this.memory = deps.memory(run.id);
  }

  private at(): string {
    return this.deps.clock().toISOString();
  }

  private async save(): Promise<void> {
    if (this.run === this.saved) return;
    if (this.options.isCurrent && !this.options.isCurrent()) throw new GraphRunPassFencedError();
    const saved = await this.deps.storage.saveGraphRun(this.run, this.saved.revision);
    this.stats.saves += 1;
    this.saved = saved;
    this.run = saved;
  }

  /** Keeps the lock table in step with what the run holds; wakes waiters on a release. */
  private syncLocks(run: GraphRun): void {
    const environmentId = run.environmentId;
    const released = this.deps.locks.set(
      run.id,
      environmentId,
      isGraphRunTerminal(run.status) ? { writers: 0, readers: 0 } : graphRunWorkspaceHold(run),
    );
    if (released && environmentId) this.deps.released(environmentId, run.id);
  }

  async execute(): Promise<GraphRun> {
    try {
      if (this.run.status === "provisioning") await this.provision();
      if (this.run.status === "cancelling") await this.cancelAdmitted();
      else if (!isGraphRunTerminal(this.run.status) && this.run.status !== "provisioning") {
        await this.observeAdmitted();
        if (this.run.status !== "paused") await this.planAndAdmit();
      }
      this.settleStatus();
      await this.save();
    } finally {
      // The lock table follows what is stored, never an unsaved reservation.
      this.syncLocks(this.saved);
      this.memory.prune(this.saved);
      this.memory.nextDelayMs = this.nextDelay(this.saved);
    }
    return this.saved;
  }

  // ------------------------------------------------------------ provisioning

  private async provision(): Promise<void> {
    if (this.run.environmentId) {
      this.run = transitionGraphRun(this.run, "running", this.at());
      await this.save();
      return;
    }
    const provisioner = this.deps.provisioner;
    if (!provisioner) {
      this.run = transitionGraphRun(this.run, "failed", this.at(), {
        error: "This backend cannot create a run's environment yet",
        cause: "system-error",
      });
      await this.save();
      return;
    }
    let outcome: Awaited<ReturnType<GraphRunProvisioner["provision"]>>;
    try {
      outcome = await provisioner.provision(this.run, this.options.signal);
    } catch (error) {
      if (this.options.signal.aborted) return;
      outcome = { state: "failed", error: errorText(error) };
    }
    if (outcome.state === "pending") return;
    if (outcome.state === "failed") {
      this.run = transitionGraphRun(this.run, "failed", this.at(), {
        error: `Environment provisioning failed: ${outcome.error}`,
        cause: "system-error",
      });
    } else {
      this.run = transitionGraphRun(
        { ...this.run, environmentId: outcome.environmentId },
        "running",
        this.at(),
      );
    }
    await this.save();
  }

  // ------------------------------------------------------------ executor calls

  private binding(node: GraphPlanNode, activation: NodeActivation): GraphModelBinding | undefined {
    if (node.kind !== "agent") return undefined;
    if (!this.branches.has(node.id)) {
      this.branches.set(node.id, graphNodeBranches(node, this.run.bindings.roles));
    }
    const branch = this.branches
      .get(node.id)
      ?.find((candidate) => candidate.key === activation.branchKey);
    return graphBranchBinding(this.run.bindings.roles, branch?.role ?? node.role, branch);
  }

  private async call(call: Call): Promise<GraphActivationReport> {
    const { activation, node } = call;
    const executor = this.deps.executors.resolve(node.kind, { mock: this.run.mock });
    if (!executor) {
      if (call.operation === "cancel") return { state: "cancelled" };
      return {
        state: "failed",
        error: `No ${this.run.mock ? "mock-run " : ""}executor is registered for ${node.kind} nodes`,
        cause: "system-error",
      };
    }
    const binding = this.binding(node, activation);
    const context: GraphExecutorContext = {
      operation: call.operation,
      run: this.run,
      node,
      activation,
      ...(binding ? { binding } : {}),
      environmentId: this.run.environmentId!,
      artifacts: this.deps.artifacts,
      signal: this.options.signal,
      ...(this.options.lease ? { lease: this.options.lease } : {}),
      wake: () => this.deps.wake(this.run.id),
      journal: (facts) => this.journal(activation.key, facts),
      now: () => this.deps.clock(),
    };
    try {
      switch (call.operation) {
        case "start":
          this.stats.starts += 1;
          return await executor.start(context);
        case "recover":
          this.stats.recovers += 1;
          if (executor.recover) return await executor.recover(context);
          return activation.state === "admitting"
            ? await executor.start(context)
            : await executor.observe(context);
        case "observe":
          this.stats.observes += 1;
          return await executor.observe(context);
        case "cancel":
          this.stats.cancels += 1;
          return await executor.cancel(context, call.reason ?? "run-cancelled");
      }
    } catch (error) {
      // A stopping backend aborts calls; that is not the activation's failure.
      if (this.options.signal.aborted || call.operation === "cancel") return { state: "unchanged" };
      return { state: "failed", error: errorText(error), cause: "system-error" };
    }
  }

  /**
   * An executor's journal write: the facts applied to the activation without
   * moving its state, saved at once and serialized with the pass's other
   * journal writes (`GraphExecutorContext.journal`). Reports of concurrent
   * calls are applied after the calls end, so a journal save carries only
   * journaled facts and what the pass had already applied.
   */
  private journal(
    key: string,
    facts: Omit<GraphActivationFacts, "usage" | "observeAfterMs">,
  ): Promise<void> {
    const write = this.journalTail.then(async () => {
      const {
        usage: _usage,
        observeAfterMs: _observeAfterMs,
        ...durable
      } = facts as GraphActivationFacts;
      const outcome = applyGraphActivationReport(
        this.run,
        key,
        { ...durable, state: "unchanged" },
        this.at(),
      );
      if (!outcome.ok) throw new GraphActivationJournalFenceError(outcome.message);
      if (!outcome.changed) return;
      const before = this.run;
      this.run = outcome.run;
      try {
        await this.save();
      } catch (error) {
        // The record on disk is the authority: nothing unsaved may ride on a
        // later write of this pass.
        if (this.run === outcome.run) this.run = before;
        throw new GraphActivationJournalFenceError("The activation journal could not be saved", {
          cause: error,
        });
      }
    });
    this.journalTail = write.catch(() => undefined);
    return write;
  }

  /** Runs calls under the per-operation caps and applies the reports in record order. */
  private async runCalls(calls: Call[]): Promise<void> {
    if (calls.length === 0) return;
    const reports = new Map<string, GraphActivationReport>();
    let active = 0;
    await runBoundedTasks(
      calls.map((call) => ({
        pool:
          call.operation === "start" || call.activation.state === "admitting"
            ? ("admission" as const)
            : ("observation" as const),
        group:
          call.node.kind === "agent"
            ? (this.binding(call.node, call.activation)?.platform ?? "agent")
            : call.node.kind,
        run: async () => {
          active += 1;
          this.stats.maxConcurrentCalls = Math.max(this.stats.maxConcurrentCalls, active);
          try {
            reports.set(call.activation.key, await this.call(call));
          } finally {
            active -= 1;
          }
        },
      })),
      this.deps.concurrency,
      () => !this.options.signal.aborted,
    );
    const now = this.deps.monotonic();
    const at = this.at();
    for (const call of calls) {
      const report = reports.get(call.activation.key);
      if (!report) continue;
      const key = call.activation.key;
      if (call.operation !== "cancel") {
        this.memory.handled.add(key);
        this.memory.flagged.delete(key);
        this.memory.observedAt.set(key, now);
        if (report.observeAfterMs !== undefined) {
          this.memory.observeAfter.set(
            key,
            report.observeAfterMs === null ? null : Math.max(0, report.observeAfterMs),
          );
        } else {
          this.memory.observeAfter.delete(key);
        }
        this.apply(key, report, at);
      } else {
        this.applyCancel(call, report, at);
      }
    }
  }

  private apply(key: string, report: GraphActivationReport, at: string): void {
    const outcome = applyGraphActivationReport(this.run, key, report, at);
    if (outcome.ok) {
      this.run = outcome.run;
      return;
    }
    // An impossible report is an executor bug: fail the activation, keep the record valid.
    this.run = settleGraphActivation(this.run, key, "failed", at, {
      error: outcome.message,
      cause: "system-error",
    });
  }

  private applyCancel(call: Call, report: GraphActivationReport, at: string): void {
    const key = call.activation.key;
    const timeout = call.reason === "timeout";
    if (
      report.state === "unchanged" ||
      report.state === "running" ||
      report.state === "awaiting-human"
    ) {
      const attempts = (this.memory.cancelAttempts.get(key) ?? 0) + 1;
      this.memory.cancelAttempts.set(key, attempts);
      if (attempts < GRAPH_RUN_MAX_CANCEL_ATTEMPTS) return;
      this.run = settleGraphActivation(this.run, key, timeout ? "failed" : "cancelled", at, {
        error: "Stopping the activation could not be confirmed",
        cause: timeout ? "timeout" : "system-error",
      });
      return;
    }
    if (report.state === "cancelled" && timeout) {
      const timeoutMs = call.node.timeoutMs ?? 0;
      this.apply(
        key,
        {
          ...report,
          state: "failed",
          error: `Timed out after ${Math.round(timeoutMs / 1_000)} s`,
          cause: "timeout",
        },
        at,
      );
      return;
    }
    this.apply(key, report, at);
  }

  // ------------------------------------------------------------ phases

  private nodeOf(nodeId: string): GraphPlanNode | undefined {
    return this.run.plan.nodes.find((node) => node.id === nodeId);
  }

  private timedOut(node: GraphPlanNode, activation: NodeActivation): boolean {
    if (node.timeoutMs === undefined) return false;
    const since = Date.parse(activation.startedAt ?? activation.createdAt);
    return Number.isFinite(since) && this.deps.clock().getTime() - since > node.timeoutMs;
  }

  private observationDue(key: string, now: number): boolean {
    if (this.memory.flagged.has(key)) return true;
    const last = this.memory.observedAt.get(key);
    if (last === undefined) return true;
    const after = this.memory.observeAfter.has(key)
      ? this.memory.observeAfter.get(key)!
      : this.deps.observationIntervalMs;
    return after !== null && now - last >= after;
  }

  private async observeAdmitted(): Promise<void> {
    const now = this.deps.monotonic();
    const calls: Call[] = [];
    for (const activation of this.run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      const node = this.nodeOf(activation.nodeId);
      if (!node) continue;
      if (this.timedOut(node, activation)) {
        calls.push({ activation, node, operation: "cancel", reason: "timeout" });
      } else if (!this.memory.handled.has(activation.key)) {
        calls.push({ activation, node, operation: "recover" });
      } else if (activation.state === "admitting") {
        calls.push({ activation, node, operation: "start" });
      } else if (this.observationDue(activation.key, now)) {
        calls.push({ activation, node, operation: "observe" });
      }
    }
    await this.runCalls(calls);
  }

  private async cancelAdmitted(): Promise<void> {
    const at = this.at();
    for (const activation of this.run.activations) {
      if (activation.state === "waiting" || activation.state === "ready") {
        this.run = settleGraphActivation(this.run, activation.key, "cancelled", at);
      }
    }
    const reason: GraphCancelReason = this.run.error === undefined ? "run-cancelled" : "run-failed";
    const calls: Call[] = [];
    for (const activation of this.run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      const node = this.nodeOf(activation.nodeId);
      if (node) calls.push({ activation, node, operation: "cancel", reason });
    }
    await this.runCalls(calls);
  }

  /** Loads the artifact values planning asked for. Missing artifacts read as undefined. */
  private async loadValues(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      if (this.values.has(id)) continue;
      const artifact = await this.deps.storage.getGraphArtifact(this.run.id, id).catch(() => null);
      this.stats.valueLoads += 1;
      const body = artifact?.state === "live" ? artifact.body : undefined;
      this.values.set(id, { value: body && "value" in body ? body.value : undefined });
    }
  }

  private async plan(): Promise<GraphPlanningResult> {
    let planning = planGraphRun(this.run, { at: this.at(), values: this.values });
    for (let loads = 0; planning.needValues.length > 0 && loads < MAX_VALUE_LOADS; loads++) {
      if (planning.failure) break;
      const before = this.values.size;
      await this.loadValues(planning.needValues);
      if (this.values.size === before) break;
      planning = planGraphRun(planning.run, { at: this.at(), values: this.values });
    }
    return planning;
  }

  /** Fails the run: stops admitted work first (through `cancelling`), else ends it at once. */
  private failRun(failure: GraphRunFailure): void {
    const at = this.at();
    for (const activation of this.run.activations) {
      if (activation.state === "waiting" || activation.state === "ready") {
        this.run = settleGraphActivation(this.run, activation.key, "cancelled", at);
      }
    }
    const admitted = graphRunActivity(this.run).admitted;
    this.run = transitionGraphRun(this.run, admitted > 0 ? "cancelling" : "failed", at, failure);
    // Stopping admitted work starts with the next pass, at once.
    if (admitted > 0) this.deps.wake(this.run.id);
  }

  private async planAndAdmit(): Promise<void> {
    for (let round = 0; round < MAX_PASS_ROUNDS; round++) {
      this.stats.rounds += 1;
      let planning: GraphPlanningResult;
      try {
        planning = await this.plan();
      } catch (error) {
        // An unplannable record (a branch the runtime cannot build yet): fail, keep it readable.
        this.failRun({ error: boundGraphError(errorText(error)), cause: "system-error" });
        return;
      }
      this.planning = planning;
      this.stats.created += planning.created;
      this.run = planning.run;
      if (planning.failure) {
        this.failRun(planning.failure);
        return;
      }
      const environmentId = this.run.environmentId!;
      const decision = selectGraphAdmissions(this.run, {
        others: this.deps.locks.others(environmentId, this.run.id),
        workspaceKnown: this.deps.workspaceKnown(),
      });
      const at = this.at();
      for (const key of decision.exhausted) {
        this.run = settleGraphActivation(this.run, key, "failed", at, {
          error: `The run reached its limit of ${this.run.plan.limits.maxAgentSessions} agent sessions`,
          cause: "budget-exceeded",
        });
      }
      for (const candidate of decision.admit) {
        this.run = admitGraphActivation(this.run, candidate.key, candidate.agent);
      }
      this.stats.admitted += decision.admit.length;
      if (decision.admit.length > 0) {
        // Reserve before any await, so a concurrent pass of another run on the
        // same workspace sees these holds; the finally block re-syncs to storage.
        this.deps.locks.set(this.run.id, environmentId, graphRunWorkspaceHold(this.run));
      }
      // The journal point: `admitting` is durable before any executor starts.
      await this.save();
      if (decision.admit.length === 0) {
        if (decision.exhausted.length > 0) continue;
        return;
      }
      const admittedKeys = new Set(decision.admit.map((candidate) => candidate.key));
      const calls: Call[] = this.run.activations.flatMap((activation) => {
        if (!admittedKeys.has(activation.key)) return [];
        const node = this.nodeOf(activation.nodeId);
        return node ? [{ activation, node, operation: "start" as const }] : [];
      });
      await this.runCalls(calls);
      const settledNow = this.run.activations.some(
        (activation) =>
          admittedKeys.has(activation.key) && isGraphActivationTerminal(activation.state),
      );
      if (!settledNow) return;
    }
    // Rounds exhausted: the next pass continues at once.
    this.deps.wake(this.run.id);
  }

  /** The run's status after this pass's work. */
  private settleStatus(): void {
    const at = this.at();
    const activity = graphRunActivity(this.run);
    const status = this.run.status;
    if (status === "cancelling") {
      if (activity.admitted === 0) {
        this.run = transitionGraphRun(
          this.run,
          this.run.error === undefined ? "cancelled" : "failed",
          at,
        );
      }
      return;
    }
    if (status !== "running" && status !== "waiting" && status !== "paused") return;
    if (this.planning && status !== "paused" && graphRunSettled(this.run, this.planning)) {
      const missing = missingGraphRunOutputs(this.run);
      this.run =
        missing.length === 0
          ? transitionGraphRun(this.run, "complete", at)
          : transitionGraphRun(this.run, "failed", at, {
              error: `Required outputs were not produced: ${missing.join(", ")}`,
              cause: "system-error",
            });
      return;
    }
    if (status === "paused") return;
    const waiting =
      activity.awaitingHuman > 0 &&
      activity.admitted === activity.awaitingHuman &&
      activity.ready === 0;
    const next = waiting ? "waiting" : "running";
    if (next !== status) this.run = transitionGraphRun(this.run, next, at);
  }

  /** When this run's next pass is due; null when nothing is owed until a wake. */
  private nextDelay(run: GraphRun): number | null {
    if (isGraphRunTerminal(run.status)) return null;
    if (run.status === "provisioning" || run.status === "cancelling") {
      return this.deps.progressIntervalMs;
    }
    const now = this.deps.monotonic();
    const interval = this.deps.observationIntervalMs;
    let earliest = Number.POSITIVE_INFINITY;
    const activity = graphRunActivity(run);
    for (const activation of run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      if (activation.state === "admitting") {
        earliest = Math.min(earliest, this.deps.progressIntervalMs);
        continue;
      }
      const after = this.memory.observeAfter.has(activation.key)
        ? this.memory.observeAfter.get(activation.key)!
        : interval;
      if (after === null) continue;
      const last = this.memory.observedAt.get(activation.key) ?? now;
      earliest = Math.min(earliest, last + after - now);
    }
    // Ready work blocked by a lock or a cap is retried on the observation
    // cadence; a release elsewhere wakes it sooner.
    if (activity.ready > 0 && run.status !== "paused") earliest = Math.min(earliest, interval);
    if (earliest === Number.POSITIVE_INFINITY) {
      if (activity.awaitingHuman > 0) return GRAPH_RUN_HUMAN_WAIT_MS;
      if (run.status === "paused") return null;
      return this.deps.progressIntervalMs;
    }
    // A stable per-run spread keeps runs restored together from observing in step.
    return Math.max(0, earliest) + stableSpreadMs(run.id, interval / 3);
  }
}

/**
 * Runs one pass over the stored run. Returns the stored record afterwards
 * (null when the run no longer exists) and the pass's counts.
 */
export async function runGraphRunPass(
  deps: GraphRunPassDependencies,
  runId: string,
  options: GraphRunPassOptions,
): Promise<{ run: GraphRun | null; stats: GraphRunPassStats | null }> {
  const run = await deps.storage.getGraphRun(runId);
  if (!run) {
    deps.locks.release(runId);
    return { run: null, stats: null };
  }
  if (isGraphRunTerminal(run.status)) {
    deps.locks.release(runId);
    deps.memory(runId).nextDelayMs = null;
    return { run, stats: null };
  }
  const pass = new GraphRunPass(deps, run, options);
  const stored = await pass.execute();
  return { run: stored, stats: pass.stats };
}

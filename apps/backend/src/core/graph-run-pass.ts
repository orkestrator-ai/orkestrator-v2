/**
 * One scheduler pass over one graph run (plan P2.2; report §8.2).
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
 *    dispatch is idempotent per key), `observe` otherwise;
 * 4. derives the run's status (`running`, `waiting`) and saves once if
 *    anything changed.
 *
 * Which activations exist and are admitted is the scheduler's (item 203).
 * A save is compare-and-swap; a conflict ends the pass and the next one
 * starts from the stored record (executors are idempotent, so nothing is
 * lost but time). Logs and stats carry counts, ids and states only.
 */
import {
  isGraphRunTerminal,
  type GraphModelBinding,
  type GraphRun,
  type NodeActivation,
} from "@orkestrator/protocol/graphs/run";
import type { GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import type { GraphArtifactStore } from "./graph-artifacts.js";
import type {
  GraphActivationReport,
  GraphCancelReason,
  GraphExecutorContext,
  GraphExecutorOperation,
  GraphNodeExecutorRegistry,
} from "./graph-run-executors.js";
import {
  applyGraphActivationReport,
  isGraphActivationAdmitted,
  settleGraphActivation,
  transitionGraphRun,
} from "./graph-run-transitions.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import type { AdmissionLease } from "./work-admission.js";

/** Cadence of a run that owes work. */
export const GRAPH_RUN_PROGRESS_MS = 1_000;
/** Safety cadence of a run that only waits for a person. */
export const GRAPH_RUN_HUMAN_WAIT_MS = 30_000;
/** Cancel calls that may report `unchanged` before the activation is settled regardless. */
export const GRAPH_RUN_MAX_CANCEL_ATTEMPTS = 3;

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
 * after a restart every admitted activation is recovered once.
 */
export class GraphRunMemory {
  /** Admitted activations this process has already handed to their executor. */
  readonly handled = new Set<string>();
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
    for (const key of this.cancelAttempts.keys()) {
      if (!admitted.has(key)) this.cancelAttempts.delete(key);
    }
  }
}

/** Content-free counts of one pass. */
export interface GraphRunPassStats {
  saves: number;
  starts: number;
  observes: number;
  recovers: number;
  cancels: number;
}

export interface GraphRunPassDependencies {
  storage: Pick<GraphRunsStorage, "getGraphRun" | "saveGraphRun" | "getGraphArtifact">;
  artifacts: GraphArtifactStore;
  executors: GraphNodeExecutorRegistry;
  provisioner: GraphRunProvisioner | null;
  progressIntervalMs: number;
  /** Monotonic milliseconds for cadences. */
  monotonic(): number;
  /** Wall clock for record timestamps. */
  clock(): Date;
  memory(runId: string): GraphRunMemory;
  /** Wakes a run for a pass soon. */
  wake(runId: string): void;
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
    starts: 0,
    observes: 0,
    recovers: 0,
    cancels: 0,
  };

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

  async execute(): Promise<GraphRun> {
    try {
      if (this.run.status === "provisioning") await this.provision();
      if (this.run.status === "cancelling") await this.cancelAdmitted();
      else if (!isGraphRunTerminal(this.run.status) && this.run.status !== "provisioning") {
        await this.observeAdmitted();
      }
      this.settleStatus();
      await this.save();
    } finally {
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

  private binding(node: GraphPlanNode): GraphModelBinding | undefined {
    if (node.kind !== "agent") return undefined;
    const binding = this.run.bindings.roles[node.role];
    return Array.isArray(binding) ? binding[0] : binding;
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
    const binding = this.binding(node);
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

  /** Runs calls one at a time and applies each report. */
  private async runCalls(calls: Call[]): Promise<void> {
    for (const call of calls) {
      if (this.options.signal.aborted) return;
      const report = await this.call(call);
      const key = call.activation.key;
      const at = this.at();
      if (call.operation === "cancel") {
        this.applyCancel(call, report, at);
        continue;
      }
      this.memory.handled.add(key);
      this.memory.flagged.delete(key);
      this.apply(key, report, at);
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
    if (
      report.state === "unchanged" ||
      report.state === "running" ||
      report.state === "awaiting-human"
    ) {
      const attempts = (this.memory.cancelAttempts.get(key) ?? 0) + 1;
      this.memory.cancelAttempts.set(key, attempts);
      if (attempts < GRAPH_RUN_MAX_CANCEL_ATTEMPTS) return;
      this.run = settleGraphActivation(this.run, key, "cancelled", at, {
        error: "Stopping the activation could not be confirmed",
        cause: "system-error",
      });
      return;
    }
    this.apply(key, report, at);
  }

  // ------------------------------------------------------------ phases

  private nodeOf(nodeId: string): GraphPlanNode | undefined {
    return this.run.plan.nodes.find((node) => node.id === nodeId);
  }

  private async observeAdmitted(): Promise<void> {
    const calls: Call[] = [];
    for (const activation of this.run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      const node = this.nodeOf(activation.nodeId);
      if (!node) continue;
      if (!this.memory.handled.has(activation.key)) {
        calls.push({ activation, node, operation: "recover" });
      } else if (activation.state === "admitting") {
        calls.push({ activation, node, operation: "start" });
      } else {
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

  private activity(run: GraphRun): { admitted: number; awaitingHuman: number; ready: number } {
    const activity = { admitted: 0, awaitingHuman: 0, ready: 0 };
    for (const activation of run.activations) {
      if (isGraphActivationAdmitted(activation.state)) activity.admitted += 1;
      if (activation.state === "awaiting-human") activity.awaitingHuman += 1;
      if (activation.state === "ready") activity.ready += 1;
    }
    return activity;
  }

  /** The run's status after this pass's work. */
  private settleStatus(): void {
    const at = this.at();
    const activity = this.activity(this.run);
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
    if (status !== "running" && status !== "waiting") return;
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
    const activity = this.activity(run);
    if (activity.admitted > 0 && activity.admitted === activity.awaitingHuman) {
      return GRAPH_RUN_HUMAN_WAIT_MS;
    }
    if (run.status === "paused" && activity.admitted === 0) return null;
    return this.deps.progressIntervalMs;
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
  if (!run) return { run: null, stats: null };
  if (isGraphRunTerminal(run.status)) {
    deps.memory(runId).nextDelayMs = null;
    return { run, stats: null };
  }
  const pass = new GraphRunPass(deps, run, options);
  const stored = await pass.execute();
  return { run: stored, stats: pass.stats };
}

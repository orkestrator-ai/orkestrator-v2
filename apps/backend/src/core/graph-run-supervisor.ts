/**
 * The `graph-run` keyed scheduling domain (plan P2.2, report §8.2).
 *
 * Graph runs are driven by the shared {@link KeyedWorkflowSupervisor}, like
 * build pipelines and Multi Review: one key per run that owes work, its own
 * due time, scoped wakeups, bounded admission through the `workflow-provider`
 * pool, and a 30 s safety discovery over the `graph-runs` store. Rolling the
 * domain back (`ORKESTRATOR_KEYED_SCHEDULING_ROLLBACK=graph-run`) disables
 * graph runs: there is no previous driver to return to.
 *
 * | Obligation | Run state | Cadence |
 * | --- | --- | --- |
 * | `provision` | `provisioning` | 1 s, without a provider slot |
 * | `cancel` | `cancelling` | 1 s, until every admitted activation stopped |
 * | `observe` | an activation is `admitting` or `running` | 3 s plus a stable per-run spread; 1 s while admitting |
 * | `advance` | `running`/`waiting` with ready work or positions still to plan | 1 s, and woken when a workspace lock is released |
 * | `await-human` | only `awaiting-human` activations are admitted | 30 s safety, without a provider slot; answers wake the run |
 *
 * A `paused` run owes nothing unless an activation is still admitted (it
 * keeps being observed until it settles); resuming wakes it. Terminal runs
 * owe nothing.
 *
 * **Wakes.** The existing reasons apply. `result-accepted` wakes only the run
 * that owns the accepted slot: {@link GraphRunResultKeys} maps each admitted
 * activation's result keys (`session.resultKeys`, written by the agent
 * executor) to its run and activation, noted after every pass and every
 * discovery; a key it does not hold (a slot recorded by another process) is
 * looked up in the environment's stored runs. Environment and provider
 * transitions wake the environment's runs.
 *
 * **Recovery.** Startup needs no renderer: the first discovery registers every
 * run with an obligation, seeds the workspace locks and the result-key index,
 * and each run's first pass hands its admitted activations to their
 * executors' `recover`. Until that first discovery completes, no activation
 * that reads or writes a workspace is admitted.
 */
import { isGraphRunTerminal, type GraphRun } from "@orkestrator/protocol/graphs/run";
import { isGraphActivationAdmitted } from "./graph-run-transitions.js";
import type { RecurringTimerFactory } from "./recurring-scheduler.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";
import type { WorkAdmissionPool } from "./work-admission.js";
import {
  DEFAULT_WORKFLOW_DISCOVERY_MS,
  KeyedWorkflowSupervisor,
  type WorkflowDiscoveryResult,
  type WorkflowPass,
} from "./workflow-supervisor.js";

export const GRAPH_RUN_OBLIGATIONS = [
  "provision",
  "cancel",
  "observe",
  "advance",
  "await-human",
] as const;
export type GraphRunObligation = (typeof GRAPH_RUN_OBLIGATIONS)[number];

/** Concurrent run passes (as Multi Review's workflow passes). */
export const MAX_CONCURRENT_GRAPH_RUN_PASSES = 8;

/** What a stored run owes the backend; null when nothing. */
export function graphRunObligation(run: GraphRun): GraphRunObligation | null {
  if (isGraphRunTerminal(run.status)) return null;
  if (run.status === "provisioning") return "provision";
  if (run.status === "cancelling") return "cancel";
  let observing = false;
  let awaiting = false;
  let ready = false;
  for (const activation of run.activations) {
    if (activation.state === "awaiting-human") awaiting = true;
    else if (isGraphActivationAdmitted(activation.state)) observing = true;
    else if (activation.state === "ready" || activation.state === "waiting") ready = true;
  }
  if (observing) return "observe";
  if (run.status === "paused") return null;
  if (ready) return "advance";
  if (awaiting) return "await-human";
  // Running with nothing admitted or ready: positions are still to be
  // planned (a new run, or one a pass has not settled yet).
  return "advance";
}

/** Admission target of a run's passes: its environment once it has one. */
export function graphRunTarget(run: GraphRun): string | undefined {
  return run.environmentId;
}

/**
 * Authoritative discovery over the graph-run store. Records this build cannot
 * read are left out by the store (they have nothing the runtime could
 * advance); `visit` sees every readable run, for recovery seeding.
 */
export async function discoverGraphRuns(
  storage: Pick<GraphRunsStorage, "listAllGraphRuns">,
  visit?: (run: GraphRun) => void,
): Promise<WorkflowDiscoveryResult<GraphRunObligation>> {
  const runs = await storage.listAllGraphRuns();
  const entries: WorkflowDiscoveryResult<GraphRunObligation>["entries"] = [];
  for (const run of runs) {
    visit?.(run);
    const obligation = graphRunObligation(run);
    if (!obligation) continue;
    const target = graphRunTarget(run);
    entries.push({ key: run.id, obligation, ...(target ? { target } : {}) });
  }
  return { entries, scanned: runs.length, complete: true };
}

export interface GraphRunResultOwner {
  runId: string;
  activationKey: string;
}

/**
 * Result key → the run and activation that own the slot, for the admitted
 * activations of indexed runs. A projection of stored runs: noted after every
 * pass and discovery, dropped when a run settles or is deleted. Bounded by
 * the admitted activations of live runs (each at most 200, ports at most 16).
 */
export class GraphRunResultKeys {
  private readonly owners = new Map<string, GraphRunResultOwner>();
  private readonly byRun = new Map<string, string[]>();

  note(run: GraphRun): void {
    this.forget(run.id);
    if (isGraphRunTerminal(run.status)) return;
    const keys: string[] = [];
    for (const activation of run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      for (const resultKey of Object.values(activation.session?.resultKeys ?? {})) {
        this.owners.set(resultKey, { runId: run.id, activationKey: activation.key });
        keys.push(resultKey);
      }
    }
    if (keys.length > 0) this.byRun.set(run.id, keys);
  }

  forget(runId: string): void {
    for (const resultKey of this.byRun.get(runId) ?? []) {
      if (this.owners.get(resultKey)?.runId === runId) this.owners.delete(resultKey);
    }
    this.byRun.delete(runId);
  }

  owner(resultKey: string): GraphRunResultOwner | undefined {
    return this.owners.get(resultKey);
  }

  /** The admitted activation of `run` that owns `resultKey`, from the record itself. */
  static find(run: GraphRun, resultKey: string): GraphRunResultOwner | undefined {
    if (isGraphRunTerminal(run.status)) return undefined;
    for (const activation of run.activations) {
      if (!isGraphActivationAdmitted(activation.state)) continue;
      if (Object.values(activation.session?.resultKeys ?? {}).includes(resultKey)) {
        return { runId: run.id, activationKey: activation.key };
      }
    }
    return undefined;
  }

  size(): number {
    return this.owners.size;
  }
}

export interface GraphRunSupervisorOptions {
  discover(signal: AbortSignal): Promise<WorkflowDiscoveryResult<GraphRunObligation>>;
  advance(pass: WorkflowPass<GraphRunObligation>): Promise<void>;
  nextDelayMs(key: string): number | null | undefined;
  progressIntervalMs: number;
  discoveryIntervalMs?: number;
  admission?: WorkAdmissionPool | null;
  schedulerClock?: { now: () => number; timers: RecurringTimerFactory };
}

/** The keyed driver of the `graph-run` domain. */
export function createGraphRunSupervisor(
  options: GraphRunSupervisorOptions,
): KeyedWorkflowSupervisor<GraphRunObligation> {
  return new KeyedWorkflowSupervisor<GraphRunObligation>({
    domain: "graph-run",
    kind: "graph-run-tick",
    progressIntervalMs: options.progressIntervalMs,
    discoveryIntervalMs: options.discoveryIntervalMs ?? DEFAULT_WORKFLOW_DISCOVERY_MS,
    maxConcurrent: MAX_CONCURRENT_GRAPH_RUN_PASSES,
    discover: options.discover,
    advance: options.advance,
    nextDelayMs: (key) => options.nextDelayMs(key),
    admission: options.admission ?? null,
    // Provisioning has its own lifecycle queue; a person's wait reads one row.
    withoutAdmission: (obligation) => obligation === "provision" || obligation === "await-human",
    ...(options.schedulerClock
      ? { now: options.schedulerClock.now, timers: options.schedulerClock.timers }
      : {}),
  });
}

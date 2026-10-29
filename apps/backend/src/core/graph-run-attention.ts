/**
 * Graph runs in the sidebar (item 208, plan P2.8): a run waiting on a person
 * shows wherever the user looks, through the same paths agent tabs use.
 *
 * - **Activity.** The environment's `graph-run` activity source is `working`
 *   while one of its runs works (provisioning, running, stopping), `waiting`
 *   while a run waits on a person and nothing else of it works, and `idle`
 *   otherwise. The sidebar aggregates it with every other source.
 * - **Attention.** Every new wait (a human node's wait id, or an agent's
 *   `ask_human` question id) is recorded once as a content-free attention key
 *   (`recordEnvironmentAgentAttention`), which lights the environment's unread
 *   badge with reason `agent_question`. The key is deduped in the same write,
 *   so a replayed change, a restart or a second observer never lights it
 *   twice for one wait, and a badge the user cleared stays cleared.
 * - **Hook.** {@link GraphRunAttention.onWaitOpened} tells listeners about
 *   each wait the first time it is recorded (run id, environment and the
 *   pending interactions that are new). The coordinator's status wake reads
 *   the stored run itself (`coordinator-status-wakes.ts`, `graph-run`
 *   associations), so a listener is a convenience, never the authority.
 *
 * Everything is derived from the stored run record (`graphRunPendingInteractions`)
 * on a `graph-run` change, debounced per run, and once for every environment
 * at start (recovery after a restart, or a missed change). Nothing here logs
 * question text, instructions or answers.
 */
import { createHash } from "node:crypto";
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  graphPendingInteractionId,
  graphRunPendingInteractions,
  isGraphRunTerminal,
  type GraphRun,
  type GraphRunPendingInteraction,
} from "@orkestrator/protocol/graphs/run";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { Environment } from "./models.js";
import type { ResourceChangeListener } from "./storage-shared.js";
import type { GraphRunsStorage } from "./storage-graph-runs.js";

/** Graph runs save in bursts (every pass); observe each run at most this often. */
const GRAPH_RUN_ATTENTION_DEBOUNCE_MS = 500;

export interface GraphRunAttentionStorage {
  graphRuns: Pick<GraphRunsStorage, "getGraphRun" | "listGraphRuns" | "listAllGraphRuns">;
  addResourceChangeListener(listener: ResourceChangeListener): () => void;
  getEnvironment(environmentId: string): Promise<Environment | null>;
  loadEnvironments(): Promise<Environment[]>;
  setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: "graph-run",
  ): Promise<Environment>;
  recordEnvironmentAgentAttention(
    environmentId: string,
    attentionKeys: readonly string[],
    occurredAt: string,
  ): Promise<{ environment: Environment; recorded: boolean }>;
}

export interface GraphRunWaitOpened {
  runId: string;
  projectId: string;
  environmentId: string;
  /** The interactions whose attention was recorded by this observation. */
  interactions: GraphRunPendingInteraction[];
}

export interface GraphRunAttentionTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMERS: GraphRunAttentionTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The content-free attention key of one wait. */
export function graphRunAttentionKey(runId: string, interactionId: string): string {
  const digest = createHash("sha256")
    .update(runId)
    .update("\0")
    .update(interactionId)
    .digest("hex");
  return `graph-run:${digest}`;
}

/**
 * The `graph-run` activity an environment's runs add up to: `working` when a
 * run provisions, stops, runs an activation or has queued work; else
 * `waiting` when one waits on a person; else `idle` (a paused run with
 * nothing in flight, or only finished runs).
 */
export function graphRunEnvironmentActivity(runs: readonly GraphRun[]): AgentActivityState {
  let waiting = false;
  for (const run of runs) {
    if (isGraphRunTerminal(run.status)) continue;
    if (run.status === "provisioning" || run.status === "cancelling") return "working";
    if (
      run.activations.some(
        (activation) => activation.state === "admitting" || activation.state === "running",
      )
    ) {
      return "working";
    }
    if (graphRunPendingInteractions(run).length > 0) {
      waiting = true;
      continue;
    }
    if (run.status === "running") return "working";
  }
  return waiting ? "waiting" : "idle";
}

export class GraphRunAttention {
  private readonly timers: GraphRunAttentionTimers;
  private readonly debounceMs: number;
  private readonly changeTimers = new Map<string, unknown>();
  private readonly listeners = new Set<(event: GraphRunWaitOpened) => void>();
  private unsubscribe: (() => void) | null = null;
  /** One observation at a time, so two cannot both decide the same activity write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: GraphRunAttentionStorage,
    private readonly options: {
      timers?: GraphRunAttentionTimers;
      debounceMs?: number;
      clock?: () => Date;
    } = {},
  ) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.debounceMs = options.debounceMs ?? GRAPH_RUN_ATTENTION_DEBOUNCE_MS;
  }

  /** Subscribes to `graph-run` changes and reconciles every environment once. */
  start(): Promise<void> {
    this.unsubscribe ??= this.storage.addResourceChangeListener((change) =>
      this.onResourceChange(change),
    );
    return this.reconcile();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const handle of this.changeTimers.values()) this.timers.clearTimeout(handle);
    this.changeTimers.clear();
  }

  /** Listens for each wait the first time its attention is recorded. Returns the unsubscribe. */
  onWaitOpened(listener: (event: GraphRunWaitOpened) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once every observation queued so far has finished. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onResourceChange(change: ResourceChange): void {
    if (change.resource !== "graph-run" || change.deleted) return;
    if (this.changeTimers.has(change.id)) return;
    this.changeTimers.set(
      change.id,
      this.timers.setTimeout(() => {
        this.changeTimers.delete(change.id);
        void this.observeRun(change.id).catch((error: unknown) => {
          console.warn(
            "[graph-runs] Could not update the sidebar for a run:",
            error instanceof Error ? error.message : error,
          );
        });
      }, this.debounceMs),
    );
  }

  /** Observes one run now: its waits' attention and its environment's activity. */
  observeRun(runId: string): Promise<void> {
    return this.serialize(async () => {
      const run = await this.storage.graphRuns.getGraphRun(runId);
      if (!run?.environmentId) return;
      await this.recordWaits(run);
      await this.syncEnvironment(run.environmentId);
    });
  }

  /**
   * Every environment with a live run, or a `graph-run` activity source left
   * from before a restart: the recovery path for a missed change.
   */
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      const [runs, environments] = await Promise.all([
        this.storage.graphRuns.listAllGraphRuns(),
        this.storage.loadEnvironments(),
      ]);
      const environmentIds = new Set<string>();
      for (const run of runs) {
        if (!run.environmentId || isGraphRunTerminal(run.status)) continue;
        environmentIds.add(run.environmentId);
        await this.recordWaits(run).catch(() => undefined);
      }
      for (const environment of environments) {
        if (environment.agentActivitySources?.["graph-run"]) environmentIds.add(environment.id);
      }
      for (const environmentId of environmentIds) {
        await this.syncEnvironment(environmentId).catch(() => undefined);
      }
    });
  }

  private async recordWaits(run: GraphRun): Promise<void> {
    const pending = graphRunPendingInteractions(run);
    if (pending.length === 0 || !run.environmentId) return;
    const opened: GraphRunPendingInteraction[] = [];
    // One write per wait, so a listener hears exactly the waits that are new.
    for (const interaction of pending) {
      const key = graphRunAttentionKey(run.id, graphPendingInteractionId(interaction));
      const result = await this.storage.recordEnvironmentAgentAttention(
        run.environmentId,
        [key],
        this.now(),
      );
      if (result.recorded) opened.push(interaction);
    }
    if (opened.length === 0) return;
    const event: GraphRunWaitOpened = {
      runId: run.id,
      projectId: run.projectId,
      environmentId: run.environmentId,
      interactions: opened,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener's failure is its own; the attention is already recorded.
      }
    }
  }

  private async syncEnvironment(environmentId: string): Promise<void> {
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment) return;
    const desired = graphRunEnvironmentActivity(
      await this.storage.graphRuns.listGraphRuns(environmentId),
    );
    const current = environment.agentActivitySources?.["graph-run"]?.state;
    if (current === desired || (current === undefined && desired === "idle")) return;
    await this.storage.setEnvironmentAgentActivity(environmentId, desired, this.now(), "graph-run");
  }
}

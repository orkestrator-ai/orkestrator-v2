/**
 * Build pipelines in the sidebar: the environment's `build-pipeline` activity
 * source is `working` while one of its pipelines has agents in flight
 * (`isWorkingBuildPipeline`) and `idle` otherwise.
 *
 * The renderer that owns a pipeline overlays the same rule from its own
 * pipeline store, but every other surface (another machine's sidebar, search,
 * the control tools) reads only the environment's stored aggregate. Writing it
 * here is what lights a pipe branch's marker wherever it is shown.
 *
 * Debounced observations refresh the revision-validated shared store before
 * aggregating. Periodic reconciliation catches writes by other backends, and
 * dirty environments survive failed writes, including pipeline deletion.
 */
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { isBuildPipeline, isWorkingBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import type { ResourceChangeListener } from "./storage-shared.js";

/** Pipelines save several times per step; observe each at most this often. */
const BUILD_PIPELINE_ACTIVITY_DEBOUNCE_MS = 500;
const RECONCILE_MS = 30_000;
const RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export interface BuildPipelineActivityStorage {
  addResourceChangeListener(listener: ResourceChangeListener): () => void;
  getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null>;
  listAllBuildPipelines(): Promise<PersistedBuildPipeline[]>;
  getEnvironment(environmentId: string): Promise<Environment | null>;
  loadEnvironments(): Promise<Environment[]>;
  setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: "build-pipeline",
  ): Promise<Environment>;
}

export interface BuildPipelineActivityTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMERS: BuildPipelineActivityTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface ObservedPipeline {
  environmentId: string;
  working: boolean;
}

function observePipeline(record: PersistedBuildPipeline): ObservedPipeline | null {
  if (!record.environmentId) return null;
  return {
    environmentId: record.environmentId,
    working: isBuildPipeline(record.snapshot) && isWorkingBuildPipeline(record.snapshot),
  };
}

export class BuildPipelineActivity {
  private readonly timers: BuildPipelineActivityTimers;
  private readonly debounceMs: number;
  private readonly changeTimers = new Map<string, unknown>();
  private readonly pipelines = new Map<string, ObservedPipeline>();
  private readonly dirtyEnvironments = new Set<string>();
  private reconcileTimer: unknown = null;
  private retryTimer: unknown = null;
  private retryMs = RETRY_MS;
  private unsubscribe: (() => void) | null = null;
  /** One observation at a time, so two cannot both decide the same activity write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: BuildPipelineActivityStorage,
    private readonly options: {
      timers?: BuildPipelineActivityTimers;
      debounceMs?: number;
      reconcileMs?: number;
      clock?: () => Date;
    } = {},
  ) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.debounceMs = options.debounceMs ?? BUILD_PIPELINE_ACTIVITY_DEBOUNCE_MS;
  }

  /** Subscribes to changes and starts recovery for missed cross-process events. */
  start(): Promise<void> {
    this.unsubscribe ??= this.storage.addResourceChangeListener((change) =>
      this.onResourceChange(change),
    );
    this.scheduleReconcile();
    return this.reconcile();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const handle of this.changeTimers.values()) this.timers.clearTimeout(handle);
    this.changeTimers.clear();
    if (this.reconcileTimer !== null) this.timers.clearTimeout(this.reconcileTimer);
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.reconcileTimer = null;
    this.retryTimer = null;
  }

  /** Resolves once every observation queued so far has finished. */
  settled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private now(): string {
    return (this.options.clock?.() ?? new Date()).toISOString();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work).catch((error: unknown) => {
      this.scheduleRetry();
      throw error;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private scheduleReconcile(): void {
    if (!this.unsubscribe || this.reconcileTimer !== null) return;
    this.reconcileTimer = this.timers.setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile()
        .catch((error: unknown) => this.warn(error))
        .finally(() => this.scheduleReconcile());
    }, this.options.reconcileMs ?? RECONCILE_MS);
  }

  private scheduleRetry(): void {
    if (!this.unsubscribe || this.retryTimer !== null) return;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.reconcile().catch((error: unknown) => this.warn(error));
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
  }

  private warn(error: unknown): void {
    console.warn(
      "[build-pipeline] Could not reconcile sidebar activity:",
      error instanceof Error ? error.message : error,
    );
  }

  private onResourceChange(change: ResourceChange): void {
    if (change.resource !== "build-pipeline") return;
    if (this.changeTimers.has(change.id)) return;
    this.changeTimers.set(
      change.id,
      this.timers.setTimeout(() => {
        this.changeTimers.delete(change.id);
        void this.observe(change.id).catch((error: unknown) => {
          console.warn(
            `[build-pipeline] Could not update the sidebar for pipeline ${change.id}:`,
            error instanceof Error ? error.message : error,
          );
        });
      }, this.debounceMs),
    );
  }

  /** Observes one pipeline now, including its deletion. */
  observe(pipelineId: string): Promise<void> {
    return this.serialize(async () => {
      const previous = this.pipelines.get(pipelineId);
      const record = await this.storage.getBuildPipeline(pipelineId);
      const next = record ? observePipeline(record) : null;
      if (previous) this.dirtyEnvironments.add(previous.environmentId);
      if (next) this.dirtyEnvironments.add(next.environmentId);
      await this.refreshPipelines();
      await this.syncDirtyEnvironments();
    });
  }

  /**
   * Every environment with a pipeline, or a `build-pipeline` source left from
   * before a restart: the recovery path for a missed change.
   */
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      const environments = await this.storage.loadEnvironments();
      for (const environment of environments) {
        if (environment.agentActivitySources?.["build-pipeline"]) {
          this.dirtyEnvironments.add(environment.id);
        }
      }
      await this.refreshPipelines();
      await this.syncDirtyEnvironments();
    });
  }

  private async refreshPipelines(): Promise<void> {
    const records = await this.storage.listAllBuildPipelines();
    for (const pipeline of this.pipelines.values()) {
      this.dirtyEnvironments.add(pipeline.environmentId);
    }
    this.pipelines.clear();
    for (const record of records) {
      const observed = observePipeline(record);
      if (!observed) continue;
      this.pipelines.set(record.id, observed);
      this.dirtyEnvironments.add(observed.environmentId);
    }
  }

  private async syncDirtyEnvironments(): Promise<void> {
    // Attempt every environment even if one fails; only durable successes leave
    // the set. A deleted pipeline's former environment remains here for retry.
    const failures: unknown[] = [];
    for (const environmentId of Array.from(this.dirtyEnvironments)) {
      try {
        await this.syncEnvironment(environmentId);
        this.dirtyEnvironments.delete(environmentId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = RETRY_MS;
  }

  private async syncEnvironment(environmentId: string): Promise<void> {
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment) return;
    let desired: AgentActivityState = "idle";
    for (const pipeline of this.pipelines.values()) {
      if (pipeline.environmentId === environmentId && pipeline.working) {
        desired = "working";
        break;
      }
    }
    const current = environment.agentActivitySources?.["build-pipeline"]?.state;
    if (current === desired || (current === undefined && desired === "idle")) return;
    await this.storage.setEnvironmentAgentActivity(
      environmentId,
      desired,
      this.now(),
      "build-pipeline",
    );
  }
}

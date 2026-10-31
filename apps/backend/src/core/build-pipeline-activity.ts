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
 * Each pipeline's working bit is cached by id, so a burst of saves costs one
 * point read per pipeline rather than a scan of every record, and a deleted
 * pipeline still names the environment it has to release. The cache is rebuilt
 * from storage at start, which also clears a source left `working` by a crash.
 */
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import { isBuildPipeline, isWorkingBuildPipeline } from "@orkestrator/protocol/build-pipeline";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import type { ResourceChangeListener } from "./storage-shared.js";

/** Pipelines save several times per step; observe each at most this often. */
const BUILD_PIPELINE_ACTIVITY_DEBOUNCE_MS = 500;

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
  private unsubscribe: (() => void) | null = null;
  /** One observation at a time, so two cannot both decide the same activity write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly storage: BuildPipelineActivityStorage,
    private readonly options: {
      timers?: BuildPipelineActivityTimers;
      debounceMs?: number;
      clock?: () => Date;
    } = {},
  ) {
    this.timers = options.timers ?? SYSTEM_TIMERS;
    this.debounceMs = options.debounceMs ?? BUILD_PIPELINE_ACTIVITY_DEBOUNCE_MS;
  }

  /** Subscribes to `build-pipeline` changes and reconciles every environment once. */
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
      if (next) this.pipelines.set(pipelineId, next);
      else this.pipelines.delete(pipelineId);
      const environmentIds = new Set<string>();
      if (previous) environmentIds.add(previous.environmentId);
      if (next) environmentIds.add(next.environmentId);
      for (const environmentId of environmentIds) await this.syncEnvironment(environmentId);
    });
  }

  /**
   * Every environment with a pipeline, or a `build-pipeline` source left from
   * before a restart: the recovery path for a missed change.
   */
  reconcile(): Promise<void> {
    return this.serialize(async () => {
      const [records, environments] = await Promise.all([
        this.storage.listAllBuildPipelines(),
        this.storage.loadEnvironments(),
      ]);
      this.pipelines.clear();
      const environmentIds = new Set<string>();
      for (const record of records) {
        const observed = observePipeline(record);
        if (!observed) continue;
        this.pipelines.set(record.id, observed);
        environmentIds.add(observed.environmentId);
      }
      for (const environment of environments) {
        if (environment.agentActivitySources?.["build-pipeline"]) {
          environmentIds.add(environment.id);
        }
      }
      for (const environmentId of environmentIds) {
        await this.syncEnvironment(environmentId).catch(() => undefined);
      }
    });
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

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
 * Debounced observations refresh one pipeline and aggregate its affected
 * environments. A working record establishes activity on its own. Otherwise
 * the event reads the environment's current siblings before deciding activity.
 * Full reconciliation catches missed changes and retries failed writes.
 *
 * The `working -> idle` edge also says what the bell reads
 * (`buildPipelineCompletionOutcome`): a failure as a failure, a completion as
 * a completion, and a cancel, pause, stall or deletion as nothing. A stall is
 * not an end, so a pipeline that stalls and then ends without moving again
 * rings its real end once, keyed by its record (`recordEnvironmentSessionCompletion`).
 */
import type { AgentActivityState } from "@orkestrator/protocol/agent-activity";
import {
  type BuildPipeline,
  isBuildPipeline,
  isCancelledBuildPipeline,
  isWorkingBuildPipeline,
} from "@orkestrator/protocol/build-pipeline";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import type {
  AgentActivityCompletionOutcome,
  Environment,
  PersistedBuildPipeline,
} from "../models.js";
import type { ResourceChangeListener } from "../storage-shared.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("build-pipeline");

/** Pipelines save several times per step; observe each at most this often. */
const BUILD_PIPELINE_ACTIVITY_DEBOUNCE_MS = 500;
const RECONCILE_MS = 30_000;
const RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;

export interface BuildPipelineActivityStorage {
  addResourceChangeListener(listener: ResourceChangeListener): () => void;
  getBuildPipeline(pipelineId: string): Promise<PersistedBuildPipeline | null>;
  listBuildPipelinesForEnvironment(
    projectId: string,
    environmentId: string,
  ): Promise<PersistedBuildPipeline[]>;
  listAllBuildPipelines(): Promise<PersistedBuildPipeline[]>;
  getEnvironment(environmentId: string): Promise<Environment | null>;
  loadEnvironments(): Promise<Environment[]>;
  setEnvironmentAgentActivity(
    environmentId: string,
    state: AgentActivityState,
    occurredAt: string,
    source: "build-pipeline",
    observerId?: string,
    stale?: boolean,
    options?: { completionOutcome?: AgentActivityCompletionOutcome },
  ): Promise<Environment>;
  recordEnvironmentSessionCompletion(
    environmentId: string,
    occurredAt: string,
    reason: "agent_finished" | "agent_failed",
    completionKey: string,
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

/**
 * How a pipeline that is no longer active ended. `quiet` is a stop someone
 * asked for (a cancel or a pause): they know, and nothing completed.
 */
export type BuildPipelineEnd = "complete" | "failed" | "quiet";

export function buildPipelineEnd(
  pipeline: Pick<BuildPipeline, "phase" | "error" | "failureContext">,
): BuildPipelineEnd | undefined {
  if (pipeline.phase === "complete") return "complete";
  if (pipeline.phase === "failed") return isCancelledBuildPipeline(pipeline) ? "quiet" : "failed";
  if (pipeline.phase === "paused") return "quiet";
  return undefined;
}

/**
 * What the bell says when the `build-pipeline` source stops working, from the
 * pipelines that ended while it was: any failure is a failure, and a
 * completion is a completion. Otherwise nothing completed (a cancel, a pause,
 * a stall or a deletion), so nothing rings.
 */
export function buildPipelineCompletionOutcome(
  ends: Iterable<BuildPipelineEnd>,
): AgentActivityCompletionOutcome | undefined {
  let completed = false;
  for (const end of ends) {
    if (end === "failed") return "failed";
    if (end === "complete") completed = true;
  }
  return completed ? undefined : "none";
}

interface ObservedPipeline {
  environmentId: string;
  working: boolean;
  /** Would be working but for a stall warning: not an end, so it rings nothing. */
  stalled: boolean;
  end?: BuildPipelineEnd;
  endedAt: string;
  revision: number;
}

/** A pipeline this process saw active and then saw end. */
interface ObservedEnding {
  environmentId: string;
  end: BuildPipelineEnd;
  /** It was stalled, so the source had already gone idle without ringing. */
  fromStall: boolean;
  key: string;
}

function observePipeline(record: PersistedBuildPipeline): ObservedPipeline | null {
  if (!record.environmentId) return null;
  const snapshot = isBuildPipeline(record.snapshot) ? record.snapshot : null;
  return {
    environmentId: record.environmentId,
    working: snapshot !== null && isWorkingBuildPipeline(snapshot),
    stalled:
      snapshot?.stallWarning !== undefined && isWorkingBuildPipeline({ phase: snapshot.phase }),
    end: snapshot ? buildPipelineEnd(snapshot) : undefined,
    endedAt: record.activityEndedAt ?? record.updatedAt,
    revision: record.revision,
  };
}

export class BuildPipelineActivity {
  private readonly timers: BuildPipelineActivityTimers;
  private readonly debounceMs: number;
  private readonly changeTimers = new Map<string, unknown>();
  private readonly pipelines = new Map<string, ObservedPipeline>();
  private readonly pipelinesByEnvironment = new Map<string, Map<string, ObservedPipeline>>();
  /** Ends not yet announced, by pipeline; cleared when their environment's edge is written. */
  private readonly endings = new Map<string, ObservedEnding>();
  private readonly dirtyEnvironments = new Set<string>();
  private reconcileTimer: unknown = null;
  private retryTimer: unknown = null;
  private retryMs = RETRY_MS;
  private initialized = false;
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
    if (!this.unsubscribe) this.initialized = false;
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
    log.warn("sidebar.reconcile-failed", { error: formatLogError(error) });
  }

  private onResourceChange(change: ResourceChange): void {
    if (change.resource !== "build-pipeline") return;
    if (this.changeTimers.has(change.id)) return;
    this.changeTimers.set(
      change.id,
      this.timers.setTimeout(() => {
        this.changeTimers.delete(change.id);
        void this.observe(change.id).catch((error: unknown) => {
          log.warn("sidebar.update-failed", {
            pipelineId: change.id,
            error: formatLogError(error),
          });
        });
      }, this.debounceMs),
    );
  }

  /** Observes one pipeline now, including its deletion. */
  observe(pipelineId: string): Promise<void> {
    return this.serialize(async () => {
      // A failed startup may have left us without the previous environment of
      // a moved or deleted record. Recover from the persisted activity sources.
      if (!this.initialized) return this.reconcileAll();

      const record = await this.storage.getBuildPipeline(pipelineId);
      const next = record ? observePipeline(record) : null;
      const affected = new Set<string>();
      this.updatePipeline(pipelineId, next, affected);
      await this.syncEnvironments(affected, async (environment) =>
        next?.working && next.environmentId === environment.id
          ? [next]
          : this.refreshEnvironmentPipelines(environment),
      );
    });
  }

  /**
   * Every environment with a pipeline, or a `build-pipeline` source left from
   * before a restart: the recovery path for a missed change.
   */
  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileAll());
  }

  private async reconcileAll(): Promise<void> {
    const environments = await this.storage.loadEnvironments();
    for (const environment of environments) {
      if (environment.agentActivitySources?.["build-pipeline"]) {
        this.dirtyEnvironments.add(environment.id);
      }
    }
    await this.refreshPipelines();
    await this.syncEnvironments(this.dirtyEnvironments);
    this.initialized = true;
    // Only a full pass can recover failed reads and reconcile every dirty
    // environment, so an unrelated successful event cannot cancel a retry.
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = RETRY_MS;
  }

  private async refreshEnvironmentPipelines(environment: Environment): Promise<ObservedPipeline[]> {
    const records = await this.storage.listBuildPipelinesForEnvironment(
      environment.projectId,
      environment.id,
    );
    const pipelines: ObservedPipeline[] = [];
    for (const record of records) {
      const observed = observePipeline(record);
      if (!observed) continue;
      pipelines.push(observed);
      const previous = this.pipelines.get(record.id);
      // Keep a known previous assignment until the pipeline's own event or
      // the full sweep can reconcile both sides of a move.
      if (!previous || previous.environmentId === environment.id) {
        this.updatePipeline(record.id, observed, this.dirtyEnvironments);
      }
    }
    return pipelines;
  }

  private async refreshPipelines(): Promise<void> {
    const records = await this.storage.listAllBuildPipelines();
    const missing = new Set(this.pipelines.keys());
    for (const record of records) {
      missing.delete(record.id);
      this.updatePipeline(record.id, observePipeline(record), this.dirtyEnvironments);
    }
    for (const pipelineId of missing) {
      this.updatePipeline(pipelineId, null, this.dirtyEnvironments);
    }
  }

  private updatePipeline(
    pipelineId: string,
    next: ObservedPipeline | null,
    affected: Set<string>,
  ): void {
    const previous = this.pipelines.get(pipelineId);
    if (previous) {
      affected.add(previous.environmentId);
      if (previous.environmentId !== next?.environmentId) {
        const siblings = this.pipelinesByEnvironment.get(previous.environmentId);
        siblings?.delete(pipelineId);
        if (siblings?.size === 0) this.pipelinesByEnvironment.delete(previous.environmentId);
      }
    }
    if (!next) {
      this.pipelines.delete(pipelineId);
      return;
    }
    this.pipelines.set(pipelineId, next);
    let siblings = this.pipelinesByEnvironment.get(next.environmentId);
    if (!siblings) {
      siblings = new Map();
      this.pipelinesByEnvironment.set(next.environmentId, siblings);
    }
    siblings.set(pipelineId, next);
    affected.add(next.environmentId);
    this.noteEnding(pipelineId, previous, next);
  }

  /**
   * Remembers an end this process watched happen. The store's timestamps
   * alone can miss one: a pipeline can end between the read that saw it
   * working and the activity write that went `working`.
   */
  private noteEnding(
    pipelineId: string,
    before: ObservedPipeline | undefined,
    observed: ObservedPipeline,
  ): void {
    if (observed.end === undefined) {
      // Active again: someone resumed or retried it, so its earlier end is old news.
      this.endings.delete(pipelineId);
      return;
    }
    const known = this.endings.get(pipelineId);
    let fromStall: boolean;
    if (before && before.end === undefined && (before.working || before.stalled)) {
      fromStall = before.stalled;
    } else if (known) {
      fromStall = known.fromStall;
    } else {
      return;
    }
    this.endings.set(pipelineId, {
      environmentId: observed.environmentId,
      end: observed.end,
      fromStall,
      key: `build-pipeline:${pipelineId}:${observed.revision}`,
    });
  }

  private endingsFor(environmentId: string): Array<[string, ObservedEnding]> {
    return Array.from(this.endings).filter(([, ending]) => ending.environmentId === environmentId);
  }

  /**
   * A stalled pipeline's source already went idle, ringing nothing, so the
   * edge cannot announce its real end. Ring it once, keyed by the record.
   */
  private async announceStalledEnds(environmentId: string): Promise<void> {
    for (const [pipelineId, ending] of this.endingsFor(environmentId)) {
      if (ending.fromStall && ending.end !== "quiet") {
        await this.storage.recordEnvironmentSessionCompletion(
          environmentId,
          this.now(),
          ending.end === "failed" ? "agent_failed" : "agent_finished",
          ending.key,
        );
      }
      this.endings.delete(pipelineId);
    }
  }

  private clearEndings(environmentId: string): void {
    for (const [pipelineId] of this.endingsFor(environmentId)) this.endings.delete(pipelineId);
  }

  private async syncEnvironments(
    affected: ReadonlySet<string>,
    readPipelines?: (environment: Environment) => Promise<ObservedPipeline[]>,
  ): Promise<void> {
    // Attempt every environment even if one fails; only durable successes leave
    // the set. A deleted pipeline's former environment remains here for retry.
    const failures: unknown[] = [];
    for (const environmentId of Array.from(affected)) {
      this.dirtyEnvironments.add(environmentId);
      try {
        await this.syncEnvironment(environmentId, readPipelines);
        this.dirtyEnvironments.delete(environmentId);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  }

  private async syncEnvironment(
    environmentId: string,
    readPipelines?: (environment: Environment) => Promise<ObservedPipeline[]>,
  ): Promise<void> {
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment) {
      this.clearEndings(environmentId);
      return;
    }
    const pipelines = readPipelines
      ? await readPipelines(environment)
      : Array.from(this.pipelinesByEnvironment.get(environmentId)?.values() ?? []);
    const desired: AgentActivityState = pipelines.some((pipeline) => pipeline.working)
      ? "working"
      : "idle";
    const source = environment.agentActivitySources?.["build-pipeline"];
    const current = source?.state;
    if (current === desired || (current === undefined && desired === "idle")) {
      // While the source stays working, an end seen meanwhile waits for its edge.
      if (desired === "idle") await this.announceStalledEnds(environmentId);
      return;
    }
    let completionOutcome: AgentActivityCompletionOutcome | undefined;
    if (source && current === "working" && desired === "idle") {
      // The ends this process watched, plus stored phase transitions since the
      // source went working: recovery after a restart or another backend.
      // Metadata saves retain that transition time.
      const since = Date.parse(source.observedAt ?? source.updatedAt);
      completionOutcome = buildPipelineCompletionOutcome([
        ...this.endingsFor(environmentId).map(([, ending]) => ending.end),
        ...pipelines.flatMap((pipeline) =>
          pipeline.end !== undefined && Date.parse(pipeline.endedAt) >= since ? [pipeline.end] : [],
        ),
      ]);
    }
    await this.storage.setEnvironmentAgentActivity(
      environmentId,
      desired,
      this.now(),
      "build-pipeline",
      undefined,
      false,
      { completionOutcome },
    );
    if (desired === "idle") this.clearEndings(environmentId);
  }
}

import { randomUUID } from "node:crypto";
import { PrMonitorService } from "./pr-monitor.js";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import type { BackendEmit, CommandContext } from "./commands-context.js";
import { WorkAdmissionPool } from "./work-admission.js";
import {
  detectEnvironmentPullRequest,
  environmentToPrMonitorTarget,
  findKanbanTaskForEnvironment,
  prMonitorCooldownScope,
  projectHomePrTarget,
} from "./commands-pr-monitor.js";
import { readCheckoutBranch, refreshProjectHomeBranch } from "./project-home-environment.js";

/**
 * Starts the cleanup that follows a merged PR when the environment asked for
 * one. It is owned by `commands-servers` (it ends in `deleteEnvironmentTask`),
 * which imports the PR monitor in turn, so the backend passes it in at
 * construction instead of this module importing it.
 */
export type MergeCleanupScheduler = (environmentId: string, context: CommandContext) => void;

export type PrMonitorRuntimeOptions = {
  /**
   * `scheduleMergeCleanupRecovery` from `commands-servers.ts` in the backend
   * (`index.ts`) and in command fixtures. Without it a merged observation's
   * cleanup is skipped with one warning; the cleanup intent stays durable on
   * the environment, and `get_environments` resumes it through its own context.
   */
  scheduleMergeCleanup?: MergeCleanupScheduler;
};

/**
 * Backend PR monitoring for one backend instance: the `PrMonitorService` and
 * its timers, the `external-pr` admission pool, and the reconciliation queue
 * that feeds it from storage.
 *
 * The service is created on first use, so a runtime that never monitors a PR
 * holds no pool registration, and `shutdown()` releases everything. The monitor
 * reads storage and emits through the context of its latest caller, as every
 * entry point passes one.
 */
export class PrMonitorRuntime {
  private readonly scheduleMergeCleanup: MergeCleanupScheduler | undefined;
  private monitor: { service: PrMonitorService; admission: WorkAdmissionPool } | null = null;
  private emit: BackendEmit | undefined;
  private storage: StorageService | undefined;
  private context: CommandContext | undefined;
  private syncGeneration = 0;
  private syncQueue: Promise<void> = Promise.resolve();
  private warnedMissingMergeCleanup = false;
  private closedService: Pick<PrMonitorService, keyof PrMonitorService> | undefined;

  constructor(options: PrMonitorRuntimeOptions = {}) {
    this.scheduleMergeCleanup = options.scheduleMergeCleanup;
  }

  /** The polling service; callers reach it at call time, never hold it. */
  get service(): Pick<PrMonitorService, keyof PrMonitorService> {
    if (this.closedService) return this.closedService;
    this.monitor ??= this.createMonitor();
    return this.monitor.service;
  }

  /**
   * Reconciles the monitored set against storage. Serialised, and a sync that
   * a later lifecycle action invalidated while it was loading is discarded.
   */
  async sync(context: CommandContext): Promise<void> {
    if (this.closedService) return;
    this.bind(context);
    const generation = this.syncGeneration;
    const operation = this.syncQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.closedService) return;
        const environments = await context.storage.loadEnvironments();
        // A stop, delete, shutdown, or newer reconciliation may have happened
        // while storage was loading; applying this older snapshot would recreate
        // a poller the later lifecycle action deliberately removed.
        if (generation !== this.syncGeneration) return;
        const targets = await Promise.all(
          environments.map(async (environment) => {
            try {
              return await projectHomePrTarget(environment, context.storage);
            } catch {
              return {
                ...environmentToPrMonitorTarget(environment),
                ready: false,
                prUrl: null,
                prState: null,
              };
            }
          }),
        );
        if (generation !== this.syncGeneration) return;
        this.service.sync(targets);
      });
    this.syncQueue = operation;
    await operation;
  }

  /** Discards any sync still loading storage; call before untracking or pausing. */
  invalidatePendingSync(): void {
    this.syncGeneration += 1;
  }

  /**
   * Agent-completion edge for PR monitoring. Fire on the working → idle
   * transition (never per idle reading). Resets the due time of a monitored
   * environment — including a quiet merged/closed one — and gives an unmonitored
   * environment one provisional discovery that leaves no trace if it finds
   * nothing.
   */
  async wakeForCompletion(environmentId: string, context: CommandContext): Promise<void> {
    if (this.closedService) return;
    this.bind(context);
    const stored = await context.storage.getEnvironment(environmentId);
    if (this.closedService || !stored) return;
    // A turn in the project home may have switched the checkout's branch (a PR
    // session branches off the base before pushing); follow it first.
    const environment = await refreshProjectHomeBranch(stored, context.storage, readCheckoutBranch);
    const target = await projectHomePrTarget(environment, context.storage);
    if (!this.closedService) this.service.wakeForCompletion(target);
  }

  /**
   * Runs a check now for a monitored environment: an explicit user refresh
   * (`interactive`, bypasses quiet cadence and rate-limit cooldown) or an armed
   * agent-completion recheck (`completion`). No-op for unmonitored or paused
   * environments.
   */
  async requestRefresh(
    environmentId: string,
    context: CommandContext,
    reason: "interactive" | "completion" = "interactive",
  ): Promise<void> {
    if (this.closedService) return;
    await this.sync(context);
    this.service.requestCheck(environmentId, reason);
  }

  /** Applies a merge the backend itself confirmed, without waiting for a poll. */
  async reconcileConfirmedMerge(environment: Environment, context: CommandContext): Promise<void> {
    if (this.closedService || !environment.prUrl) return;
    this.bind(context);
    const confirmedEnvironment: Environment = {
      ...environment,
      prState: "merged",
      hasMergeConflicts: false,
    };
    await this.service.reconcileTerminal(environmentToPrMonitorTarget(confirmedEnvironment), {
      url: environment.prUrl,
      state: "merged",
      hasMergeConflicts: false,
      checkSummary: null,
      checkSummaryStatus: "skipped",
    });
  }

  /**
   * The service's terminal follow-up, called once the terminal state is
   * persisted and the linked task is reconciled, so a cleanup deletion can no
   * longer orphan the task comment. The scheduler reads the durable cleanup
   * intent itself and de-duplicates per environment, so repeating this is
   * harmless.
   */
  resumeTerminalEffects(
    environmentId: string,
    observation: { url: string; state: "merged" | "closed" },
  ): void {
    if (this.closedService || observation.state !== "merged" || !this.context) return;
    if (this.scheduleMergeCleanup) {
      this.scheduleMergeCleanup(environmentId, this.context);
      return;
    }
    if (this.warnedMissingMergeCleanup) return;
    this.warnedMissingMergeCleanup = true;
    console.warn(
      "[pr-monitor] Merged PR observed, but this runtime has no merge cleanup scheduler; skipping cleanup",
    );
  }

  /** Terminal close: releases every PR polling timer and the admission pool. */
  shutdown(): void {
    if (this.closedService) return;
    this.invalidatePendingSync();
    const monitor = this.monitor;
    this.monitor = null;
    monitor?.service.shutdown();
    monitor?.admission.close();
    // Late lifecycle cleanup still reaches `service` after the backend stops.
    // Keep the public surface inert, even if the lazy monitor was never used.
    const stamp = monitor?.service.currentRevision() ?? { generation: randomUUID(), revision: 0 };
    const noop = () => undefined;
    this.closedService = {
      generation: stamp.generation,
      sync: noop,
      requestMode: noop,
      requestCheck: noop,
      reconcileTerminal: async () => undefined,
      wakeForCompletion: noop,
      probe: noop,
      pause: noop,
      untrack: noop,
      trackedIds: () => [],
      snapshot: () => [],
      observationPolicy: () => null,
      currentRevision: () => ({ ...stamp }),
      revisionedSnapshot: () => ({ ...stamp, entries: [] }),
      shutdown: noop,
    };
  }

  private bind(context: CommandContext): void {
    this.emit = context.emit;
    this.storage = context.storage;
    this.context = context;
  }

  private requireStorage(): StorageService {
    if (!this.storage) throw new Error("PR monitor storage is not initialised");
    return this.storage;
  }

  private createMonitor(): { service: PrMonitorService; admission: WorkAdmissionPool } {
    /**
     * Aggregate bound on backend PR detections: 2 concurrent, 1 per
     * environment, user intent before quiet discovery, starvation cap 8
     * (`work-admission.ts`).
     */
    const admission = new WorkAdmissionPool({ name: "external-pr" });
    const service = new PrMonitorService({
      emit: (event, payload) => this.emit?.(event, payload),
      admission,
      cooldownScope: prMonitorCooldownScope,
      effects: {
        detect: (target, options) =>
          detectEnvironmentPullRequest(target, { ...options, storage: this.storage }),
        persistPr: async (environmentId, detection) => {
          await this.requireStorage().updateEnvironment(environmentId, {
            prUrl: detection.url,
            prBaseBranch: detection.baseBranch ?? null,
            prState: detection.state,
            hasMergeConflicts: detection.hasMergeConflicts,
            ...(detection.mergeability !== undefined
              ? { prMergeability: detection.mergeability }
              : {}),
            ...(detection.state !== "open" || detection.hasMergeConflicts === false
              ? { prRecheckAfterAgentCompletionArmedAt: undefined }
              : {}),
          });
        },
        readTarget: async (environmentId) => {
          const storage = this.requireStorage();
          const environment = await storage.getEnvironment(environmentId);
          return environment ? projectHomePrTarget(environment, storage) : null;
        },
        resumeTerminalEffects: (environmentId, observation) =>
          this.resumeTerminalEffects(environmentId, observation),
        clearPr: async (environmentId) => {
          await this.requireStorage().updateEnvironment(environmentId, {
            prUrl: null,
            prBaseBranch: null,
            prState: null,
            hasMergeConflicts: null,
            prRecheckAfterAgentCompletionArmedAt: undefined,
          });
        },
        findTaskForEnvironment: (environmentId) =>
          findKanbanTaskForEnvironment(this.requireStorage(), environmentId),
        moveTaskToReview: async (taskId) => {
          await this.requireStorage().kanban.updateKanbanTask(taskId, { status: "review" });
        },
        addTaskComment: async (taskId, text) => {
          await this.requireStorage().kanban.addKanbanComment(taskId, text);
        },
        updateTaskPrMetadata: async (taskId, updates) => {
          await this.requireStorage().kanban.updateKanbanTask(taskId, updates);
        },
      },
      onWarning: (message, error) => {
        console.warn(`[pr-monitor] ${message}:`, error instanceof Error ? error.message : error);
      },
    });
    return { service, admission };
  }
}

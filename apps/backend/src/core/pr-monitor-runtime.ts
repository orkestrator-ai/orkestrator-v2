import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import { randomUUID } from "node:crypto";
import {
  type PrMonitorEnvironmentState,
  type PrCheckSummary,
  type PrMonitorEvent,
} from "@orkestrator/protocol/pr-monitor";
import { isPrReadingConfirmedByMonitor } from "@orkestrator/protocol/pr-merge-readiness";
import { PrMonitorService, type PrMonitorServiceOptions } from "./pr-monitor.js";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import type { BackendEmit, CommandContext } from "./commands-context.js";
import { prMonitorChangedEvent } from "@orkestrator/protocol/contract/domains/events";
import { WorkAdmissionPool } from "./work-admission.js";
import {
  detectEnvironmentPullRequest,
  environmentToPrMonitorTarget,
  findKanbanTaskForEnvironment,
  prMonitorCooldownScope,
  projectHomePrTarget,
} from "./commands-pr-monitor.js";
import { readCheckoutBranch, refreshProjectHomeBranch } from "./project-home-environment.js";
import {
  PrViewerPermissionCache,
  prViewerPermissionScope,
  prViewerRepository,
} from "./pr-viewer-permission.js";
import { PrRequiredChecksCache } from "./pr-required-checks.js";
import { PR_BATCH_TIMEOUT_MS, PrMonitorBatchReader } from "./commands-pr-monitor-batch.js";
import { gitHubCli, type GitHubCliSelection } from "./github-cli-binary.js";
import { gitHubCliEnv } from "./github-credentials.js";
import { runCommand } from "./shell.js";
import { ProjectCheckoutMergeFollower } from "./project-checkout-merge-follow.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("pull-request");

/** What a node summary relays about an environment's PR monitor (todo 0796). */
export interface RelayedPrMonitorHealth {
  prMonitorConfirmed?: true;
  prViewerCanMerge?: boolean;
  prCheckSummary?: PrCheckSummary;
}

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
  /** Clock and timers for deterministic runtime integration tests. */
  timing?: Pick<PrMonitorServiceOptions, "schedule" | "cancel" | "monotonicNow" | "random">;
  /** Follows merges into project checkouts; tests pass one with their own timers. */
  checkoutFollower?: ProjectCheckoutMergeFollower;
  /** The backend's `gh`, set by `BackendRuntime`; absent, `gh` comes from PATH. */
  gitHubCli?: GitHubCliSelection;
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
  private readonly endedContainers = new Map<string, string>();

  /** An end event fences recurring work even if Docker inspect is unavailable. */
  containerEnded(environmentId: string, containerId: string): void {
    this.endedContainers.set(environmentId, containerId);
    this.invalidatePendingSync();
    this.service.pause(environmentId);
  }

  containerStarted(containerId: string): void {
    for (const [id, ended] of Array.from(this.endedContainers)) {
      if (ended.startsWith(containerId) || containerId.startsWith(ended)) {
        this.endedContainers.delete(id);
      }
    }
  }

  private applyContainerEvents<
    T extends { id: string; containerId?: string | null; status: string },
  >(environments: T[]): T[] {
    return environments.map((env) =>
      this.endedContainers.get(env.id) === env.containerId ? { ...env, status: "stopped" } : env,
    );
  }

  private syncGeneration = 0;
  private syncQueue: Promise<void> = Promise.resolve();
  /**
   * A sync queued behind the running one that has not read storage yet. A
   * caller arriving now joins it: it will read storage after this call, so it
   * answers this caller too (BG-13: every `get_environments` asked for one).
   */
  private queuedSync: { generation: number; promise: Promise<void> } | null = null;
  private warnedMissingMergeCleanup = false;
  private recordedMergesClosed = false;
  private closedService: Pick<PrMonitorService, keyof PrMonitorService> | undefined;
  private readonly listeners = new Set<(event: PrMonitorEvent) => void>();
  /** Merge permission per credential scope and repository, refreshed hourly. */
  readonly viewerPermissions = new PrViewerPermissionCache();
  /** How many failing checks GitHub requires, per PR head and failing set. */
  readonly requiredChecks = new PrRequiredChecksCache();
  /**
   * One query for the local open PRs of a host and credential
   * (`commands-pr-monitor-batch.ts`). A change it sees for a quiet PR wakes
   * that PR's entry, which then reads the shared answer.
   */
  readonly prBatches = new PrMonitorBatchReader({
    run: async (_group, args) =>
      (
        await runCommand(gitHubCli(this.options.gitHubCli), args, {
          timeoutMs: PR_BATCH_TIMEOUT_MS,
          env: await gitHubCliEnv(this.storage),
        })
      ).stdout,
    onChanged: (prUrls) => this.noteSharedActivity(prUrls),
  });
  /**
   * The monitor-side inputs of each environment's relayed health, as last
   * announced. A change announces `environment-pr-health` so command nodes
   * re-read the summary; uneventful events (another error, the same rollup) do not.
   */
  private readonly relayedInputs = new Map<string, string>();
  /** Fast-forwards a project's checkout after one of its environments' PRs merged. */
  readonly checkoutFollower: ProjectCheckoutMergeFollower;

  constructor(private readonly options: PrMonitorRuntimeOptions = {}) {
    this.scheduleMergeCleanup = options.scheduleMergeCleanup;
    this.checkoutFollower = options.checkoutFollower ?? new ProjectCheckoutMergeFollower();
    this.viewerPermissions.onScopeInvalidated = (scope) => this.prBatches.invalidate(scope);
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
    this.closeRecordedMergesOnce(context.storage);
    const generation = this.syncGeneration;
    const queued = this.queuedSync;
    if (queued && queued.generation === generation) return queued.promise;
    const operation: Promise<void> = this.syncQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.queuedSync?.promise === operation) this.queuedSync = null;
        if (this.closedService) return;
        const stored = await context.storage.loadEnvironments();
        for (const id of Array.from(this.endedContainers.keys())) {
          if (!stored.some((env) => env.id === id)) this.endedContainers.delete(id);
        }
        const environments = this.applyContainerEvents(stored);
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
    this.queuedSync = { generation, promise: operation };
    this.syncQueue = operation;
    await operation;
  }

  /**
   * Once per process, moves tickets to done whose merged pull request is
   * recorded on them but never closed them (`kanban-merge-closure.ts`): ones
   * an older build left in backlog or review, and ones whose environment was
   * deleted before the monitor applied the merge. Best effort and off the
   * sync path; a failure is retried by the next backend start.
   */
  private closeRecordedMergesOnce(storage: StorageService): void {
    if (this.recordedMergesClosed) return;
    this.recordedMergesClosed = true;
    // Embedded command adapters may implement only the environment subset.
    if (typeof storage.kanban?.closeKanbanTasksForMergedPullRequests !== "function") return;
    void Promise.resolve()
      .then(() => storage.kanban.closeKanbanTasksForMergedPullRequests())
      .then((closed) => {
        if (closed.length > 0) log.info("monitor.merged-tickets-closed", { count: closed.length });
      })
      .catch((error: unknown) => {
        log.warn("monitor.merged-tickets-close-failed", { error: formatLogError(error) });
      });
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
    const target = await projectHomePrTarget(
      this.applyContainerEvents([environment])[0]!,
      context.storage,
    );
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
   * Brings the project's checkout up to date with a merge, so its coordinator
   * (and project home) read the merged code: fetches and fast-forwards
   * whenever Git can do so cleanly, retrying while a turn holds the checkout
   * (`project-checkout-merge-follow.ts`). Every merge path calls this: the
   * backend's own merge commands when GitHub confirms the merge, and the
   * monitor's terminal follow-up for a merge made anywhere else. The project
   * home's own PR is not followed: its checkout is the PR's branch, not the
   * base it merged into. Only a project with a coordinator or a project home
   * is touched, since nothing else reads that checkout. Never throws.
   */
  followMergeIntoProjectCheckout(
    environment: Pick<Environment, "projectId" | "prUrl" | "projectHome">,
    context: CommandContext,
  ): void {
    if (this.closedService || isProjectHomeEnvironment(environment)) return;
    const projectGit = context.projectGit;
    const projectId = environment.projectId;
    if (!projectGit || !projectId) return;
    void (async () => {
      const followed =
        (await context.storage.coordinators.getCoordinatorWorkspace(projectId)) !== null ||
        (await context.storage.getEnvironmentsByProject(projectId)).some(isProjectHomeEnvironment);
      if (followed && !this.closedService) {
        this.checkoutFollower.follow(projectId, projectGit, environment.prUrl ?? undefined);
      }
    })().catch((error: unknown) => {
      log.warn("checkout.follow-merge-lookup-failed", { error: formatLogError(error) });
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
    const context = this.context;
    void Promise.resolve()
      .then(() => context.storage.getEnvironment(environmentId))
      .then((environment) => {
        if (environment?.prUrl === observation.url) {
          this.followMergeIntoProjectCheckout(environment, context);
        }
      })
      .catch(() => undefined);
    if (this.scheduleMergeCleanup) {
      this.scheduleMergeCleanup(environmentId, this.context);
      return;
    }
    if (this.warnedMissingMergeCleanup) return;
    this.warnedMissingMergeCleanup = true;
    log.warn("cleanup-scheduler.missing");
  }

  /**
   * Forgets the cached merge permission for an environment's PR, e.g. after a
   * merge failed with a permission error. The next open-PR check asks again.
   */
  invalidateViewerPermission(environment: Environment): void {
    const repository = prViewerRepository(environment.prUrl);
    const scope = prViewerPermissionScope(environmentToPrMonitorTarget(environment));
    if (repository && scope) this.viewerPermissions.invalidate(scope, repository);
  }

  /**
   * The health a node summary relays for one environment, from the monitor's
   * announced state (what clients of this backend see). Never starts the
   * monitor: an environment it does not hold is unconfirmed.
   */
  relayedHealth(
    environment: Pick<
      Environment,
      "id" | "prUrl" | "prState" | "hasMergeConflicts" | "environmentType" | "status"
    >,
    announced: ReadonlyMap<string, PrMonitorEnvironmentState> = this.announcedStates(),
  ): RelayedPrMonitorHealth {
    const state = announced.get(environment.id) ?? null;
    if (!state || state.prUrl == null || state.prUrl !== (environment.prUrl ?? null)) return {};
    return {
      ...(isPrReadingConfirmedByMonitor(environment, state)
        ? { prMonitorConfirmed: true as const }
        : {}),
      ...(state.checkSummary ? { prCheckSummary: { ...state.checkSummary } } : {}),
      ...(typeof state.viewerCanMerge === "boolean"
        ? { prViewerCanMerge: state.viewerCanMerge }
        : {}),
    };
  }

  /** Announced monitor state by environment; empty before first use or after shutdown. */
  announcedStates(): Map<string, PrMonitorEnvironmentState> {
    const entries = this.closedService
      ? []
      : (this.monitor?.service.revisionedSnapshot().entries ?? []);
    return new Map(entries.map((entry) => [entry.environmentId, entry]));
  }

  /**
   * In-process observers of every announced monitor event (graph
   * `wait-for-checks` nodes wait on them instead of polling). Listeners run
   * synchronously after the event is emitted; one that throws is ignored.
   */
  onEvent(listener: (event: PrMonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private noteSharedActivity(prUrls: readonly string[]): void {
    const service = this.monitor?.service;
    if (!service || this.closedService) return;
    const urls = new Set(prUrls);
    for (const state of service.snapshot()) {
      if (state.prUrl && urls.has(state.prUrl)) service.noteSharedActivity(state.environmentId);
    }
  }

  private announce: BackendEmit = (event, payload) => {
    this.emit?.(event, payload);
    if (event.name !== prMonitorChangedEvent.name) return;
    this.noteRelayedInputs(payload as PrMonitorEvent);
    for (const listener of this.listeners) {
      try {
        listener(payload as PrMonitorEvent);
      } catch {
        // An observer must never break the monitor it observes.
      }
    }
  };

  /**
   * Announces `environment-pr-health` when the monitor-side inputs of an
   * environment's relayed health change. Inputs that live on the environment
   * record (status, persisted PR fields) announce themselves when written.
   * Content-free: the PR URL is compared here but never leaves in the hint.
   */
  private noteRelayedInputs(event: PrMonitorEvent): void {
    const environmentId = event.environmentId;
    const inputs = "removed" in event ? null : relayedInputsKey(event.state);
    const previous = this.relayedInputs.get(environmentId) ?? null;
    if (inputs === null) this.relayedInputs.delete(environmentId);
    else this.relayedInputs.set(environmentId, inputs);
    if (inputs === previous) return;
    const storage = this.storage;
    if (!storage) return;
    void storage
      .getEnvironment(environmentId)
      .then((environment) => {
        if (environment) storage.announceEnvironmentPrHealth(environmentId, environment.projectId);
      })
      .catch(() => undefined);
  }

  /** Terminal close: releases every PR polling timer and the admission pool. */
  shutdown(): void {
    if (this.closedService) return;
    this.invalidatePendingSync();
    this.viewerPermissions.clear();
    this.requiredChecks.clear();
    this.prBatches.clear();
    this.relayedInputs.clear();
    this.checkoutFollower.shutdown();
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
      noteSharedActivity: noop,
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
      ...this.options.timing,
      emit: this.announce,
      admission,
      cooldownScope: prMonitorCooldownScope,
      effects: {
        detect: (target, options) =>
          detectEnvironmentPullRequest(target, {
            ...options,
            storage: this.storage,
            gitHubCli: this.options.gitHubCli,
            viewerPermissions: this.viewerPermissions,
            requiredChecks: this.requiredChecks,
            batch: this.prBatches,
          }),
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
          return environment
            ? projectHomePrTarget(this.applyContainerEvents([environment])[0]!, storage)
            : null;
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
        closeTaskForMerge: async (taskId, prUrl) => {
          await this.requireStorage().kanban.closeKanbanTasksForMergedPullRequests([
            { taskId, prUrl },
          ]);
        },
        addTaskComment: async (taskId, text) => {
          await this.requireStorage().kanban.addKanbanComment(taskId, text);
        },
        updateTaskPrMetadata: async (taskId, updates) => {
          await this.requireStorage().kanban.updateKanbanTask(taskId, updates);
        },
      },
      onWarning: ({ event, environmentId, state }, error) => {
        log.warn(event, {
          environmentId,
          state,
          ...(error === undefined
            ? {}
            : {
                ...classifyCommandFailure(error, { tools: ["docker", "gh"] }),
                error: formatLogError(error),
              }),
        });
      },
    });
    return { service, admission };
  }
}

/** The monitor-side inputs of `RelayedPrMonitorHealth`, as one comparable key. */
function relayedInputsKey(state: PrMonitorEnvironmentState): string {
  return JSON.stringify([
    state.consecutiveErrors === 0,
    state.lastSuccessfulCheckAt != null,
    state.prUrl,
    state.prState,
    state.hasMergeConflicts,
    state.viewerCanMerge ?? null,
    state.checkSummary?.passed ?? null,
    state.checkSummary?.total ?? null,
    state.checkSummary?.pending ?? null,
    state.checkSummary?.requiredFailed ?? null,
  ]);
}

import {
  environmentBaselineCommit,
  resolveComparisonRef,
  type EnvironmentDiffBaseline,
} from "@orkestrator/protocol/diff-stats";
import { runRemoteGit } from "./git-noninteractive-env.js";
import { GitFetchScheduler } from "./git-fetch-scheduler.js";
import { runCommand } from "./shell.js";
import { gitDockerScanPool } from "./git-docker-scan-pool.js";
import {
  CONTAINER_TREE_MAX_AGE_MS,
  DiffStatsService,
  type DiffScanEvent,
  type DiffScanResult,
  type DiffStatsTarget,
} from "./diff-stats-service.js";
import {
  PhysicalKeyResolver,
  SharedScanQueue,
  SharedWatcherRegistry,
} from "./change-tracking/index.js";
import { startWorktreeWatcher } from "./worktree-watcher.js";
import { CONTAINER_FETCH_EXEC_MARGIN_MS, ContainerGitFetchPolicy } from "./container-git-fetch.js";
import { recurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import {
  ContainerWorktreeSignals,
  type ContainerWorktreeSignalContext,
  type ContainerWorktreeSignalInstaller,
} from "./container-worktree-signal.js";
import {
  buildContainerFetchScript,
  buildFileTree,
  CONTAINER_FILE_TREE_LISTER,
  getContainerGitStatusDetailed,
  getLocalGitStatusDetailed,
  MAX_FILE_TREE_NODES,
  parseContainerFileTree,
  type ContainerGitStatusDeps,
} from "./commands-files.js";
import { dockerExec } from "./commands-container-exec.js";
import {
  baselineTargetBranch,
  findIntegratedBaseline,
  isSameDiffBaseline,
  localBaselineGit,
} from "./diff-baseline.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { quoteShell } from "./commands-agent-support.js";
import type { BackendEmit, CommandContext } from "./commands-context.js";
import type { Environment } from "./models.js";

/**
 * How long an *unwatched* target's file list or tree (a container, or a local
 * worktree whose watcher failed) is served to a Files-panel reader.
 *
 * Comfortably under the panel's own refresh cadence, so the panel and the
 * sidebar looking at the same environment share one scan without the panel
 * ever showing something older than it would have fetched. Watched worktrees
 * are not age-bounded: their results stay valid until a watcher hint, a
 * mutation or an explicit refresh.
 *
 * Reconsidered when container fetches left the status scan (step 04): each
 * container read now costs one local-only exec rather than a fetch, but the
 * count is unchanged by design. With a 5 s panel poll, any bound of 5 s or
 * more would serve every other read from the previous poll and let a change
 * take up to ~10 s to show, over the 6 s Files-panel budget.
 *
 * Container *trees* are the exception (step 18): while a recent, complete
 * file list covers them they use `CONTAINER_TREE_MAX_AGE_MS`, because a
 * Git-visible membership change reaches the tree through that list within the
 * budget anyway (see `DiffStatsService`). Ad hoc (untracked) tree reads have
 * no such signal and keep this bound.
 */
export const DIFF_CACHE_MAX_AGE_MS = 3_000;

/** The worktree fetch scheduler as the backend runs it: real `git fetch`, shared per repository. */
export function createGitFetchScheduler(): GitFetchScheduler {
  return new GitFetchScheduler({
    run: (args, timeoutMs) =>
      args[2] === "fetch"
        ? runRemoteGit("fetch", args.slice(3), { cwd: args[1], timeoutMs })
        : runCommand("git", args, { timeoutMs }),
  });
}

export type DiffStatsTrackingOptions = {
  emit: BackendEmit;
  /** Every settled scan, for the change-tracking environment projector. */
  onScanEvent?: (event: DiffScanEvent) => void;
  /**
   * Arms container worktree signals (`container-worktree-signal-install.ts`).
   * Absent in tests and fixtures: every container keeps the unwatched bounds.
   */
  worktreeSignal?: ContainerWorktreeSignalInstaller | null;
};

/** What the baseline check needs to know about one local environment. */
type BaselineCandidate = {
  worktreePath: string;
  createdFromCommit: string;
  targetBranch: string;
  current: EnvironmentDiffBaseline | null;
};

/**
 * Diff stats and Git freshness for one backend: the worktree fetch scheduler,
 * the container fetch policy, the diff-stats service built on both, and the
 * reconciliation that decides which environments are tracked.
 */
export class DiffStatsTracking {
  /**
   * Shared by every worktree of every repository, so N environments of one
   * project make one fetch rather than N against the same origin.
   */
  readonly gitFetchScheduler: GitFetchScheduler;
  /**
   * Remote freshness for container clones (`container-git-fetch.ts`): status
   * scans read local refs, and fetches follow this policy instead of the scan
   * cadence. Fetches share the `git-docker-scan` pool under each container's
   * scan target key, so a fetch and a scan of one container never overlap.
   */
  readonly containerGitFetchPolicy: ContainerGitFetchPolicy;
  readonly service: DiffStatsService;
  readonly sharedWatchers: SharedWatcherRegistry;
  readonly sharedScans: SharedScanQueue<DiffScanResult>;
  private readonly ownedWorktreePaths = new Set<string>();
  private syncGeneration = 0;
  private stopped = false;
  private syncQueue: Promise<void> = Promise.resolve();
  private readonly removeFetchPolicyDiagnostics: () => void;
  /** Container watchers for the service; armed with the latest synced context. */
  readonly worktreeSignals: ContainerWorktreeSignals;
  private signalContext: ContainerWorktreeSignalContext | null = null;
  private readonly removeSignalDiagnostics: () => void;
  /** Local environments whose baseline can move, refreshed by every sync. */
  private readonly baselineCandidates = new Map<string, BaselineCandidate>();
  /** In-flight checks, and whether another scan asked for one meanwhile. */
  private readonly baselineChecks = new Map<string, { rerun: boolean }>();
  private baselineStorage: Pick<CommandContext, "storage"> | null = null;

  constructor(options: DiffStatsTrackingOptions) {
    this.gitFetchScheduler = createGitFetchScheduler();
    this.containerGitFetchPolicy = new ContainerGitFetchPolicy({
      admission: gitDockerScanPool,
      runFetch: (containerId, ref, timeoutMs) =>
        dockerExec(
          containerId,
          buildContainerFetchScript(ref, timeoutMs),
          timeoutMs + CONTAINER_FETCH_EXEC_MARGIN_MS,
        ),
      onChange: ({ containerId, baselineMoved }) => {
        // A moved `origin/<ref>` is outside anything a container scan watches:
        // rescan once (step 03's baseline hook). Otherwise only the announced
        // remote freshness may have changed.
        if (baselineMoved) this.service.invalidateBaseline({ containerId });
        this.service.remoteFreshnessChanged({ containerId });
      },
    });
    this.removeFetchPolicyDiagnostics = recurringDiagnosticsRegistry.addFetchPolicy(
      "container-git-fetch",
      this.containerGitFetchPolicy,
    );
    this.worktreeSignals = new ContainerWorktreeSignals({
      installer: options.worktreeSignal ?? null,
      context: () => this.signalContext,
    });
    this.removeSignalDiagnostics = recurringDiagnosticsRegistry.addSignalSource(
      "container-worktree-signal",
      this.worktreeSignals,
    );
    // Aliases of one physical worktree share scans and watchers; their
    // logical comparisons (environment + ref) stay separate.
    const physicalKeys = new PhysicalKeyResolver();
    const sharedScans = new SharedScanQueue<DiffScanResult>();
    this.sharedWatchers = new SharedWatcherRegistry(startWorktreeWatcher, physicalKeys);
    this.sharedScans = sharedScans;
    const containerStatus: ContainerGitStatusDeps = {
      exec: (id, script) => dockerExec(id, script),
      fetches: this.containerGitFetchPolicy,
    };
    this.service = new DiffStatsService({
      emit: options.emit,
      admission: gitDockerScanPool,
      fileListMaxAgeMs: DIFF_CACHE_MAX_AGE_MS,
      containerTreeMaxAgeMs: CONTAINER_TREE_MAX_AGE_MS,
      remoteFreshness: (target) =>
        target.kind === "container" && target.containerId
          ? this.containerGitFetchPolicy.freshness(target.containerId, target.comparisonRef)
          : undefined,
      onScanEvent: options.onScanEvent,
      startWatcher: this.sharedWatchers.startWatcher,
      startContainerWatcher: (watch) => this.worktreeSignals.start(watch),
      scan: async (target, request) => {
        // A scan follows every change the watcher sees, including HEAD moving
        // when the branch takes in newer target history.
        if (target.kind === "local") this.checkBaseline(target.environmentId);
        // Both clocks are `Date.now`, so a request delayed by admission joins a
        // pass that started after it was made.
        return sharedScans.run(
          `${physicalKeys.key(target)}\0${target.comparisonRef}`,
          () => this.scanPhysical(target, containerStatus),
          request?.requestedAtMs,
        );
      },
      readFiles: (request) =>
        request.kind === "local"
          ? getLocalGitStatusDetailed(
              request.worktreePath!,
              request.comparisonRef,
              request.includeUncommitted,
              this.gitFetchScheduler,
              this.ownedWorktreePaths.has(request.worktreePath!),
            )
          : getContainerGitStatusDetailed(
              request.containerId!,
              request.comparisonRef,
              request.includeUncommitted,
              containerStatus,
            ),
      walkTree: async (request) => {
        if (request.kind === "local") return buildFileTree(request.worktreePath!);
        return parseContainerFileTree(
          await dockerExec(
            request.containerId!,
            `node -e ${quoteShell(CONTAINER_FILE_TREE_LISTER)} -- /workspace ${MAX_FILE_TREE_NODES}`,
          ),
        );
      },
      onWarning: (message, error) => {
        console.warn(`[diff-stats] ${message}:`, error instanceof Error ? error.message : error);
      },
    });
  }

  /** One physical scan; equal concurrent requests join through {@link SharedScanQueue}. */
  private async scanPhysical(
    target: DiffStatsTarget,
    containerStatus: ContainerGitStatusDeps,
  ): Promise<DiffScanResult> {
    const detailed =
      target.kind === "local"
        ? await getLocalGitStatusDetailed(
            target.worktreePath!,
            target.comparisonRef,
            true,
            this.gitFetchScheduler,
            this.ownedWorktreePaths.has(target.worktreePath!),
          )
        : await getContainerGitStatusDetailed(
            target.containerId!,
            target.comparisonRef,
            true,
            containerStatus,
          );
    return {
      stats: {
        additions: detailed.changes.reduce((sum, change) => sum + change.additions, 0),
        deletions: detailed.changes.reduce((sum, change) => sum + change.deletions, 0),
        filesChanged: detailed.changes.length,
        truncated: detailed.truncated,
      },
      changes: detailed.changes,
      ...(detailed.baseOid ? { baseOid: detailed.baseOid } : {}),
      ...(detailed.ambiguousPaths ? { ambiguousPaths: detailed.ambiguousPaths } : {}),
    };
  }

  /**
   * Known remote mutations (a merge through the backend) and lifecycle changes
   * route here so the next reader does not wait out a fetch cooldown.
   */
  invalidateRemoteFreshness(
    environment: Pick<Environment, "environmentType" | "containerId" | "worktreePath">,
  ): void {
    if (environment.environmentType === "local") {
      if (environment.worktreePath) this.gitFetchScheduler.invalidate(environment.worktreePath);
      return;
    }
    if (environment.containerId) {
      this.containerGitFetchPolicy.invalidate({ containerId: environment.containerId }, "mutation");
    }
  }

  /** Discards any reconciliation still loading storage, so it cannot apply a stale snapshot. */
  invalidatePendingSync(): void {
    this.syncGeneration += 1;
  }

  /**
   * Reconciles which environments are tracked against what storage says exists.
   *
   * Reconciling the whole set rather than patching it means every caller - start,
   * stop, delete, a client connecting - converges on the same answer, and a missed
   * lifecycle event self-corrects on the next call instead of leaving an
   * environment permanently unwatched or a deleted one permanently watched.
   */
  async sync(
    context: Pick<CommandContext, "storage"> & Partial<Pick<CommandContext, "agentTools">>,
  ): Promise<void> {
    if (this.stopped) return;
    // A container watcher armed from here on uses this backend's agent tools.
    if (context.agentTools || !this.signalContext) this.signalContext = context;
    const generation = this.syncGeneration;
    const operation = this.syncQueue
      .catch(() => undefined)
      .then(async () => {
        if (this.stopped || generation !== this.syncGeneration) return;
        const [environments, config] = await Promise.all([
          context.storage.loadEnvironments(),
          context.storage.loadConfig(),
        ]);
        // A stop, delete, shutdown, or newer reconciliation may have happened
        // while storage was loading. Applying this older snapshot would recreate
        // a watcher or poller that the later lifecycle action deliberately
        // removed.
        if (generation !== this.syncGeneration) return;

        this.baselineStorage = context;
        this.baselineCandidates.clear();
        this.ownedWorktreePaths.clear();
        // A project home may itself be a linked checkout owned by the user.
        const homePaths = new Set(
          environments
            .filter(isProjectHomeEnvironment)
            .map((environment) => environment.worktreePath),
        );
        for (const environment of environments) {
          if (
            environment.environmentType === "local" &&
            environment.worktreePath &&
            !isProjectHomeEnvironment(environment) &&
            !homePaths.has(environment.worktreePath)
          ) {
            this.ownedWorktreePaths.add(environment.worktreePath);
          }
        }
        const live = new Set<string>();
        for (const environment of environments) {
          live.add(environment.id);
          const repositoryConfig = config.repositories?.[environment.projectId];
          const comparisonRef = resolveComparisonRef(
            environmentBaselineCommit(environment),
            repositoryConfig,
          );
          const targetBranch = baselineTargetBranch(environment, repositoryConfig);
          if (
            environment.environmentType === "local" &&
            environment.worktreePath &&
            environment.createdFromCommit &&
            targetBranch &&
            !isProjectHomeEnvironment(environment)
          ) {
            this.baselineCandidates.set(environment.id, {
              worktreePath: environment.worktreePath,
              createdFromCommit: environment.createdFromCommit,
              targetBranch,
              current: environment.diffBaseline ?? null,
            });
          }
          const target =
            environment.environmentType === "local"
              ? environment.worktreePath
                ? {
                    environmentId: environment.id,
                    kind: "local" as const,
                    worktreePath: environment.worktreePath,
                    comparisonRef,
                  }
                : undefined
              : environment.status === "running" && environment.containerId
                ? {
                    environmentId: environment.id,
                    kind: "container" as const,
                    containerId: environment.containerId,
                    comparisonRef,
                  }
                : undefined;

          // Readable now: scan it. Not readable but still an environment: hold the
          // last counts and stop scanning, rather than discarding a reading that
          // described work which is still on disk.
          if (target) this.service.track(target);
          else this.service.pause(environment.id);
        }

        for (const environmentId of this.service.trackedIds()) {
          if (!live.has(environmentId)) this.service.untrack(environmentId);
        }

        // Fetch state belongs to a running container generation: a stopped,
        // recreated or deleted container starts over (the lifecycle
        // invalidation of the container fetch policy).
        this.containerGitFetchPolicy.retainContainers(
          environments.flatMap((environment) =>
            environment.environmentType !== "local" &&
            environment.status === "running" &&
            environment.containerId
              ? [environment.containerId]
              : [],
          ),
        );
      });
    this.syncQueue = operation;
    await operation;
  }

  /**
   * Moves a local environment's diff baseline to where its branch now leaves
   * its target branch (`diff-baseline.ts`), then retargets its scans.
   *
   * Runs beside the scan rather than ahead of it so a scan never waits on it;
   * the scan that found the move is superseded by the retargeted one. One check
   * per environment at a time, so a burst of scans while an agent edits files
   * costs at most one more check. That one still runs: a merge moves HEAD in
   * several writes, and the scan for the last of them must not be dropped.
   */
  private checkBaseline(environmentId: string): void {
    const inFlight = this.baselineChecks.get(environmentId);
    if (inFlight) {
      inFlight.rerun = true;
      return;
    }
    const candidate = this.baselineCandidates.get(environmentId);
    const storage = this.baselineStorage;
    if (!candidate || !storage || this.stopped) return;
    const check = { rerun: false };
    this.baselineChecks.set(environmentId, check);
    void (async () => {
      const next = await findIntegratedBaseline(
        localBaselineGit(candidate.worktreePath),
        candidate.createdFromCommit,
        candidate.targetBranch,
      );
      if (this.stopped || next === undefined || isSameDiffBaseline(next, candidate.current)) return;
      await storage.storage.updateEnvironment(
        environmentId,
        { diffBaseline: next },
        async (environment) => {
          const config = await storage.storage.loadConfig();
          return (
            !this.stopped &&
            environment.environmentType === "local" &&
            !isProjectHomeEnvironment(environment) &&
            environment.worktreePath === candidate.worktreePath &&
            environment.createdFromCommit === candidate.createdFromCommit &&
            baselineTargetBranch(environment, config.repositories?.[environment.projectId]) ===
              candidate.targetBranch &&
            isSameDiffBaseline(environment.diffBaseline, candidate.current)
          );
        },
      );
      await this.sync(storage);
    })()
      .catch((error: unknown) => {
        console.warn(
          "[diff-stats] Could not update the environment diff baseline:",
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        this.baselineChecks.delete(environmentId);
        if (check.rerun) this.checkBaseline(environmentId);
      });
  }

  /** Releases every diff watcher and timer; called on backend shutdown. */
  shutdown(): void {
    this.stopped = true;
    this.invalidatePendingSync();
    this.service.shutdown();
    this.removeFetchPolicyDiagnostics();
    this.removeSignalDiagnostics();
  }
}

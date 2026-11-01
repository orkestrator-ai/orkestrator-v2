import {
  AgentAccountsRuntime,
  type AgentAccountsRuntimeOptions,
} from "./agent-accounts-runtime.js";
import { ContainerLogService, type ContainerLogServiceOptions } from "./container-log-service.js";
import { ContainerOomEvents, type ContainerOomEventsOptions } from "./container-oom-events.js";
import { ContainerUsageSampler } from "./container-usage-sampler.js";
import { DiffStatsTracking } from "./diff-stats-tracking.js";
import { DockerCleanupGrants } from "./docker-cleanup-grants.js";
import { DockerContainerStateCache } from "./docker-container-state-cache.js";
import { EnvironmentOperations } from "./environment-operations.js";
import { FeatureBuildTasks } from "./feature-build-tasks.js";
import { IntegrationLocks } from "./integration-locks.js";
import { LocalServerRuntime, type LocalServerRuntimeOptions } from "./local-server-runtime.js";
import { PrMonitorRuntime, type PrMonitorRuntimeOptions } from "./pr-monitor-runtime.js";
import { PublicApiReconciliations } from "./public-api/reconciliations.js";
import { TerminalRuntime, type TerminalRuntimeOptions } from "./terminal-runtime.js";
import { TmuxRuntime, type TmuxRuntimeOptions } from "./tmux-runtime.js";
import type { ChangeTrackingService } from "./change-tracking/index.js";
import type { BackendEmit } from "./commands-context.js";
import type { ContainerWorktreeSignalInstaller } from "./container-worktree-signal.js";

export type BackendRuntimeOptions = {
  /** Read at emit time, so a caller may pass a closure over a gateway that does not exist yet. */
  emit: BackendEmit;
  /** Docker-backed container worktree signal; absent in fixtures. */
  worktreeSignal?: ContainerWorktreeSignalInstaller | null;
  terminals?: TerminalRuntimeOptions;
  localServers?: LocalServerRuntimeOptions;
  /** The backend and command fixtures pass `scheduleMergeCleanup`; see `PrMonitorRuntimeOptions`. */
  prMonitor?: PrMonitorRuntimeOptions;
  /** The backend passes the local Claude config directory and the Docker doorbell. */
  tmux?: TmuxRuntimeOptions;
  /** The backend passes its login keeper's refreshers. */
  accounts?: AgentAccountsRuntimeOptions;
  /** Test seam: the OOM follower's `docker events` spawn. */
  containerOom?: ContainerOomEventsOptions;
  /** Test seams: the log followers' `docker logs -f` spawn and lease clock. */
  containerLogs?: ContainerLogServiceOptions;
};

/**
 * Process state owned by one backend instance.
 *
 * Each cluster is a class that owns its maps privately
 * (docs/architecture/backend-runtime.md). The
 * backend constructs one in `index.ts` and passes it as
 * `CommandContext.runtime`; command fixtures build a fresh one per context, so
 * two backends in one process never share state.
 *
 * Always reach it through the context at call time. Destructuring it at module
 * load would freeze one instance's state into every later caller.
 */
export class BackendRuntime {
  readonly diffStats: DiffStatsTracking;
  readonly terminals: TerminalRuntime;
  readonly localServers: LocalServerRuntime;
  readonly environments: EnvironmentOperations;
  readonly prMonitor: PrMonitorRuntime;
  /** claude-tmux sessions, interactive panes, Claude state polls and the orphan sweep. */
  readonly tmux: TmuxRuntime;
  /** Account mutations, sign-ins, usage caches and container login state; see AgentAccountsRuntime. */
  readonly accounts: AgentAccountsRuntime;
  /** The short-lived `docker ps` snapshot shared by status reads. */
  readonly containerStates = new DockerContainerStateCache();
  /** This backend's container usage sample (owner-filtered, so not host-wide). */
  readonly containerUsage = new ContainerUsageSampler();
  /** The `docker events` OOM follower, started by the backend once it knows its owner. */
  readonly containerOom: ContainerOomEvents;
  /** `docker logs -f` followers behind the log subscriptions. */
  readonly containerLogs: ContainerLogService;
  /** Reviewed Docker cleanup selection tokens. */
  readonly dockerCleanupGrants = new DockerCleanupGrants();
  /** GitHub and Linear write serialisation. */
  readonly integrationLocks = new IntegrationLocks();
  /** Feature-build ticket resolutions and title refinements in flight. */
  readonly featureBuilds = new FeatureBuildTasks();
  /** Public API operation reconciliations in flight. */
  readonly publicApi = new PublicApiReconciliations();
  /**
   * Backend change tracking (docs/architecture/change-tracking.md). Attached
   * by the backend once storage exists; absent in lightweight command
   * fixtures, where the `changes_*` commands report it unavailable.
   */
  changeTracking: ChangeTrackingService | null = null;

  constructor(options: BackendRuntimeOptions) {
    this.diffStats = new DiffStatsTracking({
      emit: options.emit,
      onScanEvent: (event) => this.changeTracking?.onDiffScanEvent(event),
      worktreeSignal: options.worktreeSignal,
    });
    this.terminals = new TerminalRuntime(options.terminals);
    this.localServers = new LocalServerRuntime(options.localServers);
    this.environments = new EnvironmentOperations();
    this.prMonitor = new PrMonitorRuntime(options.prMonitor);
    this.tmux = new TmuxRuntime(options.tmux);
    this.accounts = new AgentAccountsRuntime(options.accounts);
    this.containerOom = new ContainerOomEvents(options.containerOom?.spawn, () =>
      this.containerStates.invalidate(),
    );
    this.containerLogs = new ContainerLogService(
      options.containerLogs?.spawn,
      options.containerLogs?.now,
    );
  }

  attachChangeTracking(service: ChangeTrackingService): void {
    this.changeTracking = service;
  }

  /**
   * Releases everything the runtime owns synchronously; called once on backend
   * shutdown. Owned local servers are terminated by the backend's awaited
   * shutdown through `localServers.shutdown()`, after lifecycle work drains.
   * tmux sessions outlive the backend; only this backend's poll and pane
   * timers stop. The OOM and log followers are observers: stopping them never
   * touches a container.
   */
  shutdown(): void {
    this.diffStats.shutdown();
    this.changeTracking?.shutdown();
    this.terminals.shutdown();
    this.prMonitor.shutdown();
    this.tmux.shutdown();
    this.containerOom.stop();
    this.containerLogs.shutdown();
  }
}

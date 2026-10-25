import { DiffStatsTracking } from "./diff-stats-tracking.js";
import { DockerContainerStateCache } from "./docker-container-state-cache.js";
import { EnvironmentOperations } from "./environment-operations.js";
import { LocalServerRuntime, type LocalServerRuntimeOptions } from "./local-server-runtime.js";
import { PrMonitorRuntime, type PrMonitorRuntimeOptions } from "./pr-monitor-runtime.js";
import { TerminalRuntime, type TerminalRuntimeOptions } from "./terminal-runtime.js";
import type { ChangeTrackingService } from "./change-tracking/service.js";
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
};

/**
 * Process state owned by one backend instance.
 *
 * Each cluster is a class that owns its maps privately
 * (docs/todo/backend-structure/0011-backend-runtime-state-ownership.md). The
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
  /** The short-lived `docker ps` snapshot shared by status reads. */
  readonly containerStates = new DockerContainerStateCache();
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
  }

  attachChangeTracking(service: ChangeTrackingService): void {
    this.changeTracking = service;
  }

  /**
   * Releases everything the runtime owns synchronously; called once on backend
   * shutdown. Owned local servers are terminated by the backend's awaited
   * shutdown through `localServers.shutdown()`, after lifecycle work drains.
   */
  shutdown(): void {
    this.diffStats.shutdown();
    this.changeTracking?.shutdown();
    this.terminals.shutdown();
    this.prMonitor.shutdown();
  }
}

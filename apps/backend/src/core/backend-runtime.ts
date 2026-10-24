import { DiffStatsTracking } from "./diff-stats-tracking.js";
import type { ChangeTrackingService } from "./change-tracking/service.js";
import type { BackendEmit } from "./commands-context.js";
import type { ContainerWorktreeSignalInstaller } from "./container-worktree-signal.js";

export type BackendRuntimeOptions = {
  /** Read at emit time, so a caller may pass a closure over a gateway that does not exist yet. */
  emit: BackendEmit;
  /** Docker-backed container worktree signal; absent in fixtures. */
  worktreeSignal?: ContainerWorktreeSignalInstaller | null;
};

/**
 * Process state owned by one backend instance.
 *
 * Replaces the module-level maps and singletons in `commands-runtime-state.ts`
 * one cluster at a time (docs/todo/backend-structure/0011-backend-runtime-state-ownership.md). The
 * backend constructs one in `index.ts` and passes it as
 * `CommandContext.runtime`; command fixtures build a fresh one per context, so
 * two backends in one process never share state.
 *
 * Always reach it through the context at call time. Destructuring it at module
 * load would freeze one instance's state into every later caller.
 */
export class BackendRuntime {
  readonly diffStats: DiffStatsTracking;
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
  }

  attachChangeTracking(service: ChangeTrackingService): void {
    this.changeTracking = service;
  }

  /** Releases everything the runtime owns; called once on backend shutdown. */
  shutdown(): void {
    this.diffStats.shutdown();
    this.changeTracking?.shutdown();
  }
}

import { DiffStatsTracking } from "./diff-stats-tracking.js";
import type { BackendEmit } from "./commands-context.js";

export type BackendRuntimeOptions = {
  /** Read at emit time, so a caller may pass a closure over a gateway that does not exist yet. */
  emit: BackendEmit;
};

/**
 * Process state owned by one backend instance.
 *
 * Replaces the module-level maps and singletons in `commands-runtime-state.ts`
 * one cluster at a time (docs/2026-10-14/runtime-state-ownership.md). The
 * backend constructs one in `index.ts` and passes it as
 * `CommandContext.runtime`; command fixtures build a fresh one per context, so
 * two backends in one process never share state.
 *
 * Always reach it through the context at call time. Destructuring it at module
 * load would freeze one instance's state into every later caller.
 */
export class BackendRuntime {
  readonly diffStats: DiffStatsTracking;

  constructor(options: BackendRuntimeOptions) {
    this.diffStats = new DiffStatsTracking({ emit: options.emit });
  }

  /** Releases everything the runtime owns; called once on backend shutdown. */
  shutdown(): void {
    this.diffStats.shutdown();
  }
}

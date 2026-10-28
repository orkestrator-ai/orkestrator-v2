/**
 * Renderer adapters for `@orkestrator/protocol/pr-merge-readiness`.
 *
 * The protocol rule decides "ready to merge" from PR signals and a freshness
 * flag; these functions supply both for this machine's environments and for
 * another machine's rows, so every surface asks the same question the same way.
 */
import { isPrReadyToMerge } from "@orkestrator/protocol/pr-merge-readiness";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { HydrationStatus } from "@/lib/bounded-hydration";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { Environment } from "@/types";

/**
 * The monitor can only ask GitHub while it can run `gh`: a local worktree
 * always, a container only while it runs. A stopped container's reading is
 * whatever was true when it stopped.
 */
function isPolled(environmentType: string | null | undefined, status: string): boolean {
  return environmentType === "local" || status === "running";
}

export type ReadyToMergeEnvironment = Pick<
  Environment,
  "prUrl" | "prState" | "hasMergeConflicts" | "prMergeability" | "environmentType" | "status"
>;

/**
 * This machine's environment. Fresh means the PR monitor mirror is confirmed
 * current, the backend has answered a check for this exact PR in its current
 * lifetime, and the latest check did not fail.
 */
export function isLocalEnvironmentReadyToMerge(
  environment: ReadyToMergeEnvironment,
  monitor: PrMonitorEnvironmentState | null,
  syncStatus: HydrationStatus,
): boolean {
  const fresh =
    syncStatus === "current" &&
    monitor !== null &&
    monitor.prUrl === environment.prUrl &&
    monitor.prState === environment.prState &&
    monitor.hasMergeConflicts === false &&
    monitor.consecutiveErrors === 0 &&
    monitor.lastSuccessfulCheckAt != null &&
    isPolled(environment.environmentType, environment.status);
  return isPrReadyToMerge({
    prState: environment.prState,
    hasMergeConflicts: environment.hasMergeConflicts,
    mergeability: environment.prMergeability,
    checkSummary: monitor?.checkSummary ?? null,
    fresh,
  });
}

/**
 * Node summaries only contain persisted PR fields, not confirmation from the
 * leaf's current monitor lifetime. A current transport snapshot cannot prove
 * that GitHub was checked after a restart or that the latest check succeeded.
 * Keep all remote readiness surfaces off until summaries relay that health.
 */
export function isNodeEnvironmentReadyToMerge(
  _environment: FederatedEnvironment,
  _machine: Pick<MachineView, "transport" | "freshness">,
): boolean {
  return false;
}

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
 * Another machine's environment, from the command node's summary. Fresh means
 * the machine is connected and its summaries are current. The leaf's own
 * monitor errors are not relayed, so this trusts its last persisted reading.
 */
export function isNodeEnvironmentReadyToMerge(
  environment: FederatedEnvironment,
  machine: Pick<MachineView, "transport" | "freshness">,
): boolean {
  return isPrReadyToMerge({
    prState: environment.prState,
    hasMergeConflicts: environment.prHasMergeConflicts,
    mergeability: environment.prMergeability,
    fresh:
      machine.transport === "connected" &&
      machine.freshness === "current" &&
      !environment.deleting &&
      isPolled(environment.environmentType, environment.status),
  });
}

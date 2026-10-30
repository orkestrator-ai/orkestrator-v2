/**
 * Renderer adapters for `@orkestrator/protocol/pr-merge-readiness`.
 *
 * The protocol rule decides "ready to merge" from PR signals and a freshness
 * flag; these functions supply both for this machine's environments and for
 * another machine's rows, so every surface asks the same question the same way.
 */
import { evaluatePrMergeReadiness } from "@orkestrator/protocol/pr-merge-readiness";
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
 * What an environment's name says about its pull request: it waits only for
 * the user to merge it, or it cannot merge until its conflicts are resolved.
 */
export type PrMergeState = "ready" | "conflicts";

/**
 * This machine's environment. Fresh means the PR monitor mirror is confirmed
 * current, the backend has answered a check for this exact PR in its current
 * lifetime, and the latest check did not fail. Both answers need that, so a
 * stale reading shows neither the green nor the red shimmer.
 */
export function localEnvironmentPrMergeState(
  environment: ReadyToMergeEnvironment,
  monitor: PrMonitorEnvironmentState | null,
  syncStatus: HydrationStatus,
): PrMergeState | null {
  const fresh =
    syncStatus === "current" &&
    monitor !== null &&
    monitor.prUrl === environment.prUrl &&
    monitor.prState === environment.prState &&
    typeof environment.hasMergeConflicts === "boolean" &&
    monitor.hasMergeConflicts === environment.hasMergeConflicts &&
    monitor.consecutiveErrors === 0 &&
    monitor.lastSuccessfulCheckAt != null &&
    isPolled(environment.environmentType, environment.status);
  const readiness = evaluatePrMergeReadiness({
    prState: environment.prState,
    hasMergeConflicts: environment.hasMergeConflicts,
    mergeability: environment.prMergeability,
    checkSummary: monitor?.checkSummary ?? null,
    fresh,
  });
  if (readiness.ready) return "ready";
  return readiness.reason === "conflicts" ? "conflicts" : null;
}

export function isLocalEnvironmentReadyToMerge(
  environment: ReadyToMergeEnvironment,
  monitor: PrMonitorEnvironmentState | null,
  syncStatus: HydrationStatus,
): boolean {
  return localEnvironmentPrMergeState(environment, monitor, syncStatus) === "ready";
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

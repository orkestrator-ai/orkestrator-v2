/**
 * Renderer adapters for `@orkestrator/protocol/pr-merge-readiness`.
 *
 * The protocol rule decides "ready to merge" from PR signals and a freshness
 * flag; these functions supply both for this machine's environments and for
 * another machine's rows, so every surface asks the same question the same way.
 *
 * `requireChecks` is this machine's auto-merge "Require checks to pass"
 * setting ({@link shimmerRequiresChecks}), so the green name means exactly
 * what auto-merge would act on. Off, a failing or pending check GitHub does
 * not require leaves the name green; the merge surfaces show the checks.
 * Checks GitHub requires always block, because it reports them as `blocked`.
 */
import {
  evaluatePrMergeReadiness,
  isPrMonitorPolled,
  isPrReadingConfirmedByMonitor,
  type PrMergeReadiness,
} from "@orkestrator/protocol/pr-merge-readiness";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import type { HydrationStatus } from "@/lib/bounded-hydration";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import type { Environment } from "@/types";

/** Auto-merge's own default: checks are required unless turned off. */
export function shimmerRequiresChecks(global: { autoMergeRequireChecks?: boolean }): boolean {
  return global.autoMergeRequireChecks !== false;
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

function toPrMergeState(readiness: PrMergeReadiness): PrMergeState | null {
  if (readiness.ready) return "ready";
  return readiness.reason === "conflicts" ? "conflicts" : null;
}

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
  requireChecks: boolean,
): PrMergeState | null {
  return toPrMergeState(
    evaluatePrMergeReadiness({
      prState: environment.prState,
      hasMergeConflicts: environment.hasMergeConflicts,
      mergeability: environment.prMergeability,
      checkSummary: monitor?.checkSummary ?? null,
      viewerCanMerge: monitor?.viewerCanMerge ?? null,
      requireChecks,
      fresh: syncStatus === "current" && isPrReadingConfirmedByMonitor(environment, monitor),
    }),
  );
}

export function isLocalEnvironmentReadyToMerge(
  environment: ReadyToMergeEnvironment,
  monitor: PrMonitorEnvironmentState | null,
  syncStatus: HydrationStatus,
  requireChecks: boolean,
): boolean {
  return localEnvironmentPrMergeState(environment, monitor, syncStatus, requireChecks) === "ready";
}

/**
 * Another machine's environment, from its node summary. Fresh means the
 * machine is connected, its summaries are current, and the machine's own
 * monitor vouches for the reading (`prMonitorConfirmed`, decided there by the
 * same rule as this machine's rows). A node that predates the field never
 * vouches, so its rows stay plain. `requireChecks` is this machine's setting,
 * not the other machine's: its summaries do not relay that setting.
 */
export function nodeEnvironmentPrMergeState(
  environment: FederatedEnvironment,
  machine: Pick<MachineView, "transport" | "freshness">,
  requireChecks: boolean,
): PrMergeState | null {
  const fresh =
    machine.transport === "connected" &&
    machine.freshness === "current" &&
    !environment.deleting &&
    environment.prMonitorConfirmed === true &&
    isPrMonitorPolled(environment.environmentType, environment.status);
  return toPrMergeState(
    evaluatePrMergeReadiness({
      prState: environment.prState,
      hasMergeConflicts: environment.prHasMergeConflicts,
      mergeability: environment.prMergeability,
      checkSummary: environment.prCheckSummary ?? null,
      viewerCanMerge: environment.prViewerCanMerge ?? null,
      requireChecks,
      fresh,
    }),
  );
}

export function isNodeEnvironmentReadyToMerge(
  environment: FederatedEnvironment,
  machine: Pick<MachineView, "transport" | "freshness">,
  requireChecks: boolean,
): boolean {
  return nodeEnvironmentPrMergeState(environment, machine, requireChecks) === "ready";
}

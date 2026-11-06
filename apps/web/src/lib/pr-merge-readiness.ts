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
  type PrNotReadyReason,
} from "@orkestrator/protocol/pr-merge-readiness";
import {
  prRequiredCheckFailures,
  type PrCheckSummary,
  type PrMonitorEnvironmentState,
} from "@orkestrator/protocol/pr-monitor";
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
    localEnvironmentPrMergeReadiness(environment, monitor, syncStatus, requireChecks),
  );
}

/**
 * The whole readiness answer for this machine's environment, including why it
 * is not ready. Auto-merge decides on the same rule (`decideAutoMerge`), so
 * the reason is what an armed auto-merge is waiting for.
 */
export function localEnvironmentPrMergeReadiness(
  environment: ReadyToMergeEnvironment,
  monitor: PrMonitorEnvironmentState | null,
  syncStatus: HydrationStatus,
  requireChecks: boolean,
): PrMergeReadiness {
  return evaluatePrMergeReadiness({
    prState: environment.prState,
    hasMergeConflicts: environment.hasMergeConflicts,
    mergeability: environment.prMergeability,
    checkSummary: monitor?.checkSummary ?? null,
    viewerCanMerge: monitor?.viewerCanMerge ?? null,
    requireChecks,
    fresh: syncStatus === "current" && isPrReadingConfirmedByMonitor(environment, monitor),
  });
}

/** Why auto-merge has not merged a pull request yet, in words for the user. */
export interface AutoMergeHold {
  message: string;
  /**
   * Nobody needs to act: GitHub is still computing, checks are running, the
   * reading is catching up, or Resolve is handling conflicts. Otherwise the
   * hold lasts until the user (or GitHub's settings) changes something.
   */
  transient: boolean;
}

const REQUIRE_CHECKS_SETTING = "Settings → Version control → Auto-merge → Require checks to pass";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * What auto-merge would wait for, or null when it would merge (or there is no
 * open pull request to merge).
 */
export function describeAutoMergeHold(
  reason: PrNotReadyReason | null,
  checkSummary: PrCheckSummary | null,
): AutoMergeHold | null {
  const failed = checkSummary ? prRequiredCheckFailures(checkSummary).failed : 0;
  const pending = checkSummary?.pending ?? 0;
  const failing = (count: number) => ({
    message: `${plural(count, "check")} failed, and every check has to pass first. Re-run ${count === 1 ? "it" : "them"}, merge with Merge PR, or turn off ${REQUIRE_CHECKS_SETTING}.`,
    transient: false,
  });
  const running = (count: number) => ({
    message: `Waiting for ${plural(count, "check")} to finish.`,
    transient: true,
  });
  switch (reason) {
    case null:
    case "no-pull-request":
    case "not-open":
      return null;
    case "stale":
    case "mergeability-unknown":
      return { message: "Waiting for GitHub to report whether it can merge.", transient: true };
    case "conflicts":
      return {
        message: "Merge conflicts: Resolve fixes them, then the merge follows.",
        transient: true,
      };
    case "checks-failing":
      return failing(Math.max(failed, 1));
    case "checks-pending":
      return running(Math.max(pending, 1));
    case "checks-not-passing":
      // GitHub's `unstable`: a check it does not require has not passed. The
      // rollup, when there is one, says whether it failed or is still running.
      if (failed > 0) return failing(failed);
      if (pending > 0) return running(pending);
      return {
        message: `GitHub reports a check that has not passed, and every check has to pass first unless ${REQUIRE_CHECKS_SETTING} is off.`,
        transient: false,
      };
    case "blocked":
      return {
        message: "GitHub reports the merge as blocked, usually by a required review or check.",
        transient: false,
      };
    case "behind":
      return {
        message: "The branch is behind its base branch and has to be updated first.",
        transient: false,
      };
    case "draft":
      return { message: "The pull request is a draft.", transient: false };
    case "no-merge-permission":
      return {
        message: "The GitHub account Orkestrator merges with cannot merge this repository.",
        transient: false,
      };
  }
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

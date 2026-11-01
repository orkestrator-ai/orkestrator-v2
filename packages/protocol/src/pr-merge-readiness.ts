/**
 * Whether an environment's pull request is waiting only for the user to merge.
 *
 * The sidebar, search results and title make a ready environment's name
 * shimmer, so a user can see at a glance which pull requests are waiting for
 * them. This module is the one place that decides "ready". Every surface,
 * including another machine's rows on a command node, asks it.
 *
 * The rule is conservative: a missing, unknown or stale signal means "not
 * ready". A name that shimmers and then turns out not to be mergeable would
 * teach the user to ignore the shimmer.
 *
 * Signals, and where they come from:
 * - `prState` and `hasMergeConflicts`: the PR monitor's GitHub reading
 *   (`mergeable`), persisted on the environment.
 * - `mergeability`: the same reading's `mergeStateStatus` (and `isDraft`),
 *   persisted as `prMergeability`. GitHub computes it from branch protection,
 *   so `clean` already means required reviews and required checks are
 *   satisfied, the branch is not behind a base that must be up to date, and
 *   the pull request is not a draft. `unstable` (a non-required check failing
 *   or still running) is not ready: the shimmer stops on any failing check.
 * - `checkSummary`: the separately fetched check rollup, when the monitor has
 *   one. It can only veto: any failing or pending check means "not ready".
 * - `viewerCanMerge`: whether the credential Orkestrator merges with has push,
 *   maintain or admin on the repository. The monitor caches it per repository
 *   and credential for an hour, because the PR lookup does not return it. Only
 *   `false` vetoes: an unknown permission (cold cache, older backend) does not
 *   hide the shimmer. Push access does not prove a ruleset lets this user merge.
 * - `fresh`: decided by the caller from the monitor's sync state, because only
 *   the caller knows whether its mirror is current. The monitor half of it is
 *   {@link isPrReadingConfirmedByMonitor}, shared with the backend that relays
 *   it to command nodes.
 */

import type { GitHubPullRequestMergeability } from "./github-pull-requests.js";
import type { PrCheckSummary, PrMonitorEnvironmentState, PrState } from "./pr-monitor.js";

export const PR_MERGEABILITY_VALUES: readonly GitHubPullRequestMergeability[] = [
  "clean",
  "blocked",
  "dirty",
  "behind",
  "unstable",
  "unknown",
  "unavailable",
];

const MERGEABILITY_SET: ReadonlySet<string> = new Set(PR_MERGEABILITY_VALUES);

export function isPrMergeability(value: unknown): value is GitHubPullRequestMergeability {
  return typeof value === "string" && MERGEABILITY_SET.has(value);
}

/**
 * Maps `gh`'s GraphQL `mergeStateStatus` (and `isDraft`) onto the vocabulary
 * the pull-request viewer already uses for REST `mergeable_state`. Returns
 * null when GitHub sent neither field, so an older reading stays "unknown"
 * rather than being guessed.
 */
export function mergeabilityFromMergeStateStatus(
  mergeStateStatus: unknown,
  isDraft: unknown,
): GitHubPullRequestMergeability | null {
  if (isDraft === true) return "unavailable";
  if (typeof mergeStateStatus !== "string") return null;
  switch (mergeStateStatus.toUpperCase()) {
    case "CLEAN":
    case "HAS_HOOKS":
      return "clean";
    case "BLOCKED":
      return "blocked";
    case "DIRTY":
      return "dirty";
    case "BEHIND":
      return "behind";
    case "UNSTABLE":
      return "unstable";
    case "DRAFT":
      return "unavailable";
    default:
      return "unknown";
  }
}

export interface PrMergeReadinessSignals {
  prState: PrState | null | undefined;
  hasMergeConflicts: boolean | null | undefined;
  mergeability: GitHubPullRequestMergeability | null | undefined;
  /** Optional rollup; when present it must show every check passed. */
  checkSummary?: PrCheckSummary | null;
  /** Only `false` vetoes; null or absent means unknown. */
  viewerCanMerge?: boolean | null;
  /**
   * Only `false` relaxes the rule: failing or pending checks GitHub does not
   * require (`unstable`, a vetoing `checkSummary`) no longer block. Required
   * checks still block, because GitHub reports them as `blocked`.
   */
  requireChecks?: boolean;
  /** The caller's mirror of these signals is current. */
  fresh: boolean;
}

export type PrNotReadyReason =
  | "stale"
  | "no-pull-request"
  | "not-open"
  | "conflicts"
  | "mergeability-unknown"
  | "draft"
  | "blocked"
  | "behind"
  /** GitHub reports a non-required check failing or still running. */
  | "checks-not-passing"
  | "checks-failing"
  | "checks-pending"
  /** Everything else is ready, but the merging credential lacks push access. */
  | "no-merge-permission";

export type PrMergeReadiness = { ready: true } | { ready: false; reason: PrNotReadyReason };

/** The first unmet condition, in the order a user would fix them. */
export function evaluatePrMergeReadiness(signals: PrMergeReadinessSignals): PrMergeReadiness {
  if (!signals.fresh) return { ready: false, reason: "stale" };
  if (!signals.prState) return { ready: false, reason: "no-pull-request" };
  if (signals.prState !== "open") return { ready: false, reason: "not-open" };
  if (signals.hasMergeConflicts === true) return { ready: false, reason: "conflicts" };
  // GitHub has not finished computing mergeability yet.
  if (signals.hasMergeConflicts !== false) return { ready: false, reason: "mergeability-unknown" };
  switch (signals.mergeability) {
    case "clean":
      break;
    case "dirty":
      return { ready: false, reason: "conflicts" };
    case "unavailable":
      return { ready: false, reason: "draft" };
    case "blocked":
      return { ready: false, reason: "blocked" };
    case "behind":
      return { ready: false, reason: "behind" };
    case "unstable":
      if (signals.requireChecks === false) break;
      return { ready: false, reason: "checks-not-passing" };
    default:
      return { ready: false, reason: "mergeability-unknown" };
  }
  const checks = signals.requireChecks === false ? null : signals.checkSummary;
  if (checks) {
    if (checks.passed + checks.pending < checks.total) {
      return { ready: false, reason: "checks-failing" };
    }
    if (checks.pending > 0) return { ready: false, reason: "checks-pending" };
  }
  // Last, so conflicts and failing checks still read as such for a viewer who
  // could not merge anyway.
  if (signals.viewerCanMerge === false) return { ready: false, reason: "no-merge-permission" };
  return { ready: true };
}

export function isPrReadyToMerge(signals: PrMergeReadinessSignals): boolean {
  return evaluatePrMergeReadiness(signals).ready;
}

/**
 * The monitor can only ask GitHub while it can run `gh`: a local worktree
 * always, a container only while it runs. A stopped container's reading is
 * whatever was true when it stopped.
 */
export function isPrMonitorPolled(
  environmentType: string | null | undefined,
  status: string | null | undefined,
): boolean {
  return environmentType === "local" || status === "running";
}

export interface PrMonitorConfirmationEnvironment {
  prUrl?: string | null;
  prState?: PrState | null;
  hasMergeConflicts?: boolean | null;
  environmentType?: string | null;
  status?: string | null;
}

/**
 * The monitor half of `fresh`: the monitor answered a check for this exact PR
 * in its current lifetime (a pause clears that), the latest check did not
 * fail, it agrees with the persisted reading, and it can still poll.
 *
 * The renderer adds its own mirror's sync state for this machine's rows. A
 * leaf evaluates it against its own monitor and relays the result to command
 * nodes as `prMonitorConfirmed`, so both apply one rule without comparing
 * clocks across machines.
 */
export function isPrReadingConfirmedByMonitor(
  environment: PrMonitorConfirmationEnvironment,
  monitor: PrMonitorEnvironmentState | null | undefined,
): boolean {
  return (
    monitor != null &&
    monitor.prUrl != null &&
    monitor.prUrl === (environment.prUrl ?? null) &&
    monitor.prState === (environment.prState ?? null) &&
    typeof environment.hasMergeConflicts === "boolean" &&
    monitor.hasMergeConflicts === environment.hasMergeConflicts &&
    monitor.consecutiveErrors === 0 &&
    monitor.lastSuccessfulCheckAt != null &&
    isPrMonitorPolled(environment.environmentType, environment.status)
  );
}

/** Shown in tooltips and announced to assistive technology. */
export const PR_READY_TO_MERGE_LABEL = "Ready to merge";

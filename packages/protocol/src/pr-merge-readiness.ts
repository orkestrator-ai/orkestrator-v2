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
 * - `fresh`: decided by the caller from the monitor's sync state, because only
 *   the caller knows whether its mirror is current.
 *
 * Not checked: whether the viewer may merge. The monitor's `gh` lookup does
 * not return the viewer's repository permission, and fetching it would add a
 * repository query to every poll. Orkestrator merges with the same credential
 * the monitor reads with, which in practice pushed the branch.
 */

import type { GitHubPullRequestMergeability } from "./github-pull-requests.js";
import type { PrCheckSummary, PrState } from "./pr-monitor.js";

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
  | "checks-pending";

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
      return { ready: false, reason: "checks-not-passing" };
    default:
      return { ready: false, reason: "mergeability-unknown" };
  }
  const checks = signals.checkSummary;
  if (checks) {
    if (checks.passed + checks.pending < checks.total) {
      return { ready: false, reason: "checks-failing" };
    }
    if (checks.pending > 0) return { ready: false, reason: "checks-pending" };
  }
  return { ready: true };
}

export function isPrReadyToMerge(signals: PrMergeReadinessSignals): boolean {
  return evaluatePrMergeReadiness(signals).ready;
}

/** Shown in tooltips and announced to assistive technology. */
export const PR_READY_TO_MERGE_LABEL = "Ready to merge";

import type { CSSProperties } from "react";
import type {
  GitHubPullRequestCheck,
  GitHubPullRequestChecksState,
  GitHubPullRequestDetail,
  GitHubPullRequestMergeMethod,
} from "@orkestrator/protocol/github-pull-requests";

export const MERGE_METHOD_LABELS: Record<GitHubPullRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_ORDER: GitHubPullRequestMergeMethod[] = ["squash", "merge", "rebase"];

/** The method the primary Merge button uses: the first allowed in GitHub's menu order. */
export function defaultMergeMethod(
  allowed: GitHubPullRequestMergeMethod[],
): GitHubPullRequestMergeMethod | null {
  return MERGE_METHOD_ORDER.find((method) => allowed.includes(method)) ?? null;
}

/**
 * Why the Merge button is disabled, or null when merging is allowed. The
 * order matters: state and permission come before mergeability.
 */
export function mergeBlockedReason(detail: GitHubPullRequestDetail): string | null {
  if (detail.state === "merged") return "This pull request is already merged.";
  if (detail.state === "closed") return "Closed pull requests can't be merged. Reopen it first.";
  if (detail.isDraft) return "Draft pull requests can't be merged. Mark it ready for review first.";
  if (!detail.viewerPermissions.canMerge) {
    return "You don't have permission to merge this pull request.";
  }
  if (detail.allowedMergeMethods.length === 0) {
    return "This repository doesn't allow any merge method.";
  }
  switch (detail.mergeability) {
    case "dirty":
      return "This branch has conflicts that must be resolved before merging.";
    case "behind":
      return "This branch is out of date with the base branch. Update it before merging.";
    case "blocked":
      return "Merging is blocked: required reviews or status checks are not satisfied.";
    case "unknown":
      return "GitHub is still checking whether this branch can be merged. Refresh in a moment.";
    case "unavailable":
      return "Merging isn't available for this pull request.";
    case "clean":
    case "unstable":
      return null;
  }
}

/** A non-blocking caution shown next to an enabled Merge button. */
export function mergeWarning(detail: GitHubPullRequestDetail): string | null {
  return detail.mergeability === "unstable"
    ? "Some checks are failing or still running. You can still merge."
    : null;
}

export type ChecksTally = {
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
  total: number;
};

export function tallyChecks(checks: GitHubPullRequestCheck[]): ChecksTally {
  const tally: ChecksTally = { passed: 0, failed: 0, pending: 0, skipped: 0, total: checks.length };
  for (const check of checks) {
    switch (check.conclusion) {
      case "success":
        tally.passed++;
        break;
      case "failure":
      case "timed-out":
      case "action-required":
      case "cancelled":
        tally.failed++;
        break;
      case "pending":
        tally.pending++;
        break;
      default:
        tally.skipped++;
    }
  }
  return tally;
}

export function checksSummaryLabel(
  checks: GitHubPullRequestCheck[],
  state: GitHubPullRequestChecksState,
): string {
  const tally = tallyChecks(checks);
  if (tally.total === 0) return state === "none" ? "No checks" : checksStateLabel(state);
  if (tally.failed > 0) return `${tally.failed} failing`;
  if (tally.pending > 0) return `${tally.pending} pending`;
  return "All checks passed";
}

export function checksStateLabel(state: GitHubPullRequestChecksState): string {
  switch (state) {
    case "success":
      return "Checks passed";
    case "failure":
      return "Checks failing";
    case "pending":
      return "Checks running";
    case "neutral":
      return "Checks neutral";
    case "none":
      return "No checks";
  }
}

/** True when an error message points at missing or rejected GitHub credentials. */
export function isCredentialError(message: string): boolean {
  return /token|credential|authenticat|not configured|unauthori[sz]ed|\b401\b/i.test(message);
}

export function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

/**
 * Inline styles for a GitHub label chip on the dark theme: a tinted fill and
 * border in the label colour, with readable text.
 */
export function labelChipStyle(color: string): CSSProperties | undefined {
  if (!/^[0-9a-f]{6}$/i.test(color)) return undefined;
  const red = Number.parseInt(color.slice(0, 2), 16);
  const green = Number.parseInt(color.slice(2, 4), 16);
  const blue = Number.parseInt(color.slice(4, 6), 16);
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return {
    backgroundColor: `#${color}2e`,
    borderColor: `#${color}66`,
    color: luminance < 0.35 ? undefined : `#${color}`,
  };
}

export function splitPath(path: string): { directory: string; filename: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { directory: "", filename: path }
    : { directory: path.slice(0, index), filename: path.slice(index + 1) };
}

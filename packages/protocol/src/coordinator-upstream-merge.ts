import type { ProjectGitStatus } from "./coordinator.js";

/**
 * The "merge upstream first?" question asked before a message to a project's
 * main coordinator. The backend decides whether to ask
 * (`check_coordinator_upstream_merge`) and remembers declines per project
 * (`decline_coordinator_upstream_merge`), so every client asks the same
 * question once; clients only show it. Browser-safe.
 */

/** Why a behind checkout cannot be fast-forwarded, or null when it can. */
export function behindFastForwardBlocker(
  status: ProjectGitStatus | null | undefined,
): string | null {
  if (!status) return null;
  if ((status.ahead ?? 0) > 0) {
    return `it also has ${status.ahead} local ${status.ahead === 1 ? "commit" : "commits"}, so the branches have diverged.`;
  }
  if (status.trackedChanges > 0 || status.untrackedChanges > 0) {
    return "it has uncommitted changes.";
  }
  return status.repositoryOperationBlockedReason;
}

/** The upstream tip a declined merge was answered for. */
export interface DeclinedUpstreamMerge {
  upstream: string;
  upstreamCommit: string;
}

/**
 * Whether sending to the main coordinator should first offer to merge the
 * upstream commits this checkout has not merged.
 *
 * Only when merging can actually happen: an upstream is configured, the
 * checkout is behind it, and nothing blocks a fast-forward. A decline is
 * remembered against the upstream tip it was given for, so the question comes
 * back as soon as a new upstream commit arrives. A status that does not report
 * the tip cannot be matched to a decline, so it always asks.
 */
export function shouldOfferUpstreamMerge(
  status: ProjectGitStatus | null | undefined,
  declined: DeclinedUpstreamMerge | null | undefined,
): boolean {
  if (!status?.upstream || (status.behind ?? 0) <= 0) return false;
  if (behindFastForwardBlocker(status)) return false;
  if (
    declined &&
    status.upstreamCommit &&
    declined.upstream === status.upstream &&
    declined.upstreamCommit === status.upstreamCommit
  ) {
    return false;
  }
  return true;
}

export const COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS = [
  /** A coordinator or project-home turn is running; the checkout cannot change under it. */
  "turn-running",
  /** No status could be read or fetched. */
  "no-status",
  /** No upstream, or nothing to merge. */
  "not-behind",
  /** Behind, but a fast-forward is blocked (local commits, changes, an operation). */
  "blocked",
  /** The user already declined this upstream tip. */
  "declined",
] as const;

export type CoordinatorUpstreamMergeSkipReason =
  (typeof COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS)[number];

/** The backend's answer to "ask before sending?". `status` is the refreshed checkout. */
export type CoordinatorUpstreamMergeCheck =
  | { offer: true; status: ProjectGitStatus }
  | { offer: false; reason: CoordinatorUpstreamMergeSkipReason; status: ProjectGitStatus | null };

/** The decision both the backend and an older-backend client apply. */
export function decideUpstreamMergeOffer(
  status: ProjectGitStatus | null | undefined,
  declined: DeclinedUpstreamMerge | null | undefined,
): CoordinatorUpstreamMergeCheck {
  if (!status) return { offer: false, reason: "no-status", status: null };
  if (shouldOfferUpstreamMerge(status, declined)) return { offer: true, status };
  if (!status.upstream || (status.behind ?? 0) <= 0) {
    return { offer: false, reason: "not-behind", status };
  }
  if (behindFastForwardBlocker(status)) return { offer: false, reason: "blocked", status };
  return { offer: false, reason: "declined", status };
}

export function parseCoordinatorUpstreamMergeCheck(
  value: unknown,
): CoordinatorUpstreamMergeCheck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const check = value as Record<string, unknown>;
  const status =
    check.status && typeof check.status === "object" && !Array.isArray(check.status)
      ? (check.status as ProjectGitStatus)
      : null;
  if (check.offer === true) return status ? { offer: true, status } : null;
  if (
    check.offer === false &&
    (COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS as readonly unknown[]).includes(check.reason)
  ) {
    return {
      offer: false,
      reason: check.reason as CoordinatorUpstreamMergeSkipReason,
      status,
    };
  }
  return null;
}

/** Bounds on a stored decline (an upstream ref and a commit id). */
export const UPSTREAM_DECLINE_LIMITS = Object.freeze({
  upstreamChars: 1024,
  commitChars: 128,
});

export function isDeclinedUpstreamMerge(value: unknown): value is DeclinedUpstreamMerge {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.upstream === "string" &&
    record.upstream.length > 0 &&
    record.upstream.length <= UPSTREAM_DECLINE_LIMITS.upstreamChars &&
    typeof record.upstreamCommit === "string" &&
    record.upstreamCommit.length > 0 &&
    record.upstreamCommit.length <= UPSTREAM_DECLINE_LIMITS.commitChars
  );
}

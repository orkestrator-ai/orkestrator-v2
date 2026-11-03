import type { ProjectGitStatus } from "./coordinator.js";

/**
 * Keeping a project's checkout on its upstream before a message to the main
 * coordinator. The backend decides (`check_coordinator_upstream_merge`):
 * whenever Git can fast-forward the checkout cleanly, it is fast-forwarded,
 * without asking. Nothing is merged under a running turn or into a checkout a
 * fast-forward would not apply to (local commits, uncommitted changes, an
 * unfinished operation). Browser-safe.
 *
 * Earlier releases asked first, remembered declines
 * (`decline_coordinator_upstream_merge`) and kept an "always merge" setting
 * (`get/set_coordinator_upstream_auto_merge`). The backend still answers those
 * commands for older clients, but neither changes the decision any more.
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

/** The upstream tip an older client declined to merge (kept for compatibility only). */
export interface DeclinedUpstreamMerge {
  upstream: string;
  upstreamCommit: string;
}

/**
 * Whether the checkout can be fast-forwarded to upstream commits it has not
 * merged: an upstream is configured, the checkout is behind it, and nothing
 * blocks a fast-forward.
 */
export function canFastForwardUpstream(status: ProjectGitStatus | null | undefined): boolean {
  if (!status?.upstream || (status.behind ?? 0) <= 0) return false;
  return behindFastForwardBlocker(status) === null;
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
  /** Only from backends that still honoured a stored decline. */
  "declined",
] as const;

export type CoordinatorUpstreamMergeSkipReason =
  (typeof COORDINATOR_UPSTREAM_MERGE_SKIP_REASONS)[number];

/**
 * The backend's answer to "merge before sending?". `status` is the refreshed
 * checkout. Current backends answer every offer `automatic`; the client
 * fast-forwards, then sends. An offer without `automatic` comes only from an
 * older backend, and current clients merge it all the same.
 */
export type CoordinatorUpstreamMergeCheck =
  | { offer: true; status: ProjectGitStatus; automatic?: true }
  | { offer: false; reason: CoordinatorUpstreamMergeSkipReason; status: ProjectGitStatus | null };

/** The decision both the backend and an older-backend client apply. */
export function decideUpstreamMergeOffer(
  status: ProjectGitStatus | null | undefined,
): CoordinatorUpstreamMergeCheck {
  if (!status) return { offer: false, reason: "no-status", status: null };
  if (canFastForwardUpstream(status)) return { offer: true, status, automatic: true };
  if (!status.upstream || (status.behind ?? 0) <= 0) {
    return { offer: false, reason: "not-behind", status };
  }
  return { offer: false, reason: "blocked", status };
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
  if (check.offer === true) {
    if (!status) return null;
    return check.automatic === true
      ? { offer: true, status, automatic: true }
      : { offer: true, status };
  }
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

/**
 * The retired "always merge" setting (`get/set_coordinator_upstream_auto_merge`),
 * still answered for older clients. It no longer changes anything.
 */
export interface CoordinatorUpstreamAutoMerge {
  enabled: boolean;
}

export function parseCoordinatorUpstreamAutoMerge(
  value: unknown,
): CoordinatorUpstreamAutoMerge | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const enabled = (value as Record<string, unknown>).enabled;
  return typeof enabled === "boolean" ? { enabled } : null;
}

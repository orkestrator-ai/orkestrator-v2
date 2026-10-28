import type { ProjectGitStatus } from "@orkestrator/protocol/coordinator";

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
 * back as soon as a new upstream commit arrives. A status from a backend that
 * does not report the tip cannot be matched to a decline, so it always asks.
 */
export function shouldOfferUpstreamMerge(
  status: ProjectGitStatus | null | undefined,
  declined: DeclinedUpstreamMerge | undefined,
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

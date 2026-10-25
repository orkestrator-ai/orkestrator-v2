import type { HydrationStatus } from "@/lib/bounded-hydration";
import type {
  WorktreeRemoteFetchFailure,
  WorktreeRemoteFreshness,
} from "@orkestrator/protocol/worktree-snapshots";

/**
 * What an event-led view tells the user while its data may be behind.
 *
 * Only failures specific to the view are described here. A transport outage
 * is one app-wide banner (`ConnectionStatusBanner`), and `hydrating` is never
 * shown: a safety check that answers `unchanged` must not flicker anything.
 * Texts never claim a new measurement: stale data keeps the time it was
 * observed.
 */
export interface FreshnessNotice {
  kind: "stale" | "degraded" | "unsupported" | "remote-stale" | "remote-unknown";
  /** Short label for an inline badge. */
  label: string;
  /** One or two sentences for a tooltip or strip. */
  detail: string;
}

/**
 * Notice for a bounded-hydration mirror (`syncStatus`), or null when current.
 *
 * `polled`: the view also re-reads on a short timer (the Files panel's 5 s
 * poll), so the mirror only speeds updates up. Its failure then delays
 * changes by at most one poll rather than freezing them, and a backend
 * without the snapshot command is the designed polling path, not a problem.
 */
export function hydrationFreshnessNotice(
  status: HydrationStatus,
  subject: string,
  options: { polled?: boolean } = {},
): FreshnessNotice | null {
  if (options.polled) {
    if (status !== "stale" && status !== "degraded") return null;
    return {
      kind: status,
      label: status === "stale" ? "Updates may be delayed" : "Updates delayed",
      detail: `Live change announcements for ${subject} ${status === "stale" ? "failed to refresh" : "keep failing to refresh"}, so changes appear on the next periodic re-read instead of at once.`,
    };
  }
  switch (status) {
    case "stale":
      return {
        kind: "stale",
        label: "May be out of date",
        detail: `The last refresh of ${subject} failed, so this shows the last state received. Retrying.`,
      };
    case "degraded":
      return {
        kind: "degraded",
        label: "Out of date",
        detail: `Refreshing ${subject} keeps failing, so this shows the last state received. It recovers on reconnect or the next check.`,
      };
    case "unsupported":
      return {
        kind: "unsupported",
        label: "Live updates only",
        detail: `This backend cannot send a ${subject} snapshot, so this follows live updates only and may miss changes made while disconnected.`,
      };
    default:
      return null;
  }
}

const REMOTE_FAILURE_TEXT: Record<WorktreeRemoteFetchFailure, string> = {
  auth: "the remote refused the credentials",
  network: "the remote could not be reached",
  "missing-ref": "the branch is missing on the remote",
  "no-remote": "the clone has no remote",
  timeout: "the fetch timed out",
  unavailable: "the container was unavailable",
  capacity: "too many fetches were already running",
  error: "the fetch failed",
};

/**
 * Formats an observation time as an absolute local time. Absolute on purpose:
 * a relative age would need a clock read during render and goes stale itself.
 */
export function formatObservedAt(value: string | undefined | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Notice for a container's remote-tracking baseline. `stale` means the diff is
 * exact against the refs the clone holds, which may be behind the remote; it
 * never means the list is unusable.
 */
export function remoteFreshnessNotice(
  remote: WorktreeRemoteFreshness | undefined,
  comparisonRef: string,
): FreshnessNotice | null {
  if (!remote) return null;
  if (remote.state === "stale") {
    const fetchedAt = formatObservedAt(remote.lastSuccessAt);
    const reason = remote.failure
      ? ` The last fetch did not complete: ${REMOTE_FAILURE_TEXT[remote.failure]}.`
      : "";
    return {
      kind: "remote-stale",
      label: "Base may be behind remote",
      detail: `Compared with ${comparisonRef} as this clone ${fetchedAt ? `last fetched it (${fetchedAt})` : "holds it"}. The changes are exact against that, but the remote may have moved since.${reason}`,
    };
  }
  if (remote.state === "unknown") {
    return {
      kind: "remote-unknown",
      label: "Base not fetched yet",
      detail: `No fetch of ${comparisonRef} has completed for this clone yet. The changes are exact against the clone's own refs.`,
    };
  }
  return null;
}

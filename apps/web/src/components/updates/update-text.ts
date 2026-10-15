import type { ReleaseChannel } from "@orkestrator/protocol/release-channels";
import type {
  UpdateJobPhase,
  UpdateNotice,
  UpdateRequester,
  UpdateStatusSnapshot,
} from "@orkestrator/protocol/updates";

export const CHANNEL_OPTIONS: Array<{ value: ReleaseChannel; label: string; description: string }> =
  [
    { value: "stable", label: "Stable", description: "Tested releases. Recommended." },
    {
      value: "beta",
      label: "Beta",
      description: "Upcoming releases a few weeks early, plus every stable release.",
    },
    {
      value: "unstable",
      label: "Unstable",
      description: "Nightly builds of main. Expect breakage; also receives beta and stable.",
    },
  ];

export function channelLabel(channel: ReleaseChannel | null | undefined): string {
  return CHANNEL_OPTIONS.find((option) => option.value === channel)?.label ?? "Development";
}

/**
 * Who asked for an update that did not come from this app's own window: the
 * Tailscale login when Tailscale Serve vouched for it, otherwise the name
 * the client declared (marked unverified), and the address it came from.
 * Null for this app's own requests.
 */
export function remoteRequesterLabel(requester: UpdateRequester): string | null {
  if (requester.listener !== "browser") return null;
  const who =
    requester.tailscaleUser ??
    (requester.client?.name ? `${requester.client.name} (unverified)` : "a remote client");
  return requester.remoteAddress ? `${who} from ${requester.remoteAddress}` : who;
}

export const PHASE_LABELS: Record<UpdateJobPhase, string> = {
  approved: "Starting",
  "fetching-dependencies": "Downloading provider binaries",
  downloading: "Downloading the update",
  ready: "Ready to install",
  installing: "Installing",
  restarting: "Restarting",
  verifying: "Checking the new version",
  succeeded: "Updated",
  failed: "Update failed",
  "rolled-back": "Rolled back",
  cancelled: "Cancelled",
};

export type UpdateIndicatorState =
  | { kind: "none" }
  | { kind: "available"; version: string }
  | { kind: "working"; label: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "attention"; label: string };

/** What the title-bar indicator shows; nothing at all when there is nothing to do. */
export function indicatorState(snapshot: UpdateStatusSnapshot | null): UpdateIndicatorState {
  if (!snapshot) return { kind: "none" };
  const job = snapshot.job;
  if (job && job.phase === "ready") return { kind: "ready", version: job.target.version };
  if (job && !["succeeded", "failed", "rolled-back", "cancelled"].includes(job.phase)) {
    return {
      kind: "working",
      label: PHASE_LABELS[job.phase],
      percent: job.progress?.percent ?? null,
    };
  }
  const attention = snapshot.notices.find((notice) => notice.kind !== "update-succeeded");
  if (attention) {
    return {
      kind: "attention",
      label:
        attention.kind === "action-needed-on-host"
          ? "Action needed after the update"
          : "Update failed",
    };
  }
  if (snapshot.available && snapshot.host.canInstall) {
    return { kind: "available", version: snapshot.available.version };
  }
  return { kind: "none" };
}

/** macOS permission ids an update asked someone at this machine to grant, by version. */
export function macOsPermissionsAddedByUpdates(
  notices: readonly UpdateNotice[],
): Map<string, string> {
  const added = new Map<string, string>();
  for (const notice of notices) {
    if (notice.kind !== "action-needed-on-host") continue;
    for (const item of notice.items) {
      if (item.category === "macos-permission") {
        added.set(item.id.slice("macos-permission:".length), notice.version);
      }
    }
  }
  return added;
}

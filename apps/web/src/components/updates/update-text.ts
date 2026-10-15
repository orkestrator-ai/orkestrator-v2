import type { ReleaseChannel } from "@orkestrator/protocol/release-channels";
import type { UpdateJobPhase, UpdateStatusSnapshot } from "@orkestrator/protocol/updates";

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

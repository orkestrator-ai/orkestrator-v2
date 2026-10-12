import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

import { invoke } from "@/lib/native/backend";

export type {
  DevProfileDiskUsage,
  DiskUsageEnvironmentSummary,
  DiskUsageItem,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

export async function listDiskUsageEnvironments(): Promise<DiskUsageEnvironmentSummary[]> {
  return invoke<DiskUsageEnvironmentSummary[]>("list_disk_usage_environments");
}

/** Sizes of an environment's worktree or container and its dev profiles; cached for minutes unless `refresh`. */
export async function getEnvironmentDiskUsage(
  environmentId: string,
  refresh = false,
): Promise<EnvironmentDiskUsage> {
  return invoke<EnvironmentDiskUsage>("get_environment_disk_usage", { environmentId, refresh });
}

export async function getWorktreeLocations(): Promise<WorktreeLocationsSnapshot> {
  return invoke<WorktreeLocationsSnapshot>("get_worktree_locations");
}

/** Replaces both settings; null clears one back to its default. */
export async function updateWorktreeLocations(locations: {
  environments: string | null;
  dev: string | null;
}): Promise<WorktreeLocationsSnapshot> {
  return invoke<WorktreeLocationsSnapshot>("update_worktree_locations", locations);
}

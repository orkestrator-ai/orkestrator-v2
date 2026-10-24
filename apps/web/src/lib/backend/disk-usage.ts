import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

import { machineInvoke, type AccountMachine } from "./agent-accounts";

export type {
  DevProfileDiskUsage,
  DiskUsageEnvironmentSummary,
  DiskUsageItem,
  EnvironmentDiskUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

export async function listDiskUsageEnvironments(
  machine?: AccountMachine,
): Promise<DiskUsageEnvironmentSummary[]> {
  return machineInvoke<DiskUsageEnvironmentSummary[]>(machine, "list_disk_usage_environments");
}

/** Sizes of an environment's worktree or container and its dev profiles; cached for minutes unless `refresh`. */
export async function getEnvironmentDiskUsage(
  environmentId: string,
  refresh = false,
  machine?: AccountMachine,
): Promise<EnvironmentDiskUsage> {
  return machineInvoke<EnvironmentDiskUsage>(machine, "get_environment_disk_usage", {
    environmentId,
    refresh,
  });
}

export async function getWorktreeLocations(
  machine?: AccountMachine,
): Promise<WorktreeLocationsSnapshot> {
  return machineInvoke<WorktreeLocationsSnapshot>(machine, "get_worktree_locations");
}

/** Replaces both settings; null clears one back to its default. */
export async function updateWorktreeLocations(
  locations: {
    environments: string | null;
    dev: string | null;
  },
  machine?: AccountMachine,
): Promise<WorktreeLocationsSnapshot> {
  return machineInvoke<WorktreeLocationsSnapshot>(machine, "update_worktree_locations", locations);
}

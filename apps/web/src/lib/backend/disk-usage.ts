import type {
  DiskUsageEnvironmentSummary,
  EnvironmentDiskUsage,
  ProjectGitMirrorUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

import { asSystemModel, systemApiOn } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import { commandBackendClient, type BackendClient } from "./client";

export type {
  DevProfileDiskUsage,
  DiskUsageEnvironmentSummary,
  DiskUsageItem,
  EnvironmentDiskUsage,
  ProjectGitMirrorUsage,
  WorktreeLocationsSnapshot,
} from "@orkestrator/protocol/disk-usage";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createDiskUsageApi(client: BackendClient) {
  /** `machine`'s `system` domain; the factory's own node when it is `undefined`. */
  const systemOn = (machine: AccountMachine) => systemApiOn(client, machine);

  /** Each project's Git mirror with its size, measured on each call. */
  async function listProjectGitMirrorUsage(
    machine?: AccountMachine,
  ): Promise<ProjectGitMirrorUsage[]> {
    return asSystemModel<ProjectGitMirrorUsage[]>(
      systemOn(machine).list_project_git_mirror_usage({}),
    );
  }

  async function listDiskUsageEnvironments(
    machine?: AccountMachine,
  ): Promise<DiskUsageEnvironmentSummary[]> {
    return asSystemModel<DiskUsageEnvironmentSummary[]>(
      systemOn(machine).list_disk_usage_environments({}),
    );
  }

  /** Sizes of an environment's worktree or container and its dev profiles; cached for minutes unless `refresh`. */
  async function getEnvironmentDiskUsage(
    environmentId: string,
    refresh = false,
    machine?: AccountMachine,
  ): Promise<EnvironmentDiskUsage> {
    return systemOn(machine).get_environment_disk_usage({ environmentId, refresh });
  }

  async function getWorktreeLocations(
    machine?: AccountMachine,
  ): Promise<WorktreeLocationsSnapshot> {
    return systemOn(machine).get_worktree_locations({});
  }

  /** Replaces both settings; null clears one back to its default. */
  async function updateWorktreeLocations(
    locations: {
      environments: string | null;
      dev: string | null;
    },
    machine?: AccountMachine,
  ): Promise<WorktreeLocationsSnapshot> {
    return systemOn(machine).update_worktree_locations(locations);
  }

  return {
    listProjectGitMirrorUsage,
    listDiskUsageEnvironments,
    getEnvironmentDiskUsage,
    getWorktreeLocations,
    updateWorktreeLocations,
  };
}

export type DiskUsageApi = ReturnType<typeof createDiskUsageApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  listProjectGitMirrorUsage,
  listDiskUsageEnvironments,
  getEnvironmentDiskUsage,
  getWorktreeLocations,
  updateWorktreeLocations,
} = createDiskUsageApi(commandBackendClient);

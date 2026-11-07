import {
  getEnvironmentDiskUsageCommand,
  getWorktreeLocationsCommand,
  listDiskUsageEnvironmentsCommand,
  listProjectGitMirrorUsageCommand,
  updateWorktreeLocationsCommand,
} from "@orkestrator/protocol/contract/domains/system";
import type { CommandRegistrar } from "./commands-registry-types.js";
import {
  getEnvironmentDiskUsage,
  listDiskUsageEnvironments,
  listProjectGitMirrorUsage,
} from "./disk-usage.js";
import { getWorktreeLocations, updateWorktreeLocations } from "./worktree-locations.js";

export function registerDiskUsageCommands(register: CommandRegistrar): void {
  register(listDiskUsageEnvironmentsCommand, (_args, context) =>
    listDiskUsageEnvironments(context),
  );
  register(listProjectGitMirrorUsageCommand, (_args, context) =>
    listProjectGitMirrorUsage(context),
  );
  register(getEnvironmentDiskUsageCommand, (args, context) => {
    if (args.refresh !== undefined && typeof args.refresh !== "boolean") {
      throw new Error("refresh must be a boolean");
    }
    return getEnvironmentDiskUsage(args.environmentId, context, {
      refresh: args.refresh === true,
    });
  });
  register(getWorktreeLocationsCommand, (_args, context) => getWorktreeLocations(context));
  register(updateWorktreeLocationsCommand, (args, context) =>
    updateWorktreeLocations(args, context),
  );
}

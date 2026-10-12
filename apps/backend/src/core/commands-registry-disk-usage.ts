import { assertOnlyKeys, asString } from "./commands-validation.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { getEnvironmentDiskUsage, listDiskUsageEnvironments } from "./disk-usage.js";
import { getWorktreeLocations, updateWorktreeLocations } from "./worktree-locations.js";

export function registerDiskUsageCommands(register: CommandRegistrar): void {
  register("list_disk_usage_environments", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return listDiskUsageEnvironments(context);
  });
  register("get_environment_disk_usage", (args, context) => {
    assertOnlyKeys(args, ["environmentId", "refresh"], "arguments");
    if (args.refresh !== undefined && typeof args.refresh !== "boolean") {
      throw new Error("refresh must be a boolean");
    }
    return getEnvironmentDiskUsage(asString(args.environmentId, "environmentId"), context, {
      refresh: args.refresh === true,
    });
  });
  register("get_worktree_locations", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return getWorktreeLocations(context);
  });
  register("update_worktree_locations", (args, context) => {
    assertOnlyKeys(args, ["environments", "dev"], "arguments");
    return updateWorktreeLocations(args, context);
  });
}

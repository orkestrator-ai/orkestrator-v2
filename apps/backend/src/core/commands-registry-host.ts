import { isHostUpdateChannel } from "@orkestrator/protocol/host-maintenance";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
import { assertOnlyKeys } from "./commands-validation.js";
import type { HostMaintenanceService } from "./host-maintenance.js";
import { startGhUpdate, startImageUpdate, startToolchainRepair } from "./host-maintenance-tasks.js";

function service(context: CommandContext): HostMaintenanceService {
  if (!context.hostMaintenance) throw new Error("Host maintenance is not available");
  return context.hostMaintenance;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/**
 * Remote-initiated maintenance of the host, for the renderer. The public API
 * (`host.*`) offers the same operations with request keys. The desktop
 * executor's progress reports are deliberately not commands: they arrive only
 * on the loopback control listener (`/__orkestrator/host-updater`).
 */
export function registerHostMaintenanceCommands(register: CommandRegistrar): void {
  register("get_host_maintenance", (args, context) => {
    assertOnlyKeys(args, ["detail"], "arguments");
    return args.detail === true ? service(context).detailedSnapshot() : service(context).snapshot();
  });
  register("get_host_restart_impact", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return service(context).impact();
  });
  register("request_host_update_check", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return service(context).requestCheck();
  });
  register("request_host_update", (args, context) => {
    assertOnlyKeys(args, ["version", "drain", "maxWaitSeconds"], "arguments");
    const version = optionalString(args.version, "version");
    if (args.drain !== undefined && args.drain !== "now" && args.drain !== "when-idle") {
      throw new Error("drain must be now or when-idle");
    }
    if (args.maxWaitSeconds !== undefined && typeof args.maxWaitSeconds !== "number") {
      throw new Error("maxWaitSeconds must be a number");
    }
    const maintenance = service(context);
    const job = maintenance.requestUpdate({
      requestedVersion: version ?? null,
      ...(args.drain ? { drain: args.drain } : {}),
      ...(typeof args.maxWaitSeconds === "number" ? { maxWaitSeconds: args.maxWaitSeconds } : {}),
    });
    return { job, snapshot: maintenance.snapshot() };
  });
  register("cancel_host_update", (args, context) => {
    assertOnlyKeys(args, ["jobId"], "arguments");
    const maintenance = service(context);
    const job = maintenance.cancelUpdate(optionalString(args.jobId, "jobId"));
    return { job, snapshot: maintenance.snapshot() };
  });
  register("start_host_toolchain_repair", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return startToolchainRepair(context);
  });
  register("start_host_image_update", (args, context) => {
    assertOnlyKeys(args, [], "arguments");
    return startImageUpdate(context);
  });
  register("set_host_update_channel", (args, context) => {
    assertOnlyKeys(args, ["channel"], "arguments");
    if (!isHostUpdateChannel(args.channel)) {
      throw new Error("channel must be stable, beta or unstable");
    }
    return service(context).setUpdateChannel(args.channel);
  });
  register("set_host_gh_channel", (args, context) => {
    assertOnlyKeys(args, ["channel"], "arguments");
    if (args.channel !== "pinned" && args.channel !== "latest") {
      throw new Error("channel must be pinned or latest");
    }
    return startGhUpdate(context, args.channel, { pinned: context.pinnedGitHubCli });
  });
}

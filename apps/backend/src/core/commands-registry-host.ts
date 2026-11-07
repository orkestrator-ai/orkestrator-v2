import {
  cancelHostUpdateCommand,
  getFleetUpdatePolicyCommand,
  getHostMaintenanceCommand,
  getHostRestartImpactCommand,
  requestHostUpdateCheckCommand,
  requestHostUpdateCommand,
  setFleetUpdatePolicyCommand,
  setHostGhChannelCommand,
  setHostUpdateChannelCommand,
  startHostImageUpdateCommand,
  startHostToolchainRepairCommand,
} from "@orkestrator/protocol/contract/domains/system";
import { isHostUpdateChannel } from "@orkestrator/protocol/host-maintenance";
import type { CommandContext } from "./commands-context.js";
import type { CommandRegistrar } from "./commands-registry-types.js";
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
function fleetUpdates(context: CommandContext) {
  if (!context.nodePortal) {
    throw new Error("The command-node portal is not available in this backend.");
  }
  return context.nodePortal.fleetUpdates;
}

export function registerHostMaintenanceCommands(register: CommandRegistrar): void {
  // The command node's opt-in "keep leaves on this node's version" policy
  // (plan item 5006), which asks leaves for updates through these same commands.
  register(getFleetUpdatePolicyCommand, (_args, context) => fleetUpdates(context).policy());
  register(setFleetUpdatePolicyCommand, (args, context) =>
    fleetUpdates(context).setChannel(args.channel, args.enabled),
  );
  register(getHostMaintenanceCommand, (args, context) => {
    return args.detail === true ? service(context).detailedSnapshot() : service(context).snapshot();
  });
  register(getHostRestartImpactCommand, (_args, context) => service(context).impact());
  register(requestHostUpdateCheckCommand, (_args, context) => service(context).requestCheck());
  register(requestHostUpdateCommand, (args, context) => {
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
  register(cancelHostUpdateCommand, (args, context) => {
    const maintenance = service(context);
    const job = maintenance.cancelUpdate(optionalString(args.jobId, "jobId"));
    return { job, snapshot: maintenance.snapshot() };
  });
  register(startHostToolchainRepairCommand, (_args, context) => startToolchainRepair(context));
  register(startHostImageUpdateCommand, (_args, context) => startImageUpdate(context));
  register(setHostUpdateChannelCommand, (args, context) => {
    if (!isHostUpdateChannel(args.channel)) {
      throw new Error("channel must be stable, beta or unstable");
    }
    return service(context).setUpdateChannel(args.channel);
  });
  register(setHostGhChannelCommand, (args, context) => {
    if (args.channel !== "pinned" && args.channel !== "latest") {
      throw new Error("channel must be pinned or latest");
    }
    return startGhUpdate(context, args.channel);
  });
}

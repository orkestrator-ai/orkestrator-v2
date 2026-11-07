import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateChannel,
  HostUpdateDrain,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";

import { backendClientOver, NO_ARGS } from "@/lib/node-scope/domains/invoke-over";
import { asSystemModel, systemApi } from "@/lib/node-scope/domains/system";

type MaintenanceInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** The host maintenance commands of one machine, sent through `call`. */
export interface HostMaintenanceClient {
  getHostMaintenance(detail?: boolean): Promise<HostMaintenanceSnapshot>;
  getHostRestartImpact(): Promise<HostRestartImpact | null>;
  requestHostUpdateCheck(): Promise<HostMaintenanceSnapshot>;
  requestHostUpdate(options?: {
    version?: string;
    drain?: HostUpdateDrain;
    maxWaitSeconds?: number;
  }): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }>;
  cancelHostUpdate(
    jobId?: string,
  ): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }>;
  startHostToolchainRepair(): Promise<HostTask>;
  startHostImageUpdate(): Promise<HostTask>;
  setHostUpdateChannel(channel: HostUpdateChannel): Promise<HostMaintenanceSnapshot>;
  setHostGhChannel(channel: "pinned" | "latest"): Promise<HostTask>;
}

/**
 * The same commands as above for any machine: `call` sends them to the
 * connected backend, the command node, or a node through the command node.
 * They go through the `system` domain client over `call` (plan item 7009),
 * which carries no negotiation, so each is today's call by name.
 */
export function hostMaintenanceClient(call: MaintenanceInvoke): HostMaintenanceClient {
  const system = () => systemApi(backendClientOver(call));
  return {
    getHostMaintenance: (detail = false) =>
      asSystemModel<HostMaintenanceSnapshot>(
        system().get_host_maintenance(detail ? { detail: true } : {}),
      ),
    getHostRestartImpact: () =>
      asSystemModel<HostRestartImpact | null>(system().get_host_restart_impact(NO_ARGS)),
    requestHostUpdateCheck: () =>
      asSystemModel<HostMaintenanceSnapshot>(system().request_host_update_check(NO_ARGS)),
    requestHostUpdate: (options = {}) =>
      asSystemModel<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }>(
        system().request_host_update({
          ...(options.version ? { version: options.version } : {}),
          ...(options.drain ? { drain: options.drain } : {}),
          ...(options.maxWaitSeconds ? { maxWaitSeconds: options.maxWaitSeconds } : {}),
        }),
      ),
    cancelHostUpdate: (jobId) =>
      asSystemModel<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }>(
        system().cancel_host_update(jobId ? { jobId } : {}),
      ),
    startHostToolchainRepair: () =>
      asSystemModel<HostTask>(system().start_host_toolchain_repair(NO_ARGS)),
    startHostImageUpdate: () => asSystemModel<HostTask>(system().start_host_image_update(NO_ARGS)),
    setHostUpdateChannel: (channel) =>
      asSystemModel<HostMaintenanceSnapshot>(system().set_host_update_channel({ channel })),
    setHostGhChannel: (channel) =>
      asSystemModel<HostTask>(system().set_host_gh_channel({ channel })),
  };
}

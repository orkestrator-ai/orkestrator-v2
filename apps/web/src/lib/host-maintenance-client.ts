import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateChannel,
  HostUpdateDrain,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";

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
 */
export function hostMaintenanceClient(call: MaintenanceInvoke): HostMaintenanceClient {
  return {
    getHostMaintenance: (detail = false) =>
      call<HostMaintenanceSnapshot>("get_host_maintenance", detail ? { detail: true } : {}),
    getHostRestartImpact: () => call<HostRestartImpact | null>("get_host_restart_impact"),
    requestHostUpdateCheck: () => call<HostMaintenanceSnapshot>("request_host_update_check"),
    requestHostUpdate: (options = {}) =>
      call("request_host_update", {
        ...(options.version ? { version: options.version } : {}),
        ...(options.drain ? { drain: options.drain } : {}),
        ...(options.maxWaitSeconds ? { maxWaitSeconds: options.maxWaitSeconds } : {}),
      }),
    cancelHostUpdate: (jobId) => call("cancel_host_update", jobId ? { jobId } : {}),
    startHostToolchainRepair: () => call<HostTask>("start_host_toolchain_repair"),
    startHostImageUpdate: () => call<HostTask>("start_host_image_update"),
    setHostUpdateChannel: (channel) =>
      call<HostMaintenanceSnapshot>("set_host_update_channel", { channel }),
    setHostGhChannel: (channel) => call<HostTask>("set_host_gh_channel", { channel }),
  };
}

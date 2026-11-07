import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateChannel,
  HostUpdateDrain,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import { type AccountMachine } from "./agent-accounts";
import { clientInvoke, commandBackendClient, machineInvoker, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createHostMaintenanceApi(client: BackendClient) {
  const invoke = clientInvoke(client);
  const machineInvoke = machineInvoker(client);

  /**
   * The connected backend's host: its version, its updater, any update job and
   * dependency task. `detail` adds live readings (restart impact, tools, image).
   */
  async function getHostMaintenance(
    detail = false,
    machine?: AccountMachine,
  ): Promise<HostMaintenanceSnapshot> {
    return machineInvoke<HostMaintenanceSnapshot>(
      machine,
      "get_host_maintenance",
      detail ? { detail: true } : {},
    );
  }

  /** What restarting the host would interrupt right now; null when it cannot be measured. */
  async function getHostRestartImpact(): Promise<HostRestartImpact | null> {
    return invoke<HostRestartImpact | null>("get_host_restart_impact");
  }

  /** Asks the host to check for an Orkestrator update; the answer arrives as an event. */
  async function requestHostUpdateCheck(): Promise<HostMaintenanceSnapshot> {
    return invoke<HostMaintenanceSnapshot>("request_host_update_check");
  }

  /** Starts installing an update on the host, which restarts after its countdown. */
  async function requestHostUpdate(
    options: { version?: string; drain?: HostUpdateDrain; maxWaitSeconds?: number } = {},
  ): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
    return invoke("request_host_update", {
      ...(options.version ? { version: options.version } : {}),
      ...(options.drain ? { drain: options.drain } : {}),
      ...(options.maxWaitSeconds ? { maxWaitSeconds: options.maxWaitSeconds } : {}),
    });
  }

  /** Cancels the host's update before it restarts. */
  async function cancelHostUpdate(
    jobId?: string,
  ): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
    return invoke("cancel_host_update", jobId ? { jobId } : {});
  }

  /** Reinstalls whatever of the host's pinned toolchain is missing or broken. */
  async function startHostToolchainRepair(): Promise<HostTask> {
    return invoke<HostTask>("start_host_toolchain_repair");
  }

  /** Pulls the release container image matching the backend. */
  async function startHostImageUpdate(machine?: AccountMachine): Promise<HostTask> {
    return machineInvoke<HostTask>(machine, "start_host_image_update");
  }

  /** Switches which Orkestrator releases the host updates to; the host checks again. */
  async function setHostUpdateChannel(
    channel: HostUpdateChannel,
  ): Promise<HostMaintenanceSnapshot> {
    return invoke<HostMaintenanceSnapshot>("set_host_update_channel", { channel });
  }

  /** Switches the host's gh between its pin and the newest upstream release. */
  async function setHostGhChannel(channel: "pinned" | "latest"): Promise<HostTask> {
    return invoke<HostTask>("set_host_gh_channel", { channel });
  }

  return {
    getHostMaintenance,
    getHostRestartImpact,
    requestHostUpdateCheck,
    requestHostUpdate,
    cancelHostUpdate,
    startHostToolchainRepair,
    startHostImageUpdate,
    setHostUpdateChannel,
    setHostGhChannel,
  };
}

export type HostMaintenanceApi = ReturnType<typeof createHostMaintenanceApi>;

/** The window's command-scope binding (the counted shim, plan item 3002). */
export const {
  getHostMaintenance,
  getHostRestartImpact,
  requestHostUpdateCheck,
  requestHostUpdate,
  cancelHostUpdate,
  startHostToolchainRepair,
  startHostImageUpdate,
  setHostUpdateChannel,
  setHostGhChannel,
} = createHostMaintenanceApi(commandBackendClient);

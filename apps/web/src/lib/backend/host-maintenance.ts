import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateChannel,
  HostUpdateDrain,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import { systemApi, systemApiOn } from "@/lib/node-scope/domains/system";
import { type AccountMachine } from "./agent-accounts";
import { commandBackendClient, type BackendClient } from "./client";

/**
 * This file's commands on `client`'s node (plan item 3002). A scoped store or
 * service passes its own node's client; the named exports below are this
 * over the window's command scope.
 */
export function createHostMaintenanceApi(client: BackendClient) {
  const system = () => systemApi(client);
  const systemOn = (machine: AccountMachine) => systemApiOn(client, machine);
  /** Today's call without an arguments object (the version-0 adapter sends exactly that). */
  const noArgs = undefined as never;

  /**
   * The connected backend's host: its version, its updater, any update job and
   * dependency task. `detail` adds live readings (restart impact, tools, image).
   */
  async function getHostMaintenance(
    detail = false,
    machine?: AccountMachine,
  ): Promise<HostMaintenanceSnapshot> {
    return systemOn(machine).get_host_maintenance(detail ? { detail: true } : {});
  }

  /** What restarting the host would interrupt right now; null when it cannot be measured. */
  async function getHostRestartImpact(): Promise<HostRestartImpact | null> {
    return system().get_host_restart_impact(noArgs);
  }

  /** Asks the host to check for an Orkestrator update; the answer arrives as an event. */
  async function requestHostUpdateCheck(): Promise<HostMaintenanceSnapshot> {
    return system().request_host_update_check(noArgs);
  }

  /** Starts installing an update on the host, which restarts after its countdown. */
  async function requestHostUpdate(
    options: { version?: string; drain?: HostUpdateDrain; maxWaitSeconds?: number } = {},
  ): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
    return system().request_host_update({
      ...(options.version ? { version: options.version } : {}),
      ...(options.drain ? { drain: options.drain } : {}),
      ...(options.maxWaitSeconds ? { maxWaitSeconds: options.maxWaitSeconds } : {}),
    });
  }

  /** Cancels the host's update before it restarts. */
  async function cancelHostUpdate(
    jobId?: string,
  ): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
    return system().cancel_host_update(jobId ? { jobId } : {});
  }

  /** Reinstalls whatever of the host's pinned toolchain is missing or broken. */
  async function startHostToolchainRepair(): Promise<HostTask> {
    return system().start_host_toolchain_repair(noArgs);
  }

  /** Pulls the release container image matching the backend. */
  async function startHostImageUpdate(machine?: AccountMachine): Promise<HostTask> {
    return systemOn(machine).start_host_image_update({});
  }

  /** Switches which Orkestrator releases the host updates to; the host checks again. */
  async function setHostUpdateChannel(
    channel: HostUpdateChannel,
  ): Promise<HostMaintenanceSnapshot> {
    return system().set_host_update_channel({ channel });
  }

  /** Switches the host's gh between its pin and the newest upstream release. */
  async function setHostGhChannel(channel: "pinned" | "latest"): Promise<HostTask> {
    return system().set_host_gh_channel({ channel });
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

import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
  HostTask,
  HostUpdateChannel,
  HostUpdateDrain,
  HostUpdateJob,
} from "@orkestrator/protocol/host-maintenance";
import { invoke } from "@/lib/native/backend";
import { machineInvoke, type AccountMachine } from "./agent-accounts";

/**
 * The connected backend's host: its version, its updater, any update job and
 * dependency task. `detail` adds live readings (restart impact, tools, image).
 */
export async function getHostMaintenance(
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
export async function getHostRestartImpact(): Promise<HostRestartImpact | null> {
  return invoke<HostRestartImpact | null>("get_host_restart_impact");
}

/** Asks the host to check for an Orkestrator update; the answer arrives as an event. */
export async function requestHostUpdateCheck(): Promise<HostMaintenanceSnapshot> {
  return invoke<HostMaintenanceSnapshot>("request_host_update_check");
}

/** Starts installing an update on the host, which restarts after its countdown. */
export async function requestHostUpdate(
  options: { version?: string; drain?: HostUpdateDrain; maxWaitSeconds?: number } = {},
): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
  return invoke("request_host_update", {
    ...(options.version ? { version: options.version } : {}),
    ...(options.drain ? { drain: options.drain } : {}),
    ...(options.maxWaitSeconds ? { maxWaitSeconds: options.maxWaitSeconds } : {}),
  });
}

/** Cancels the host's update before it restarts. */
export async function cancelHostUpdate(
  jobId?: string,
): Promise<{ job: HostUpdateJob; snapshot: HostMaintenanceSnapshot }> {
  return invoke("cancel_host_update", jobId ? { jobId } : {});
}

/** Reinstalls whatever of the host's pinned toolchain is missing or broken. */
export async function startHostToolchainRepair(): Promise<HostTask> {
  return invoke<HostTask>("start_host_toolchain_repair");
}

/** Pulls the release container image matching the backend. */
export async function startHostImageUpdate(machine?: AccountMachine): Promise<HostTask> {
  return machineInvoke<HostTask>(machine, "start_host_image_update");
}

/** Switches which Orkestrator releases the host updates to; the host checks again. */
export async function setHostUpdateChannel(
  channel: HostUpdateChannel,
): Promise<HostMaintenanceSnapshot> {
  return invoke<HostMaintenanceSnapshot>("set_host_update_channel", { channel });
}

/** Switches the host's gh between its pin and the newest upstream release. */
export async function setHostGhChannel(channel: "pinned" | "latest"): Promise<HostTask> {
  return invoke<HostTask>("set_host_gh_channel", { channel });
}

/**
 * The connected backend's host maintenance commands as a client, looked up
 * on every call so tests can spy on `@/lib/backend`. Not bundled: only tests
 * import this.
 */
import * as backend from "@/lib/backend";
import type { HostMaintenanceClient } from "@/lib/host-maintenance-client";

export const connectedHostClient: HostMaintenanceClient = {
  getHostMaintenance: (detail) => backend.getHostMaintenance(detail),
  getHostRestartImpact: () => backend.getHostRestartImpact(),
  requestHostUpdateCheck: () => backend.requestHostUpdateCheck(),
  requestHostUpdate: (options) => backend.requestHostUpdate(options),
  cancelHostUpdate: (jobId) => backend.cancelHostUpdate(jobId),
  startHostToolchainRepair: () => backend.startHostToolchainRepair(),
  startHostImageUpdate: () => backend.startHostImageUpdate(),
  setHostUpdateChannel: (channel) => backend.setHostUpdateChannel(channel),
  setHostGhChannel: (channel) => backend.setHostGhChannel(channel),
};

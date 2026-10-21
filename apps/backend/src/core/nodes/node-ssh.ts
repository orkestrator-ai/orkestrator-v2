import path from "node:path";
import process from "node:process";

import type { SshTunnelProvider } from "@orkestrator/protocol/node/node-link/routes";
import { createSshAdapterContext, SshTunnelSupervisor } from "@orkestrator/protocol/node/ssh";
import type { SshAskpassHandler } from "@orkestrator/protocol/node/ssh/askpass";

/**
 * SSH routes from the command node's backend use the host's OpenSSH with an
 * Orkestrator-owned known_hosts file. The desktop and its local backend share
 * the data directory, so host keys trusted before command nodes still apply.
 * Returns `undefined` where managed SSH routes are not supported.
 */
export function createNodeSshFactory(
  dataDir: string,
): ((prompt: SshAskpassHandler) => SshTunnelProvider | null) | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  const context = createSshAdapterContext({
    knownHostsFile: path.join(dataDir, "ssh", "known_hosts"),
    // The askpass helper runs under this process's own runtime.
    overrides: { askpassRuntime: { command: process.execPath, env: {} } },
  });
  return (prompt) => new SshTunnelSupervisor({ context, prompt });
}

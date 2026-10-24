import type { StateSignalCredential } from "./agent-tools.js";
import { claudeStateSignalConfig, containerImageCapabilitySupport } from "./claude-state-signal.js";
import {
  ensureContainerAgentToolsHost,
  ensureContainerHostServicePorts,
} from "./commands-environment.js";
import type { ContainerWorktreeSignalInstaller } from "./container-worktree-signal.js";
import { runCommand } from "./shell.js";

/**
 * Container side of the worktree signal (`container-worktree-signal=1`):
 * `orkestrator-worktree-signal start` reads the curl config from stdin, stops
 * any watcher a previous lineage started, and starts an inotify watcher in its
 * own session. The watcher rings `ready` once its watches are established,
 * which is what confirms the signal.
 */
export const WORKTREE_SIGNAL_SCRIPT_PATH = "/usr/local/bin/orkestrator-worktree-signal";
export const WORKTREE_SIGNAL_INSTALL_TIMEOUT_MS = 10_000;

export function worktreeSignalInstallCommand(
  containerId: string,
  credential: Pick<StateSignalCredential, "url" | "token">,
): {
  command: string;
  args: string[];
  options: { stdin: string; timeoutMs: number; redactValues: string[] };
} {
  return {
    command: "docker",
    // The node user, so the watcher reads exactly what the agent can write.
    args: ["exec", "-i", "--user", "node", containerId, WORKTREE_SIGNAL_SCRIPT_PATH, "start"],
    options: {
      // The same two-line curl config the Claude state signal writes.
      stdin: claudeStateSignalConfig(credential),
      timeoutMs: WORKTREE_SIGNAL_INSTALL_TIMEOUT_MS,
      redactValues: [credential.token],
    },
  };
}

export const containerWorktreeSignalInstaller: ContainerWorktreeSignalInstaller = {
  support: (containerId, context) =>
    containerImageCapabilitySupport(containerId, context, "container-worktree-signal", 1),
  async install(containerId, credential, context, isCurrent) {
    // The same host preparation a bridge start does: the host alias, and the
    // backend's current service port in a restricted container's firewall.
    await ensureContainerAgentToolsHost(containerId);
    await ensureContainerHostServicePorts(containerId, context.agentTools?.servicePort?.() ?? null);
    if (!isCurrent()) return;
    const { command, args, options } = worktreeSignalInstallCommand(containerId, credential);
    await runCommand(command, args, options);
  },
};

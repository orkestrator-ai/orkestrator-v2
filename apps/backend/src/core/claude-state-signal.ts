import type { ImageCapability } from "@orkestrator/protocol/image-manifest";
import type { StateSignalCredential } from "./agent-tools.js";
import type { CommandContext } from "./commands-context.js";
import {
  ensureContainerAgentToolsHost,
  ensureContainerHostServicePorts,
} from "./commands-environment.js";
import { findEnvironmentByContainerId } from "./commands-review.js";
import { currentRuntimeIdentity } from "./container-lifecycle-service.js";
import { readImageManifest } from "./docker-image.js";
import { runCommand } from "./shell.js";
import type { ClaudeStateSignalInstaller, ClaudeStateSignalSupport } from "./tmux-poll.js";

/**
 * Container side of the Claude terminal state signal (`claude-state-signal=2`).
 *
 * The hooks in `docker/entrypoint.sh` call `orkestrator-state-signal` to write
 * the state and its revision/completion snapshot. It POSTs with the curl
 * config written here, and the backend answers by reading the file. The config
 * is per poll lineage: a new poll (backend start, container start, a
 * replacement container) issues a new credential and overwrites it.
 */
export const CLAUDE_STATE_SIGNAL_CONFIG_PATH = "/tmp/.orkestrator-claude-state-signal";
export const CLAUDE_STATE_SIGNAL_SCRIPT_PATH = "/usr/local/bin/orkestrator-state-signal";
export const CLAUDE_STATE_SIGNAL_INSTALL_TIMEOUT_MS = 10_000;

/**
 * Writes the config from stdin, never from argv where `ps` would show the
 * token, then rings once. That ring is how the backend learns the whole path
 * (host alias, firewall, credential, script) works before it relies on it.
 */
const INSTALL_SCRIPT = `set -eu
umask 077
tmp="${CLAUDE_STATE_SIGNAL_CONFIG_PATH}.$$"
cat > "$tmp"
mv -f "$tmp" "${CLAUDE_STATE_SIGNAL_CONFIG_PATH}"
exec ${CLAUDE_STATE_SIGNAL_SCRIPT_PATH}`;

/** The curl config `orkestrator-state-signal` reads. */
export function claudeStateSignalConfig(
  credential: Pick<StateSignalCredential, "url" | "token">,
): string {
  return `url = "${credential.url}"\nheader = "Authorization: Bearer ${credential.token}"\n`;
}

export function claudeStateSignalInstallCommand(
  containerId: string,
  credential: Pick<StateSignalCredential, "url" | "token">,
): {
  command: string;
  args: string[];
  options: { stdin: string; timeoutMs: number; redactValues: string[] };
} {
  return {
    command: "docker",
    args: ["exec", "-i", containerId, "sh", "-c", INSTALL_SCRIPT],
    options: {
      stdin: claudeStateSignalConfig(credential),
      timeoutMs: CLAUDE_STATE_SIGNAL_INSTALL_TIMEOUT_MS,
      redactValues: [credential.token],
    },
  };
}

/**
 * Whether the container's image implements the signal. A legacy or invalid
 * manifest is a fixed answer for the container's life; an unreadable one is
 * not, so the poll asks again later.
 */
export async function claudeStateSignalSupport(
  containerId: string,
  context: Pick<CommandContext, "storage">,
  readManifest = readImageManifest,
): Promise<ClaudeStateSignalSupport> {
  return containerImageCapabilitySupport(
    containerId,
    context,
    "claude-state-signal",
    2,
    readManifest,
  );
}

/**
 * Whether the image of the container's current runtime declares `capability`
 * at `minimum` or later. Shared by the container change signals.
 */
export async function containerImageCapabilitySupport(
  containerId: string,
  context: Pick<CommandContext, "storage">,
  capability: ImageCapability,
  minimum: number,
  readManifest = readImageManifest,
): Promise<ClaudeStateSignalSupport> {
  const environment = findEnvironmentByContainerId(
    await context.storage.loadEnvironments(),
    containerId,
  );
  const imageId = environment ? currentRuntimeIdentity(environment, context)?.imageId : undefined;
  if (!imageId) return "unknown";
  const read = await readManifest(imageId, context);
  if (read.kind === "unavailable") return "unknown";
  return read.kind === "manifest" && (read.manifest.capabilities[capability] ?? 0) >= minimum
    ? "supported"
    : "unsupported";
}

export const claudeStateSignalInstaller: ClaudeStateSignalInstaller = {
  support: claudeStateSignalSupport,
  async install(containerId, credential, context, isCurrent) {
    // The same host preparation a bridge start does: the host alias, and the
    // backend's current service port in a restricted container's firewall.
    await ensureContainerAgentToolsHost(
      containerId,
      undefined,
      context.containerHostReachability?.containerHostAddress?.(),
    );
    await ensureContainerHostServicePorts(containerId, context.agentTools?.servicePort?.() ?? null);
    if (!isCurrent()) return;
    const { command, args, options } = claudeStateSignalInstallCommand(containerId, credential);
    await runCommand(command, args, options);
  },
};

/**
 * The doorbell installer the backend builds its Claude state polls with
 * (`index.ts`, `tmux.claudeStatePolls.signal`). Docker-backed, so unit tests
 * keep the plain poll unless they inject one.
 */
export function backendClaudeStateSignal(): ClaudeStateSignalInstaller | undefined {
  return process.env.NODE_ENV === "test" ? undefined : claudeStateSignalInstaller;
}

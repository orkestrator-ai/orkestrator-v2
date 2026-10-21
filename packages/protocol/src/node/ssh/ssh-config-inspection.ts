import type { SshAdapterContext, SshBinaries } from "./context.js";
import { runBoundedCommand } from "./process-runner.js";
import { buildConfigInspectionArgs, type ValidatedSshRoute } from "./ssh-command.js";
import { classifySshStderr, redactSshDiagnostic } from "./stderr-classification.js";
import { SshTunnelError } from "./tunnel-failures.js";

export const CONFIG_INSPECTION_TIMEOUT_MS = 10_000;
export const CONFIG_INSPECTION_MAX_STDOUT_BYTES = 256 * 1024;
const CONFIG_INSPECTION_MAX_STDERR_BYTES = 16 * 1024;

/**
 * The parts of `ssh -G` output the adapter needs. `user` is kept only to
 * redact it from diagnostics; it is never logged or exposed.
 */
export type SshEffectiveConfig = {
  hostname?: string;
  port?: number;
  user?: string;
  /** Effective user known_hosts files (empty when `none`). */
  userKnownHostsFiles: string[];
  localForwards: number;
  remoteForwards: number;
  dynamicForwards: number;
  usesProxyJump: boolean;
  controlMaster?: string;
  controlPath?: string;
  permitLocalCommand: boolean;
  hasLocalCommand: boolean;
};

export type SshConfigWarning = "permit-local-command";

export function parseSshConfigOutput(stdout: string): SshEffectiveConfig {
  const config: SshEffectiveConfig = {
    userKnownHostsFiles: [],
    localForwards: 0,
    remoteForwards: 0,
    dynamicForwards: 0,
    usesProxyJump: false,
    permitLocalCommand: false,
    hasLocalCommand: false,
  };
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const space = line.indexOf(" ");
    if (space <= 0) continue;
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1).trim();
    switch (key) {
      case "hostname":
        config.hostname = value;
        break;
      case "port": {
        const port = Number(value);
        if (Number.isSafeInteger(port) && port > 0 && port <= 65_535) config.port = port;
        break;
      }
      case "user":
        config.user = value;
        break;
      case "userknownhostsfile":
        config.userKnownHostsFiles = splitKnownHostsFiles(value);
        break;
      case "localforward":
        config.localForwards += 1;
        break;
      case "remoteforward":
        config.remoteForwards += 1;
        break;
      case "dynamicforward":
        config.dynamicForwards += 1;
        break;
      case "proxyjump":
        config.usesProxyJump = value !== "" && value.toLowerCase() !== "none";
        break;
      case "controlmaster":
        config.controlMaster = value;
        break;
      case "controlpath":
        config.controlPath = value;
        break;
      case "permitlocalcommand":
        config.permitLocalCommand = value.toLowerCase() === "yes";
        break;
      case "localcommand":
        config.hasLocalCommand = value !== "" && value.toLowerCase() !== "none";
        break;
    }
  }
  return config;
}

/**
 * `ssh -G` prints the known_hosts list unquoted, so a path containing a space
 * is ambiguous. Paths always start with `/` or `~`, so a token that does not
 * is treated as the continuation of the previous path.
 */
export function splitKnownHostsFiles(value: string): string[] {
  if (!value || value.toLowerCase() === "none") return [];
  const files: string[] = [];
  for (const token of value.split(/\s+/)) {
    if (!token) continue;
    const last = files.length - 1;
    if (last >= 0 && !token.startsWith("/") && !token.startsWith("~")) {
      files[last] = `${files[last]} ${token}`;
    } else {
      files.push(token);
    }
  }
  return files;
}

/**
 * SH-13 policy: a configuration that would silently open additional forwards
 * alongside Orkestrator's is refused, rather than cleared (ClearAllForwardings
 * would also remove the required `-L`).
 */
export function assertTunnelSafeConfig(config: SshEffectiveConfig): SshConfigWarning[] {
  const extra = config.localForwards + config.remoteForwards + config.dynamicForwards;
  if (extra > 0) throw SshTunnelError.of("config-extra-forwards");
  const warnings: SshConfigWarning[] = [];
  if (config.permitLocalCommand && config.hasLocalCommand) warnings.push("permit-local-command");
  return warnings;
}

export async function inspectSshConfig(
  context: SshAdapterContext,
  binaries: SshBinaries,
  route: ValidatedSshRoute,
  signal?: AbortSignal,
): Promise<SshEffectiveConfig> {
  const result = await runBoundedCommand(
    context,
    binaries.ssh,
    buildConfigInspectionArgs(route, context.configFile),
    {
      timeoutMs: CONFIG_INSPECTION_TIMEOUT_MS,
      maxStdoutBytes: CONFIG_INSPECTION_MAX_STDOUT_BYTES,
      maxStderrBytes: CONFIG_INSPECTION_MAX_STDERR_BYTES,
      ...(signal ? { signal } : {}),
    },
  );
  if (signal?.aborted) throw SshTunnelError.of("cancelled");
  if (result.spawnFailed) throw SshTunnelError.of("ssh-unavailable");
  if (result.timedOut || result.overflowed || result.exitCode !== 0) {
    const classified = classifySshStderr(result.stderr, { interactive: false });
    const line = classified?.line ?? firstLine(result.stderr);
    throw SshTunnelError.of("invalid-route", {
      message: "OpenSSH could not read the configuration for this destination.",
      ...(line ? { detail: redactSshDiagnostic(line, [context.homedir]) } : {}),
    });
  }
  return parseSshConfigOutput(result.stdout);
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { MAX_SSH_AGENT_SOCKET_PATH_CHARS } from "@orkestrator/protocol/ssh-agent-socket";

const execFileAsync = promisify(execFile);
const SSH_AGENT_CONNECT_TIMEOUT_MS = 1_000;

type SshAgentSocketSource = "configured" | "environment" | "session";

export type ResolvedSshAgentSocket = {
  path: string;
  source: SshAgentSocketSource;
};

function normalizedSocketPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_SSH_AGENT_SOCKET_PATH_CHARS ||
    candidate.includes("\0") ||
    !path.isAbsolute(candidate)
  ) {
    return undefined;
  }
  return candidate;
}

async function canConnectToSocket(candidate: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(candidate);
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(connected);
    };
    socket.setTimeout(SSH_AGENT_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

export async function isUsableOwnedSocket(
  candidate: string,
  dependencies: {
    canConnect?: (candidate: string) => Promise<boolean>;
    statPath?: (candidate: string) => Promise<{ isSocket(): boolean; uid: number }>;
    uid?: number;
  } = {},
): Promise<boolean> {
  // `stat` deliberately follows stable symlinks such as ~/.1password/agent.sock.
  // Ownership is checked on the socket target, not on the link that names it.
  const statPath = dependencies.statPath ?? stat;
  const stats = await statPath(candidate).catch(() => null);
  if (!stats?.isSocket()) return false;
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) return false;
  return (dependencies.canConnect ?? canConnectToSocket)(candidate);
}

async function commandOutput(command: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 256 * 1024,
    });
    const output = stdout.trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function valueFromSystemdEnvironment(
  output: string | undefined,
  variable: string,
): string | undefined {
  if (!output) return undefined;
  const prefix = `${variable}=`;
  const line = output.split("\n").find((entry) => entry.startsWith(prefix));
  return line?.slice(prefix.length);
}

export async function discoverSessionSshAgentSockets(
  platform: NodeJS.Platform,
  dependencies: {
    commandOutput?: (command: string, args: string[]) => Promise<string | undefined>;
    env?: NodeJS.ProcessEnv;
    uid?: number;
  } = {},
): Promise<string[]> {
  const run = dependencies.commandOutput ?? commandOutput;
  const env = dependencies.env ?? process.env;
  const uid = dependencies.uid ?? process.getuid?.();
  const candidates: Array<string | undefined> = [];
  if (platform === "linux") {
    const systemdEnvironment = await run("systemctl", ["--user", "show-environment"]);
    candidates.push(valueFromSystemdEnvironment(systemdEnvironment, "SSH_AUTH_SOCK"));

    // GNOME Keyring/GCR and systemd ssh-agent services use stable names under
    // the per-user runtime directory. Constructing these paths from the active
    // uid avoids both a username-specific setting and unsafe /tmp scanning.
    const runtimeDirectory =
      normalizedSocketPath(valueFromSystemdEnvironment(systemdEnvironment, "XDG_RUNTIME_DIR")) ??
      normalizedSocketPath(env.XDG_RUNTIME_DIR) ??
      (uid === undefined ? undefined : `/run/user/${uid}`);
    if (runtimeDirectory) {
      candidates.push(
        path.join(runtimeDirectory, "gcr", "ssh"),
        path.join(runtimeDirectory, "keyring", "ssh"),
        path.join(runtimeDirectory, "ssh-agent.socket"),
      );
    }
  } else if (platform === "darwin") {
    candidates.push(await run("launchctl", ["getenv", "SSH_AUTH_SOCK"]));
  } else {
    return [];
  }

  candidates.push(await run("gpgconf", ["--list-dirs", "agent-ssh-socket"]));
  return Array.from(new Set(candidates.filter((candidate): candidate is string => !!candidate)));
}

/**
 * Resolve one trusted, live SSH-agent socket without guessing usernames or
 * scanning attacker-writable temporary directories. A configured socket is an
 * explicit override; auto mode tries the inherited environment and then the
 * desktop session's own environment manager.
 */
export async function resolveSshAgentSocket(
  options: {
    configuredPath?: unknown;
    inheritedPath?: unknown;
    platform?: NodeJS.Platform;
  },
  dependencies: {
    isUsableSocket?: (candidate: string) => Promise<boolean>;
    discoverSessionSockets?: (
      platform: NodeJS.Platform,
    ) => Promise<string | readonly string[] | undefined>;
  } = {},
): Promise<ResolvedSshAgentSocket | null> {
  const isUsableSocket = dependencies.isUsableSocket ?? isUsableOwnedSocket;
  const configured = normalizedSocketPath(options.configuredPath);
  if (typeof options.configuredPath === "string" && options.configuredPath.trim() && !configured) {
    return null;
  }
  if (configured) {
    return (await isUsableSocket(configured)) ? { path: configured, source: "configured" } : null;
  }

  const inherited = normalizedSocketPath(options.inheritedPath);
  if (inherited && (await isUsableSocket(inherited))) {
    return { path: inherited, source: "environment" };
  }

  const discoverSessionSockets =
    dependencies.discoverSessionSockets ?? discoverSessionSshAgentSockets;
  const discovered = await discoverSessionSockets(options.platform ?? process.platform);
  const sessionCandidates = typeof discovered === "string" ? [discovered] : (discovered ?? []);
  for (const candidate of sessionCandidates) {
    const session = normalizedSocketPath(candidate);
    if (session && (await isUsableSocket(session))) {
      return { path: session, source: "session" };
    }
  }
  return null;
}

export async function readConfiguredSshAgentSocket(dataDir: string): Promise<string | undefined> {
  const config = await readFile(path.join(dataDir, "config.json"), "utf8")
    .then((contents) => JSON.parse(contents) as unknown)
    .catch(() => null);
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const global = (config as { global?: unknown }).global;
  if (!global || typeof global !== "object" || Array.isArray(global)) return undefined;
  return normalizedSocketPath((global as { sshAgentSocketPath?: unknown }).sshAgentSocketPath);
}

export async function configureSshAgentSocketEnvironment(
  options: {
    dataDir: string;
    runtimeFlavor: "production" | "development" | "agent-test";
    env?: NodeJS.ProcessEnv;
  },
  dependencies: {
    readConfiguredSocket?: (dataDir: string) => Promise<string | undefined>;
    resolveSocket?: typeof resolveSshAgentSocket;
  } = {},
): Promise<ResolvedSshAgentSocket | null> {
  const env = options.env ?? process.env;
  if (options.runtimeFlavor === "agent-test") {
    delete env.SSH_AUTH_SOCK;
    return null;
  }

  const readConfiguredSocket = dependencies.readConfiguredSocket ?? readConfiguredSshAgentSocket;
  const resolveSocket = dependencies.resolveSocket ?? resolveSshAgentSocket;
  const resolved = await resolveSocket({
    configuredPath: await readConfiguredSocket(options.dataDir),
    inheritedPath: env.SSH_AUTH_SOCK,
  });
  if (resolved) env.SSH_AUTH_SOCK = resolved.path;
  else delete env.SSH_AUTH_SOCK;
  return resolved;
}

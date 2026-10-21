import path from "node:path";
import type { SshAdapterContext, SshBinaries } from "./context.js";
import { runBoundedCommand } from "./process-runner.js";
import { buildHostKeyProbeArgs, type ValidatedSshRoute } from "./ssh-command.js";
import { classifySshStderr, redactSshDiagnostic } from "./stderr-classification.js";
import { createPrivateTempDir, nonInteractiveSshEnv } from "./ssh-env.js";
import { SshTunnelError } from "./tunnel-failures.js";

export const HOST_KEY_PROBE_TIMEOUT_MS = 15_000;
const PROBE_MAX_OUTPUT_BYTES = 16 * 1024;
const MAX_KNOWN_HOSTS_LINES = 8;
const MAX_KNOWN_HOSTS_LINE_LENGTH = 8 * 1024;

/**
 * One plain known_hosts entry: `<host pattern> <key type> <base64 key>`.
 * Markers (`@revoked`, `@cert-authority`), comments and trailing fields are
 * refused so trusting a probe can only ever add an ordinary host key.
 */
const KNOWN_HOSTS_LINE = /^[^\s@#]\S* [A-Za-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}$/;

export type HostKeyFingerprint = {
  /** e.g. `SHA256:...` */
  fingerprint: string;
  /** e.g. `ED25519` */
  keyType: string;
  bits: number;
};

export type HostKeyProbeResult = {
  /** Opaque ID the supervisor uses to accept only probes it issued. */
  probeId: string;
  routeId: string;
  destination: string;
  /** Host patterns exactly as OpenSSH looks them up, e.g. `[host]:2222`. */
  hostPatterns: string[];
  /** The exact known_hosts lines `trustHostKey` will append. */
  knownHostsLines: string[];
  fingerprints: HostKeyFingerprint[];
};

/**
 * Fetch the server's host key without sending any credential, so the user can
 * approve its fingerprint (SH-02). The key lands in a fresh private file; the
 * user's and Orkestrator's known_hosts are not touched.
 */
export async function probeHostKey(
  context: SshAdapterContext,
  binaries: SshBinaries,
  route: ValidatedSshRoute,
  signal?: AbortSignal,
): Promise<HostKeyProbeResult> {
  if (!binaries.sshKeygen) {
    throw SshTunnelError.of("ssh-unavailable", {
      message: "OpenSSH ssh-keygen was not found on this computer.",
    });
  }
  const dir = await createPrivateTempDir(context, "ork-ssh-probe-");
  try {
    const tempKnownHosts = path.join(dir, "known_hosts");
    const result = await runBoundedCommand(
      context,
      binaries.ssh,
      buildHostKeyProbeArgs(route, tempKnownHosts, context.configFile),
      {
        timeoutMs: HOST_KEY_PROBE_TIMEOUT_MS,
        maxStdoutBytes: PROBE_MAX_OUTPUT_BYTES,
        maxStderrBytes: PROBE_MAX_OUTPUT_BYTES,
        env: nonInteractiveSshEnv(context.env),
        ...(signal ? { signal } : {}),
      },
    );
    if (signal?.aborted) throw SshTunnelError.of("cancelled");
    if (result.spawnFailed) throw SshTunnelError.of("ssh-unavailable");
    const lines = parseKnownHostsLines(await readOptional(context, tempKnownHosts));
    if (lines.length === 0) {
      const classified = classifySshStderr(result.stderr, { interactive: false });
      const code =
        classified && classified.code !== "port-collision" && !classified.code.startsWith("auth")
          ? classified.code
          : "connect-failed";
      throw SshTunnelError.of(
        code,
        classified ? { detail: redactSshDiagnostic(classified.line, [context.homedir]) } : {},
      );
    }
    const fingerprints = await fingerprintKnownHosts(context, binaries.sshKeygen, tempKnownHosts);
    return {
      probeId: context.randomBytes(16).toString("hex"),
      routeId: route.routeId,
      destination: route.destination,
      hostPatterns: [...new Set(lines.map((line) => line.slice(0, line.indexOf(" "))))],
      knownHostsLines: lines,
      fingerprints,
    };
  } finally {
    await context.fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseKnownHostsLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (!line || line.startsWith("#")) continue;
    if (line.length > MAX_KNOWN_HOSTS_LINE_LENGTH || !KNOWN_HOSTS_LINE.test(line)) continue;
    if (!lines.includes(line)) lines.push(line);
    if (lines.length >= MAX_KNOWN_HOSTS_LINES) break;
  }
  return lines;
}

async function fingerprintKnownHosts(
  context: SshAdapterContext,
  sshKeygen: string,
  file: string,
): Promise<HostKeyFingerprint[]> {
  const result = await runBoundedCommand(context, sshKeygen, ["-l", "-E", "sha256", "-f", file], {
    timeoutMs: 5_000,
    maxStdoutBytes: PROBE_MAX_OUTPUT_BYTES,
    maxStderrBytes: PROBE_MAX_OUTPUT_BYTES,
    env: nonInteractiveSshEnv(context.env),
  });
  const fingerprints = parseFingerprintOutput(result.stdout);
  if (result.exitCode !== 0 || fingerprints.length === 0) {
    throw SshTunnelError.of("connect-failed", {
      message: "OpenSSH could not compute the host key fingerprint.",
    });
  }
  return fingerprints;
}

/** Parse `ssh-keygen -l -E sha256` lines: `256 SHA256:abc [host]:22 (ED25519)`. */
export function parseFingerprintOutput(stdout: string): HostKeyFingerprint[] {
  const fingerprints: HostKeyFingerprint[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const match = /^(\d+) (SHA256:[A-Za-z0-9+/=]+) .*\(([A-Za-z0-9-]+)\)$/.exec(raw.trim());
    if (!match) continue;
    fingerprints.push({ bits: Number(match[1]), fingerprint: match[2]!, keyType: match[3]! });
  }
  return fingerprints;
}

const writeQueues = new Map<string, Promise<unknown>>();

/**
 * Append exactly the probed lines to the Orkestrator-owned known_hosts file
 * (dir 0700, file 0600). The whole file is rewritten to a private temporary
 * file and renamed into place, so a crash never leaves a torn entry; lines
 * already present are not duplicated.
 */
export function trustHostKey(
  context: SshAdapterContext,
  probe: Pick<HostKeyProbeResult, "knownHostsLines">,
): Promise<{ added: number }> {
  const lines = probe.knownHostsLines;
  if (
    !Array.isArray(lines) ||
    lines.length === 0 ||
    lines.length > MAX_KNOWN_HOSTS_LINES ||
    parseKnownHostsLines(lines.join("\n")).length !== lines.length
  ) {
    return Promise.reject(
      SshTunnelError.of("invalid-route", { message: "The host key to trust is not valid." }),
    );
  }
  const file = context.knownHostsFile;
  const previous = writeQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => appendKnownHosts(context, file, lines));
  writeQueues.set(file, next);
  const cleanup = () => {
    if (writeQueues.get(file) === next) writeQueues.delete(file);
  };
  void next.then(cleanup, cleanup);
  return next;
}

async function appendKnownHosts(
  context: SshAdapterContext,
  file: string,
  lines: readonly string[],
): Promise<{ added: number }> {
  await ensureOwnedKnownHostsDir(context);
  const existingText = await readOptional(context, file);
  const existing = new Set(
    existingText
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter(Boolean),
  );
  const additions = lines.filter((line) => !existing.has(line));
  if (additions.length === 0) return { added: 0 };
  const prefix = existingText && !existingText.endsWith("\n") ? `${existingText}\n` : existingText;
  const temp = `${file}.tmp-${context.randomBytes(8).toString("hex")}`;
  try {
    await context.fs.writeFile(temp, `${prefix}${additions.join("\n")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await context.fs.rename(temp, file);
  } catch (error) {
    await context.fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await context.fs.chmod(file, 0o600);
  return { added: additions.length };
}

export async function ensureOwnedKnownHostsDir(context: SshAdapterContext): Promise<void> {
  const dir = path.dirname(context.knownHostsFile);
  await context.fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await context.fs.chmod(dir, 0o700);
}

async function readOptional(context: SshAdapterContext, file: string): Promise<string> {
  try {
    return await context.fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

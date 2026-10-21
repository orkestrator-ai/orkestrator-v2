/**
 * Disposable OpenSSH fixtures for the opt-in integration suites: non-root
 * sshd processes on 127.0.0.1 with their own host keys and authorized_keys,
 * and an explicit `ssh -F` client config, so nothing under ~/.ssh is read or
 * written. Only processes started here are ever signalled, by pid.
 */
import { test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import type { SshAskpassHandler } from "@orkestrator/protocol/node/ssh/askpass";
import {
  createSshAdapterContext,
  type SshAdapterContext,
} from "@orkestrator/protocol/node/ssh/context";
import { allocateLoopbackPort } from "@orkestrator/protocol/node/ssh/port-allocation";
import { SshTunnelError } from "@orkestrator/protocol/node/ssh/tunnel-failures";
import { SshTunnelSupervisor } from "@orkestrator/protocol/node/ssh/tunnel-supervisor";

function findBinary(name: string, candidates: string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export const SSHD = findBinary("sshd", ["/usr/sbin/sshd"]);
export const SSH = findBinary("ssh", ["/usr/bin/ssh"]);
export const SSH_KEYGEN = findBinary("ssh-keygen", ["/usr/bin/ssh-keygen"]);
export const SSH_INTEGRATION_ENABLED =
  process.env.ORKESTRATOR_SSH_INTEGRATION === "1" && Boolean(SSHD && SSH && SSH_KEYGEN);
/** `test`, skipped unless ORKESTRATOR_SSH_INTEGRATION=1 and OpenSSH is installed. */
export const realSshTest = test.skipIf(!SSH_INTEGRATION_ENABLED);
export const INTEGRATION_TIMEOUT_MS = 30_000;

export type RunningSshd = { name: string; pid: number; port: number; child: ChildProcess };

export type SpawnRecord = { pid: number | undefined; args: readonly string[] };

export type SshdOptions = { allowTcpForwarding?: boolean; port?: number };

export class SshFixture {
  readonly dir: string;
  readonly user = os.userInfo().username;
  readonly spawned: SpawnRecord[] = [];
  readonly #sshds = new Set<RunningSshd>();
  readonly #supervisors: SshTunnelSupervisor[] = [];

  constructor(prefix: string) {
    // A short /tmp directory keeps askpass socket paths under sun_path limits.
    this.dir = mkdtempSync(path.join("/tmp", prefix));
    writeFileSync(this.file("authorized_keys"), "", { mode: 0o600 });
  }

  file(name: string): string {
    return path.join(this.dir, name);
  }

  get knownHostsFile(): string {
    return this.file("userData/ssh/known_hosts");
  }

  get configFile(): string {
    return this.file("ssh_config");
  }

  /** Create an ed25519 key pair at `<dir>/<name>` (and `.pub`). */
  keygen(name: string, passphrase = ""): string {
    const file = this.file(name);
    execFileSync(SSH_KEYGEN!, ["-q", "-t", "ed25519", "-N", passphrase, "-f", file]);
    return file;
  }

  /** Create a client key and authorize it on every sshd of this fixture. */
  clientKey(name: string, passphrase = ""): string {
    const key = this.keygen(name, passphrase);
    writeFileSync(
      this.file("authorized_keys"),
      `${readFileSync(this.file("authorized_keys"), "utf8")}${readFileSync(`${key}.pub`, "utf8")}`,
      { mode: 0o600 },
    );
    return key;
  }

  fingerprintOf(publicKey: string): string {
    return execFileSync(SSH_KEYGEN!, ["-l", "-E", "sha256", "-f", publicKey], {
      encoding: "utf8",
    })
      .trim()
      .split(" ")[1]!;
  }

  /** A known_hosts line for a host key as OpenSSH looks up `[127.0.0.1]:port`. */
  knownHostsLine(hostKey: string, port: number): string {
    const [type, key] = readFileSync(`${hostKey}.pub`, "utf8").trim().split(/\s+/);
    return `[127.0.0.1]:${port} ${type} ${key}`;
  }

  async startSshd(name: string, hostKey: string, options: SshdOptions = {}): Promise<RunningSshd> {
    const port = options.port ?? (await allocateLoopbackPort());
    const config = this.file(`sshd_${name}`);
    writeFileSync(
      config,
      [
        "ListenAddress 127.0.0.1",
        `Port ${port}`,
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${this.file("authorized_keys")}`,
        `PidFile ${this.file(`sshd_${name}.pid`)}`,
        "UsePAM no",
        "StrictModes no",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        `AllowTcpForwarding ${options.allowTcpForwarding === false ? "no" : "yes"}`,
        "",
      ].join("\n"),
    );
    const child = spawn(SSHD!, ["-f", config, "-D", "-e"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let log = "";
      const timer = setTimeout(
        () => reject(new Error(`sshd ${name} did not start: ${log}`)),
        10_000,
      );
      child.stderr!.on("data", (chunk: Buffer) => {
        if (log.length < 16_384) log += chunk.toString();
        if (log.includes("Server listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sshd ${name} exited (${code}): ${log}`));
      });
    });
    const sshd = { name, pid: child.pid!, port, child };
    this.#sshds.add(sshd);
    return sshd;
  }

  async stopSshd(sshd: RunningSshd | undefined): Promise<void> {
    if (!sshd) return;
    this.#sshds.delete(sshd);
    if (sshd.child.exitCode !== null || sshd.child.signalCode !== null) return;
    const exited = new Promise((resolve) => sshd.child.once("exit", resolve));
    process.kill(sshd.pid, "SIGTERM");
    await exited;
  }

  writeClientConfig(hosts: Record<string, string[]>): void {
    const lines: string[] = [];
    for (const [alias, body] of Object.entries(hosts)) {
      lines.push(`Host ${alias}`, ...body.map((line) => `  ${line}`));
    }
    writeFileSync(this.configFile, `${lines.join("\n")}\n`);
  }

  /** Client config lines for a direct host on this fixture's loopback sshd. */
  hostBlock(port: number, identityFile: string, knownHosts = this.file("user_known_hosts")) {
    return [
      "HostName 127.0.0.1",
      `Port ${port}`,
      `User ${this.user}`,
      `IdentityFile ${identityFile}`,
      "IdentitiesOnly yes",
      "IdentityAgent none",
      `UserKnownHostsFile ${knownHosts}`,
      "GlobalKnownHostsFile /dev/null",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
    ];
  }

  context(options: { allocatePort?: () => Promise<number> } = {}): SshAdapterContext {
    const overrides: Partial<SshAdapterContext> = {
      tmpdir: this.dir,
      spawn: (command, args, spawnOptions) => {
        const child = spawn(command, [...args], spawnOptions);
        this.spawned.push({ pid: child.pid, args });
        return child;
      },
    };
    if (options.allocatePort) overrides.allocatePort = options.allocatePort;
    return createSshAdapterContext({
      knownHostsFile: this.knownHostsFile,
      configFile: this.configFile,
      overrides,
    });
  }

  supervisor(
    options: { allocatePort?: () => Promise<number>; prompt?: SshAskpassHandler } = {},
  ): SshTunnelSupervisor {
    const supervisor = new SshTunnelSupervisor({
      context: this.context(options),
      timings: { readyTimeoutMs: 10_000, terminateGraceMs: 2_000 },
      ...(options.prompt ? { prompt: options.prompt } : {}),
    });
    this.#supervisors.push(supervisor);
    return supervisor;
  }

  /** Tunnel children spawned since `since` (an index into `spawned`). */
  tunnelsSince(since: number): SpawnRecord[] {
    return this.spawned.slice(since).filter((item) => item.args.includes("-L"));
  }

  async cleanup(): Promise<void> {
    for (const supervisor of this.#supervisors) await supervisor.disposeAll();
    for (const sshd of Array.from(this.#sshds)) await this.stopSshd(sshd);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SshTunnelError) return error.code;
    throw error;
  }
  return "no-error";
}

/** A plain HTTP server standing in for a remote gateway. */
export async function startTextServer(
  body: string,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((_request, response) => response.end(body));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export async function getText(origin: string): Promise<string> {
  const response = await fetch(`${origin}/hello`, { signal: AbortSignal.timeout(5_000) });
  return `${response.status}:${await response.text()}`;
}

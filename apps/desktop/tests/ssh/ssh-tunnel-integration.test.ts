/**
 * Real OpenSSH integration: a disposable, non-root sshd on 127.0.0.1 with its
 * own host keys and authorized_keys, and an explicit `ssh -F` client config, so
 * nothing under ~/.ssh is read or written. Opt in with
 * ORKESTRATOR_SSH_INTEGRATION=1 (needs sshd, ssh and ssh-keygen).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createSshAdapterContext, type SshAdapterContext } from "../../electron/ssh/context";
import { allocateLoopbackPort } from "../../electron/ssh/port-allocation";
import { SshTunnelError } from "../../electron/ssh/tunnel-failures";
import { SshTunnelSupervisor } from "../../electron/ssh/tunnel-supervisor";

function findBinary(name: string, candidates: string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

const SSHD = findBinary("sshd", ["/usr/sbin/sshd"]);
const SSH = findBinary("ssh", ["/usr/bin/ssh"]);
const SSH_KEYGEN = findBinary("ssh-keygen", ["/usr/bin/ssh-keygen"]);
const ENABLED =
  process.env.ORKESTRATOR_SSH_INTEGRATION === "1" && Boolean(SSHD && SSH && SSH_KEYGEN);
const realTest = test.skipIf(!ENABLED);
const TIMEOUT = 30_000;
const PASSPHRASE = "integration passphrase";

type RunningSshd = { pid: number; port: number; child: ChildProcess };

let dir = "";
let gateway: Server;
let gatewayPort = 0;
let sshdA: RunningSshd;
let sshdNoForward: RunningSshd;
const spawned: Array<{ pid: number | undefined; args: readonly string[] }> = [];
const supervisors: SshTunnelSupervisor[] = [];

function keygen(file: string, passphrase = ""): void {
  execFileSync(SSH_KEYGEN!, ["-q", "-t", "ed25519", "-N", passphrase, "-f", file]);
}

function fingerprintOf(publicKey: string): string {
  return execFileSync(SSH_KEYGEN!, ["-l", "-E", "sha256", "-f", publicKey], { encoding: "utf8" })
    .trim()
    .split(" ")[1]!;
}

async function startSshd(name: string, hostKey: string, allowForwarding: boolean, port?: number) {
  const listenPort = port ?? (await allocateLoopbackPort());
  const config = path.join(dir, `sshd_${name}`);
  writeFileSync(
    config,
    [
      "ListenAddress 127.0.0.1",
      `Port ${listenPort}`,
      `HostKey ${hostKey}`,
      `AuthorizedKeysFile ${path.join(dir, "authorized_keys")}`,
      `PidFile ${path.join(dir, `sshd_${name}.pid`)}`,
      "UsePAM no",
      "StrictModes no",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      `AllowTcpForwarding ${allowForwarding ? "yes" : "no"}`,
      "",
    ].join("\n"),
  );
  const child = spawn(SSHD!, ["-f", config, "-D", "-e"], { stdio: ["ignore", "ignore", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`sshd did not start: ${log}`)), 10_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      if (log.length < 16_384) log += chunk.toString();
      if (log.includes("Server listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sshd exited (${code}): ${log}`));
    });
  });
  return { pid: child.pid!, port: listenPort, child };
}

async function stopSshd(sshd: RunningSshd | undefined): Promise<void> {
  if (!sshd || sshd.child.exitCode !== null || sshd.child.signalCode !== null) return;
  const exited = new Promise((resolve) => sshd.child.once("exit", resolve));
  process.kill(sshd.pid, "SIGTERM");
  await exited;
}

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeClientConfig(): string {
  const file = path.join(dir, "ssh_config");
  const user = os.userInfo().username;
  const common = (port: number, key: string) => [
    "  HostName 127.0.0.1",
    `  Port ${port}`,
    `  User ${user}`,
    `  IdentityFile ${key}`,
    "  IdentitiesOnly yes",
    "  IdentityAgent none",
    `  UserKnownHostsFile ${path.join(dir, "user_known_hosts")}`,
    "  GlobalKnownHostsFile /dev/null",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
  ];
  writeFileSync(
    file,
    [
      "Host ork-alias",
      ...common(sshdA.port, path.join(dir, "client_key")),
      "Host ork-passphrase",
      ...common(sshdA.port, path.join(dir, "client_key_pass")),
      "Host ork-noforward",
      ...common(sshdNoForward.port, path.join(dir, "client_key")),
      "",
    ].join("\n"),
  );
  return file;
}

function makeSupervisor(
  options: {
    allocatePort?: () => Promise<number>;
    prompt?: ConstructorParameters<typeof SshTunnelSupervisor>[0]["prompt"];
  } = {},
): SshTunnelSupervisor {
  const overrides: Partial<SshAdapterContext> = {
    tmpdir: dir,
    spawn: (command, args, spawnOptions) => {
      const child = spawn(command, [...args], spawnOptions);
      spawned.push({ pid: child.pid, args });
      return child;
    },
  };
  if (options.allocatePort) overrides.allocatePort = options.allocatePort;
  const context = createSshAdapterContext({
    knownHostsFile: path.join(dir, "userData", "ssh", "known_hosts"),
    configFile: path.join(dir, "ssh_config"),
    overrides,
  });
  const supervisor = new SshTunnelSupervisor({
    context,
    timings: { readyTimeoutMs: 10_000, terminateGraceMs: 2_000 },
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  supervisors.push(supervisor);
  return supervisor;
}

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SshTunnelError) return error.code;
    throw error;
  }
  return "no-error";
}

async function getText(origin: string): Promise<string> {
  const response = await fetch(`${origin}/hello`, { signal: AbortSignal.timeout(5_000) });
  return `${response.status}:${await response.text()}`;
}

const route = (routeId: string, destination: string, remoteGatewayPort = gatewayPort) => ({
  routeId,
  destination,
  remoteGatewayPort,
});

describe("OpenSSH tunnel integration", () => {
  beforeAll(async () => {
    if (!ENABLED) return;
    // A short directory keeps the askpass socket path under sun_path limits.
    dir = mkdtempSync(path.join("/tmp", "ork-ssh-it-"));
    keygen(path.join(dir, "host_key_a"));
    keygen(path.join(dir, "host_key_b"));
    keygen(path.join(dir, "client_key"));
    keygen(path.join(dir, "client_key_pass"), PASSPHRASE);
    writeFileSync(
      path.join(dir, "authorized_keys"),
      `${readFileSync(path.join(dir, "client_key.pub"), "utf8")}${readFileSync(path.join(dir, "client_key_pass.pub"), "utf8")}`,
      { mode: 0o600 },
    );
    gateway = createServer((_request, response) => response.end("gateway-ok"));
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    gatewayPort = (gateway.address() as net.AddressInfo).port;
    sshdA = await startSshd("a", path.join(dir, "host_key_a"), true);
    sshdNoForward = await startSshd("noforward", path.join(dir, "host_key_a"), false);
    writeClientConfig();
  }, TIMEOUT);

  afterAll(async () => {
    if (!ENABLED) return;
    for (const supervisor of supervisors) await supervisor.disposeAll();
    await stopSshd(sshdA);
    await stopSshd(sshdNoForward);
    await new Promise((resolve) => gateway?.close(resolve));
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, TIMEOUT);

  realTest(
    "SH-02: unknown host key is refused until the probed key is approved",
    async () => {
      const supervisor = makeSupervisor();
      expect(
        await failureCode(supervisor.acquire(route("a", "ork-alias"), { interactive: false })),
      ).toBe("host-key-unknown");
      const probe = await supervisor.probeHostKey(route("a", "ork-alias"));
      expect(probe.hostPatterns).toEqual([`[127.0.0.1]:${sshdA.port}`]);
      expect(probe.fingerprints.map((item) => item.fingerprint)).toEqual([
        fingerprintOf(path.join(dir, "host_key_a.pub")),
      ]);
      expect(await supervisor.trustHostKey(probe)).toEqual({ added: 1 });
      // The user's known_hosts was never written by the probe or the tunnel.
      expect(existsSync(path.join(dir, "user_known_hosts"))).toBe(false);
      const noForward = await supervisor.probeHostKey(route("nf", "ork-noforward"));
      await supervisor.trustHostKey(noForward);
    },
    TIMEOUT,
  );

  realTest(
    "SH-01: an alias with custom port, user and key works end to end",
    async () => {
      const supervisor = makeSupervisor();
      const before = spawned.length;
      const lease = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      expect(await getText(lease.localOrigin)).toBe("200:gateway-ok");
      const tunnel = spawned.slice(before).find((item) => item.args.includes("-L"))!;
      expect(tunnel.args).not.toContain("-p");
      expect(tunnel.args).not.toContain("-l");
      expect(tunnel.args).not.toContain("-i");
      expect(tunnel.args.slice(-2)).toEqual(["--", "ork-alias"]);
      lease.release();
      await supervisor.idle();
    },
    TIMEOUT,
  );

  realTest(
    "SH-10/SH-11: leases share one child; the last release stops only it",
    async () => {
      const supervisor = makeSupervisor();
      const before = spawned.length;
      const first = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      const second = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      const tunnels = spawned.slice(before).filter((item) => item.args.includes("-L"));
      expect(tunnels).toHaveLength(1);
      expect(second.localOrigin).toBe(first.localOrigin);
      first.release();
      await supervisor.idle();
      expect(await getText(second.localOrigin)).toBe("200:gateway-ok");
      expect(isAlive(tunnels[0]!.pid)).toBe(true);
      second.release();
      await supervisor.idle();
      expect(isAlive(tunnels[0]!.pid)).toBe(false);
      expect(isAlive(sshdA.pid)).toBe(true);
      // The remote side is unaffected and a fresh tunnel works.
      const third = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      expect(await getText(third.localOrigin)).toBe("200:gateway-ok");
      await supervisor.disposeAll();
      expect(isAlive(sshdA.pid)).toBe(true);
    },
    TIMEOUT,
  );

  realTest(
    "SH-05: a taken local port is retried, never connected to, and bounded",
    async () => {
      const blocker = net.createServer((socket) => socket.end("unrelated"));
      await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
      const busyPort = (blocker.address() as net.AddressInfo).port;
      try {
        let calls = 0;
        const supervisor = makeSupervisor({
          allocatePort: async () => (++calls === 1 ? busyPort : allocateLoopbackPort()),
        });
        const lease = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
        expect(lease.localPort).not.toBe(busyPort);
        expect(calls).toBe(2);
        expect(await getText(lease.localOrigin)).toBe("200:gateway-ok");
        lease.release();

        const exhausted = makeSupervisor({ allocatePort: async () => busyPort });
        expect(
          await failureCode(exhausted.acquire(route("a", "ork-alias"), { interactive: false })),
        ).toBe("port-collision-exhausted");
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    },
    TIMEOUT,
  );

  realTest(
    "SH-06: a closed remote gateway port gives a tunnel but no healthy gateway",
    async () => {
      const closedPort = await allocateLoopbackPort();
      const supervisor = makeSupervisor();
      const lease = await supervisor.acquire(route("closed", "ork-alias", closedPort), {
        interactive: false,
      });
      await expect(getText(lease.localOrigin)).rejects.toThrow();
      expect(lease.closed).toBe(false);
      lease.release();
    },
    TIMEOUT,
  );

  realTest(
    "SH-07: forwarding disabled by sshd is reported as forwarding-denied",
    async () => {
      const supervisor = makeSupervisor();
      expect(
        await failureCode(supervisor.acquire(route("nf", "ork-noforward"), { interactive: false })),
      ).toBe("forwarding-denied");
      expect(isAlive(sshdNoForward.pid)).toBe(true);
    },
    TIMEOUT,
  );

  realTest(
    "SH-03: a passphrase key prompts only when interactive",
    async () => {
      const prompts: string[] = [];
      const supervisor = makeSupervisor({
        prompt: async (prompt) => {
          prompts.push(prompt.kind);
          return PASSPHRASE;
        },
      });
      expect(
        await failureCode(supervisor.acquire(route("p", "ork-passphrase"), { interactive: false })),
      ).toBe("authentication-required");
      expect(prompts).toEqual([]);

      const lease = await supervisor.acquire(route("p", "ork-passphrase"), { interactive: true });
      expect(prompts).toEqual(["passphrase"]);
      expect(await getText(lease.localOrigin)).toBe("200:gateway-ok");
      lease.release();

      const cancelling = makeSupervisor({ prompt: async () => null });
      expect(
        await failureCode(cancelling.acquire(route("p", "ork-passphrase"), { interactive: true })),
      ).toBe("authentication-required");
      // Every askpass directory was removed.
      expect(
        execFileSync("/bin/ls", [dir], { encoding: "utf8" })
          .split("\n")
          .filter((name) => name.startsWith("ork-ssh-")),
      ).toEqual([]);
    },
    TIMEOUT,
  );

  realTest(
    "SH-02: a rotated host key is blocked as host-key-changed",
    async () => {
      await stopSshd(sshdA);
      sshdA = await startSshd("a", path.join(dir, "host_key_b"), true, sshdA.port);
      const supervisor = makeSupervisor();
      expect(
        await failureCode(supervisor.acquire(route("a", "ork-alias"), { interactive: false })),
      ).toBe("host-key-changed");
    },
    TIMEOUT,
  );
});

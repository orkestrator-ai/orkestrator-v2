/**
 * Real OpenSSH integration for the tunnel supervisor (SH-01/02/03/05/06/07/10/11).
 * Opt in with ORKESTRATOR_SSH_INTEGRATION=1 (needs sshd, ssh and ssh-keygen);
 * see sshd-harness.ts for the disposable sshd and client config.
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { readdirSync } from "node:fs";
import net from "node:net";
import { allocateLoopbackPort } from "@orkestrator/protocol/node/ssh/port-allocation";
import {
  INTEGRATION_TIMEOUT_MS as TIMEOUT,
  SSH_INTEGRATION_ENABLED,
  SshFixture,
  failureCode,
  getText,
  isAlive,
  realSshTest as realTest,
  startTextServer,
  type RunningSshd,
} from "./sshd-harness";

const PASSPHRASE = "integration passphrase";

let fx: SshFixture;
let gateway: Awaited<ReturnType<typeof startTextServer>>;
let sshdA: RunningSshd;
let sshdNoForward: RunningSshd;

const route = (routeId: string, destination: string, remoteGatewayPort = gateway.port) => ({
  routeId,
  destination,
  remoteGatewayPort,
});

describe("OpenSSH tunnel integration", () => {
  beforeAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    fx = new SshFixture("ork-ssh-it-");
    fx.keygen("host_key_a");
    fx.keygen("host_key_b");
    const clientKey = fx.clientKey("client_key");
    const passphraseKey = fx.clientKey("client_key_pass", PASSPHRASE);
    gateway = await startTextServer("gateway-ok");
    sshdA = await fx.startSshd("a", fx.file("host_key_a"));
    sshdNoForward = await fx.startSshd("noforward", fx.file("host_key_a"), {
      allowTcpForwarding: false,
    });
    fx.writeClientConfig({
      "ork-alias": fx.hostBlock(sshdA.port, clientKey),
      "ork-passphrase": fx.hostBlock(sshdA.port, passphraseKey),
      "ork-noforward": fx.hostBlock(sshdNoForward.port, clientKey),
    });
  }, TIMEOUT);

  afterAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    await fx.cleanup();
    await gateway?.close();
  }, TIMEOUT);

  realTest(
    "SH-02: unknown host key is refused until the probed key is approved",
    async () => {
      const supervisor = fx.supervisor();
      expect(
        await failureCode(supervisor.acquire(route("a", "ork-alias"), { interactive: false })),
      ).toBe("host-key-unknown");
      const probe = await supervisor.probeHostKey(route("a", "ork-alias"));
      expect(probe.hostPatterns).toEqual([`[127.0.0.1]:${sshdA.port}`]);
      expect(probe.fingerprints.map((item) => item.fingerprint)).toEqual([
        fx.fingerprintOf(fx.file("host_key_a.pub")),
      ]);
      expect(await supervisor.trustHostKey(probe)).toEqual({ added: 1 });
      // The user's known_hosts was never written by the probe or the tunnel.
      expect(readdirSync(fx.dir)).not.toContain("user_known_hosts");
      const noForward = await supervisor.probeHostKey(route("nf", "ork-noforward"));
      await supervisor.trustHostKey(noForward);
    },
    TIMEOUT,
  );

  realTest(
    "SH-01: an alias with custom port, user and key works end to end",
    async () => {
      const supervisor = fx.supervisor();
      const before = fx.spawned.length;
      const lease = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      expect(await getText(lease.localOrigin)).toBe("200:gateway-ok");
      const tunnel = fx.tunnelsSince(before)[0]!;
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
      const supervisor = fx.supervisor();
      const before = fx.spawned.length;
      const first = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      const second = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
      const tunnels = fx.tunnelsSince(before);
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
        const supervisor = fx.supervisor({
          allocatePort: async () => (++calls === 1 ? busyPort : allocateLoopbackPort()),
        });
        const lease = await supervisor.acquire(route("a", "ork-alias"), { interactive: false });
        expect(lease.localPort).not.toBe(busyPort);
        expect(calls).toBe(2);
        expect(await getText(lease.localOrigin)).toBe("200:gateway-ok");
        lease.release();

        const exhausted = fx.supervisor({ allocatePort: async () => busyPort });
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
      const supervisor = fx.supervisor();
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
      const supervisor = fx.supervisor();
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
      const supervisor = fx.supervisor({
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

      const cancelling = fx.supervisor({ prompt: async () => null });
      expect(
        await failureCode(cancelling.acquire(route("p", "ork-passphrase"), { interactive: true })),
      ).toBe("authentication-required");
      // Every askpass directory was removed.
      expect(readdirSync(fx.dir).filter((name) => name.startsWith("ork-ssh-"))).toEqual([]);
    },
    TIMEOUT,
  );

  realTest(
    "SH-02: a rotated host key is blocked as host-key-changed",
    async () => {
      await fx.stopSshd(sshdA);
      sshdA = await fx.startSshd("a", fx.file("host_key_b"), { port: sshdA.port });
      const supervisor = fx.supervisor();
      expect(
        await failureCode(supervisor.acquire(route("a", "ork-alias"), { interactive: false })),
      ).toBe("host-key-changed");
    },
    TIMEOUT,
  );
});

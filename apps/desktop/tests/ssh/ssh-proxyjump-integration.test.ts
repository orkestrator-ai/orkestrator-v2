/**
 * SH-04 with real OpenSSH: a tunnel to `target` through a disposable jump
 * sshd (`ProxyJump jump`). Opt in with ORKESTRATOR_SSH_INTEGRATION=1.
 *
 * How the two hops are verified: OpenSSH runs the jump hop as a separate
 * `ssh -W` process built from the client config (`-F` is passed on), but not
 * from the tunnel's command-line `-o` options. So the jump host key is checked
 * against the jump Host block's own UserKnownHostsFile/StrictHostKeyChecking,
 * never against Orkestrator's owned known_hosts, and the probe/trust flow can
 * only approve the final target's key. The jump key has to be trusted in the
 * user's own known_hosts for that jump host (here: `jump_known_hosts`, written
 * by the test from the jump sshd's public key).
 */
import { afterAll, beforeAll, describe, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  INTEGRATION_TIMEOUT_MS as TIMEOUT,
  SSH_INTEGRATION_ENABLED,
  SshFixture,
  failureCode,
  getText,
  realSshTest,
  startTextServer,
  type RunningSshd,
} from "./sshd-harness";

let fx: SshFixture;
let gateway: Awaited<ReturnType<typeof startTextServer>>;
let jump: RunningSshd;
let target: RunningSshd;

const route = (routeId: string, destination: string) => ({
  routeId,
  destination,
  remoteGatewayPort: gateway.port,
});

describe("OpenSSH ProxyJump integration (SH-04)", () => {
  beforeAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    fx = new SshFixture("ork-ssh-pj-");
    const jumpKey = fx.keygen("jump_host_key");
    const targetKey = fx.keygen("target_host_key");
    const clientKey = fx.clientKey("client_key");
    gateway = await startTextServer("gateway-via-jump");
    // The jump host must allow TCP forwarding: `ssh -W` is a forwarded channel.
    jump = await fx.startSshd("jump", jumpKey);
    target = await fx.startSshd("target", targetKey);
    writeFileSync(fx.file("jump_known_hosts"), `${fx.knownHostsLine(jumpKey, jump.port)}\n`);
    writeFileSync(fx.file("untrusted_known_hosts"), "");
    fx.writeClientConfig({
      jump: [
        ...fx.hostBlock(jump.port, clientKey, fx.file("jump_known_hosts")),
        "StrictHostKeyChecking yes",
      ],
      target: [...fx.hostBlock(target.port, clientKey), "ProxyJump jump"],
      "jump-untrusted": [
        ...fx.hostBlock(jump.port, clientKey, fx.file("untrusted_known_hosts")),
        "StrictHostKeyChecking yes",
      ],
      "target-untrusted-jump": [
        ...fx.hostBlock(target.port, clientKey),
        "ProxyJump jump-untrusted",
      ],
      // No StrictHostKeyChecking: OpenSSH's default `ask` on the jump hop.
      "jump-ask": fx.hostBlock(jump.port, clientKey, fx.file("ask_known_hosts")),
      "target-ask-jump": [...fx.hostBlock(target.port, clientKey), "ProxyJump jump-ask"],
    });
  }, TIMEOUT);

  afterAll(async () => {
    if (!SSH_INTEGRATION_ENABLED) return;
    await fx.cleanup();
    await gateway?.close();
  }, TIMEOUT);

  realSshTest(
    "a tunnel through a trusted jump host reaches the gateway",
    async () => {
      const supervisor = fx.supervisor();
      // The probe travels through the jump host and captures only the target's key.
      const probe = await supervisor.probeHostKey(route("t", "target"));
      expect(probe.hostPatterns).toEqual([`[127.0.0.1]:${target.port}`]);
      expect(probe.fingerprints.map((item) => item.fingerprint)).toEqual([
        fx.fingerprintOf(fx.file("target_host_key.pub")),
      ]);
      await supervisor.trustHostKey(probe);

      const before = fx.spawned.length;
      const lease = await supervisor.acquire(route("t", "target"), { interactive: false });
      expect(lease.usesProxyJump).toBe(true);
      expect(await getText(lease.localOrigin)).toBe("200:gateway-via-jump");
      const tunnel = fx.tunnelsSince(before)[0]!;
      expect(tunnel.args.slice(-2)).toEqual(["--", "target"]);
      expect(tunnel.args.some((arg) => /StrictHostKeyChecking=(no|off)/i.test(arg))).toBe(false);

      // Orkestrator's file holds only the target; the jump file is untouched.
      const owned = readFileSync(fx.knownHostsFile, "utf8");
      expect(owned).toContain(`[127.0.0.1]:${target.port} `);
      expect(owned).not.toContain(`[127.0.0.1]:${jump.port} `);
      expect(readFileSync(fx.file("jump_known_hosts"), "utf8").trim().split("\n")).toHaveLength(1);
      lease.release();
      await supervisor.idle();
    },
    TIMEOUT,
  );

  realSshTest(
    "an untrusted jump host key fails closed and cannot be approved by the probe",
    async () => {
      const supervisor = fx.supervisor();
      expect(
        await failureCode(
          supervisor.acquire(route("u", "target-untrusted-jump"), { interactive: false }),
        ),
      ).toBe("host-key-unknown");
      expect(await failureCode(supervisor.probeHostKey(route("u", "target-untrusted-jump")))).toBe(
        "host-key-unknown",
      );
      expect(readFileSync(fx.file("untrusted_known_hosts"), "utf8")).toBe("");
    },
    TIMEOUT,
  );

  realSshTest(
    "a jump hop with the default `ask` policy never prompts unattended and only asks when interactive",
    async () => {
      const prompts: Array<{ kind: string; message: string }> = [];
      const supervisor = fx.supervisor({
        prompt: async (prompt) => {
          prompts.push({ kind: prompt.kind, message: prompt.message });
          return null;
        },
      });
      expect(
        await failureCode(
          supervisor.acquire(route("a", "target-ask-jump"), { interactive: false }),
        ),
      ).toBe("host-key-unknown");
      expect(prompts).toEqual([]);

      // Interactive: the jump hop's host-key question reaches the native prompt
      // as a confirmation showing the fingerprint; declining fails closed.
      expect(
        await failureCode(supervisor.acquire(route("a", "target-ask-jump"), { interactive: true })),
      ).toBe("host-key-unknown");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]!.kind).toBe("confirm");
      expect(prompts[0]!.message).toContain(fx.fingerprintOf(fx.file("jump_host_key.pub")));
      expect(existsSync(fx.file("ask_known_hosts"))).toBe(false);
    },
    TIMEOUT,
  );
});

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import type { ForwardProbeResult } from "@orkestrator/protocol/node/ssh/port-allocation";
import {
  SshTunnelError,
  type SshTunnelFailure,
} from "@orkestrator/protocol/node/ssh/tunnel-failures";
import { SshTunnelSupervisor } from "@orkestrator/protocol/node/ssh/tunnel-supervisor";
import {
  authenticatedTunnel,
  createFakeHarness,
  FAST_TIMINGS,
  ROUTE,
  waitFor,
  type FakeChild,
  type FakeHarness,
} from "./fakes";

const harnesses: FakeHarness[] = [];
const supervisors: SshTunnelSupervisor[] = [];

function setup(
  options: Parameters<typeof createFakeHarness>[0] = {},
  prompt?: () => Promise<string | null>,
) {
  const harness = createFakeHarness(options);
  harnesses.push(harness);
  const supervisor = new SshTunnelSupervisor({
    context: harness.context,
    timings: FAST_TIMINGS,
    ...(prompt ? { prompt } : {}),
  });
  supervisors.push(supervisor);
  return { harness, supervisor };
}

afterEach(async () => {
  for (const supervisor of supervisors.splice(0)) await supervisor.disposeAll();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function rejection(promise: Promise<unknown>): Promise<SshTunnelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SshTunnelError);
    return error as SshTunnelError;
  }
  throw new Error("Expected the promise to reject.");
}

function failingTunnel(stderr: string, code = 255) {
  return (child: FakeChild) =>
    setImmediate(() => {
      child.writeStderr(stderr);
      setImmediate(() => child.exit(code));
    });
}

function option(child: FakeChild, name: string): string | undefined {
  const index = child.args.findIndex(
    (arg, i) => child.args[i - 1] === "-o" && arg.startsWith(`${name}=`),
  );
  return index < 0 ? undefined : child.args[index]!.slice(name.length + 1);
}

describe("SshTunnelSupervisor acquire", () => {
  test("returns a loopback lease once the forward is ready", async () => {
    const { harness, supervisor } = setup();
    const lease = await supervisor.acquire(ROUTE, { interactive: false });
    const [tunnel] = harness.tunnels();
    expect(lease.localOrigin).toBe(`http://127.0.0.1:${harness.allocatedPorts[0]}`);
    expect(lease.routeId).toBe("route-a");
    expect(tunnel!.command).toBe("/usr/bin/ssh");
    expect(tunnel!.args.slice(-2)).toEqual(["--", "build-machine"]);
    expect(option(tunnel!, "UserKnownHostsFile")).toBe(
      `"~/.ssh/known_hosts" "~/.ssh/known_hosts2" "${harness.knownHostsFile}"`,
    );
    expect(tunnel!.alive).toBe(true);
  });

  test("SH-12: rejects unsafe input before anything is spawned", async () => {
    const { harness, supervisor } = setup();
    const error = await rejection(
      supervisor.acquire({ ...ROUTE, destination: "-oProxyCommand=sh" }, { interactive: true }),
    );
    expect(error.code).toBe("invalid-route");
    expect(harness.children).toHaveLength(0);
  });

  test("SH-13: refuses a configuration with extra forwards without starting a tunnel", async () => {
    const { harness, supervisor } = setup({
      sshGOutput: "hostname h\nport 22\nlocalforward 9999 [localhost]:80\n",
    });
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("config-extra-forwards");
    expect(harness.children.map((child) => child.isConfigInspection)).toEqual([true]);
    expect(harness.tunnels()).toHaveLength(0);
  });

  test("reports ssh-unavailable, with an honest Windows message", async () => {
    const missing = setup({
      overrides: { locateBinaries: async () => ({ ok: false, reason: "not-found" }) },
    });
    expect((await rejection(missing.supervisor.acquire(ROUTE, { interactive: false }))).code).toBe(
      "ssh-unavailable",
    );
    const windows = setup({
      overrides: { locateBinaries: async () => ({ ok: false, reason: "unsupported-platform" }) },
    });
    const error = await rejection(windows.supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("ssh-unavailable");
    expect(error.message).toContain("Windows");
    expect(windows.harness.children).toHaveLength(0);
  });

  const startFailures: Array<[string, string, string]> = [
    [
      "host-key-unknown",
      "No ED25519 host key is known for [h]:22 and you have requested strict checking.\nHost key verification failed.\n",
      "host-key-unknown",
    ],
    [
      "host-key-changed",
      "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.\n",
      "host-key-changed",
    ],
    ["connect-failed", "ssh: Could not resolve hostname nowhere: not known\n", "connect-failed"],
    ["unrecognised exit", "something odd\n", "tunnel-exited"],
  ];
  for (const [name, stderr, code] of startFailures) {
    test(`classifies a start failure: ${name}`, async () => {
      const { supervisor } = setup({ onTunnel: failingTunnel(stderr) });
      const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
      expect(error.code).toBe(code as never);
      expect(error.message).not.toContain("alice");
    });
  }

  test("SH-07: a forward refused on the readiness probe is forwarding-denied", async () => {
    let tunnel: FakeChild | undefined;
    const { supervisor } = setup({
      onTunnel: (child) => {
        tunnel = child;
        authenticatedTunnel(child);
      },
      probe: async (): Promise<ForwardProbeResult> => {
        tunnel!.writeStderr("channel 1: open failed: administratively prohibited: open failed\n");
        return "closed";
      },
    });
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("forwarding-denied");
    expect(error.retryable).toBe(false);
    expect(tunnel!.signals).toContain("SIGTERM");
  });

  test("SH-06: a closed remote gateway port still yields a lease (no health claim)", async () => {
    let tunnel: FakeChild | undefined;
    const { supervisor } = setup({
      onTunnel: (child) => {
        tunnel = child;
        authenticatedTunnel(child);
      },
      probe: async (): Promise<ForwardProbeResult> => {
        tunnel!.writeStderr("channel 2: open failed: connect failed: Connection refused\n");
        return "closed";
      },
    });
    const lease = await supervisor.acquire(ROUTE, { interactive: false });
    expect(lease.closed).toBe(false);
  });

  test("does not probe the port until ssh reports authentication", async () => {
    let probes = 0;
    let tunnel: FakeChild | undefined;
    const { supervisor } = setup({
      onTunnel: (child) => {
        tunnel = child;
      },
      probe: async (): Promise<ForwardProbeResult> => {
        probes += 1;
        return "open";
      },
    });
    const pending = supervisor.acquire(ROUTE, { interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(probes).toBe(0);
    tunnel!.writeStderr('Authenticated to h ([1.2.3.4]:22) using "publickey".\n');
    await pending;
    expect(probes).toBe(1);
  });

  test("times out with a retryable connect failure and kills the child", async () => {
    const { harness, supervisor } = setup({ onTunnel: () => undefined });
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("connect-failed");
    expect(error.retryable).toBe(true);
    expect(harness.tunnels()[0]!.signals[0]).toBe("SIGTERM");
  });

  test("cancelling the only waiter aborts the start and kills the child", async () => {
    const { harness, supervisor } = setup({ onTunnel: () => undefined });
    const controller = new AbortController();
    const pending = supervisor.acquire(ROUTE, { interactive: false, signal: controller.signal });
    await waitFor(() => harness.tunnels().length === 1);
    controller.abort();
    expect((await rejection(pending)).code).toBe("cancelled");
    await waitFor(() => harness.tunnels()[0]!.signals.includes("SIGTERM"));
  });
});

describe("SH-05 local port collisions", () => {
  const collision =
    "bind [127.0.0.1]:51001: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 51001\nCould not request local forwarding.\n";

  test("retries with a fresh port after a lost bind race", async () => {
    let attempts = 0;
    const { harness, supervisor } = setup({
      onTunnel: (child) => {
        attempts += 1;
        if (attempts < 3) failingTunnel(`Authenticated to h\n${collision}`)(child);
        else authenticatedTunnel(child);
      },
    });
    const lease = await supervisor.acquire(ROUTE, { interactive: false });
    expect(harness.tunnels()).toHaveLength(3);
    expect(new Set(harness.allocatedPorts).size).toBe(3);
    expect(lease.localPort).toBe(harness.allocatedPorts[2]!);
  });

  test("gives up after the bounded number of attempts", async () => {
    const { harness, supervisor } = setup({ onTunnel: failingTunnel(collision) });
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("port-collision-exhausted");
    expect(harness.tunnels()).toHaveLength(FAST_TIMINGS.maxPortAttempts);
  });

  test("a ssh that exits after the probe connected is never reported ready", async () => {
    let tunnel: FakeChild | undefined;
    let attempts = 0;
    const { harness, supervisor } = setup({
      onTunnel: (child) => {
        attempts += 1;
        tunnel = child;
        authenticatedTunnel(child);
      },
      probe: async (): Promise<ForwardProbeResult> => {
        // An unrelated listener answered; ssh then loses the bind and exits.
        if (attempts === 1) {
          tunnel!.writeStderr(collision);
          tunnel!.exit(255);
        }
        return "open";
      },
    });
    await supervisor.acquire(ROUTE, { interactive: false });
    expect(harness.tunnels()).toHaveLength(2);
  });
});

describe("SH-10/SH-11 leases and cleanup", () => {
  test("leases for one route share a child; the last release kills only it", async () => {
    const { harness, supervisor } = setup();
    const [first, second] = await Promise.all([
      supervisor.acquire(ROUTE, { interactive: false }),
      supervisor.acquire(ROUTE, { interactive: false }),
    ]);
    const other = await supervisor.acquire(
      { ...ROUTE, routeId: "route-b" },
      { interactive: false },
    );
    const [routeA, routeB] = harness.tunnels();
    expect(harness.tunnels()).toHaveLength(2);
    expect(first!.localOrigin).toBe(second!.localOrigin);

    first!.release();
    first!.release();
    await supervisor.idle();
    expect(routeA!.signals).toEqual([]);

    second!.release();
    await supervisor.idle();
    expect(routeA!.signals).toEqual(["SIGTERM"]);
    expect(routeA!.alive).toBe(false);
    expect(routeB!.signals).toEqual([]);
    expect(other.closed).toBe(false);
  });

  test("a different spec for an open route is refused", async () => {
    const { supervisor } = setup();
    await supervisor.acquire(ROUTE, { interactive: false });
    const error = await rejection(
      supervisor.acquire({ ...ROUTE, remoteGatewayPort: 9 }, { interactive: false }),
    );
    expect(error.code).toBe("invalid-route");
  });

  test("disposeAll sends SIGTERM, then SIGKILL after the grace period, to owned pids only", async () => {
    const { harness, supervisor } = setup({
      onTunnel: (child) => {
        child.ignore.add("SIGTERM");
        authenticatedTunnel(child);
      },
    });
    const lease = await supervisor.acquire(ROUTE, { interactive: false });
    const reasons: SshTunnelFailure[] = [];
    lease.onClosed((reason) => reasons.push(reason));
    const started = Date.now();
    await supervisor.disposeAll();
    const [tunnel] = harness.tunnels();
    expect(tunnel!.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST_TIMINGS.terminateGraceMs - 5);
    // ssh -G finished on its own and was never signalled.
    expect(harness.children.filter((child) => child.isConfigInspection)[0]!.signals).toEqual([]);
    expect(reasons.map((reason) => reason.code)).toEqual(["cancelled"]);
    expect((await rejection(supervisor.acquire(ROUTE, { interactive: false }))).code).toBe(
      "cancelled",
    );
  });

  test("an unexpected exit notifies every listener once and does not restart", async () => {
    const { harness, supervisor } = setup();
    const a = await supervisor.acquire(ROUTE, { interactive: false });
    const b = await supervisor.acquire(ROUTE, { interactive: false });
    const seen: string[] = [];
    a.onClosed((reason) => seen.push(`a:${reason.code}:${reason.cause}:${reason.retryable}`));
    b.onClosed((reason) => seen.push(`b:${reason.code}:${reason.cause}`));
    const [tunnel] = harness.tunnels();
    tunnel!.writeStderr("Connection to 10.0.0.2 closed by remote host.\n");
    tunnel!.exit(255);
    await waitFor(() => seen.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen.sort()).toEqual([
      "a:tunnel-exited:connect-failed:true",
      "b:tunnel-exited:connect-failed",
    ]);
    expect(harness.tunnels()).toHaveLength(1);
    expect(a.closed).toBe(true);
    const late: string[] = [];
    a.onClosed((reason) => late.push(reason.code));
    await waitFor(() => late.length === 1);
    // A new acquire starts a fresh child.
    await supervisor.acquire(ROUTE, { interactive: false });
    expect(harness.tunnels()).toHaveLength(2);
  });

  test("SH-07: a later administratively-prohibited channel stops the tunnel with a typed reason", async () => {
    const { harness, supervisor } = setup();
    const lease = await supervisor.acquire(ROUTE, { interactive: false });
    const reasons: SshTunnelFailure[] = [];
    lease.onClosed((reason) => reasons.push(reason));
    harness
      .tunnels()[0]!
      .writeStderr("channel 3: open failed: administratively prohibited: open failed\n");
    await waitFor(() => reasons.length === 1);
    expect(reasons[0]!.code).toBe("forwarding-denied");
    expect(reasons[0]!.retryable).toBe(false);
    expect(harness.tunnels()[0]!.signals).toEqual(["SIGTERM"]);
  });

  test("a released lease hears nothing about a later exit", async () => {
    const { harness, supervisor } = setup();
    const a = await supervisor.acquire(ROUTE, { interactive: false });
    const b = await supervisor.acquire(ROUTE, { interactive: false });
    const heard: string[] = [];
    a.onClosed(() => heard.push("a"));
    b.onClosed(() => heard.push("b"));
    a.release();
    harness.tunnels()[0]!.exit(255);
    await waitFor(() => heard.length === 1);
    expect(heard).toEqual(["b"]);
  });
});

describe("SH-03 interactivity", () => {
  test("unattended attempts never create an askpass broker and cannot prompt", async () => {
    let prompts = 0;
    const { harness, supervisor } = setup(
      { onTunnel: failingTunnel("alice@h: Permission denied (publickey).\n") },
      async () => {
        prompts += 1;
        return "secret";
      },
    );
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: false }));
    expect(error.code).toBe("authentication-required");
    expect(error.retryable).toBe(false);
    expect(error.detail).not.toContain("alice");
    const [tunnel] = harness.tunnels();
    expect(option(tunnel!, "BatchMode")).toBe("yes");
    expect(tunnel!.env.SSH_ASKPASS).toBeUndefined();
    expect(tunnel!.env.SSH_ASKPASS_REQUIRE).toBe("never");
    expect(tunnel!.env.ORKESTRATOR_ASKPASS_NONCE).toBeUndefined();
    expect(readdirSync(harness.tmpdir).filter((name) => name.startsWith("ork-ssh-"))).toEqual([]);
    expect(prompts).toBe(0);
  });

  test("interactive attempts get a private broker that is removed afterwards", async () => {
    let brokerDirExisted = false;
    const { harness, supervisor } = setup(
      {
        onTunnel: (child) => {
          brokerDirExisted = readdirSync(harness.tmpdir).some((name) =>
            name.startsWith("ork-ssh-"),
          );
          failingTunnel("alice@h: Permission denied (publickey).\n")(child);
        },
      },
      async () => null,
    );
    const error = await rejection(supervisor.acquire(ROUTE, { interactive: true }));
    expect(error.code).toBe("authentication-failed");
    const [tunnel] = harness.tunnels();
    expect(option(tunnel!, "BatchMode")).toBe("no");
    expect(tunnel!.env.SSH_ASKPASS).toEndWith("/askpass.sh");
    expect(tunnel!.env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(tunnel!.env.DISPLAY).toBe(":0");
    expect(tunnel!.env.ORKESTRATOR_ASKPASS_NONCE).toMatch(/^[0-9a-f]{64}$/);
    expect(brokerDirExisted).toBe(true);
    expect(readdirSync(harness.tmpdir).filter((name) => name.startsWith("ork-ssh-"))).toEqual([]);
  });

  test("interactive without a prompt handler falls back to BatchMode", async () => {
    const { harness, supervisor } = setup();
    await supervisor.acquire(ROUTE, { interactive: true });
    expect(option(harness.tunnels()[0]!, "BatchMode")).toBe("yes");
  });
});

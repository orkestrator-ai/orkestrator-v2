import { describe, expect, test } from "bun:test";
import {
  CONTAINER_HOST_REACHABILITY_CHANGED_EVENT,
  containerHostReachabilityNeedsAttention,
  type ContainerHostReachability,
} from "@orkestrator/protocol/container-host-reachability";
import {
  CONTAINER_HOST_PROBE_IMAGE,
  ContainerAgentToolsUnreachableError,
  ContainerHostReachabilityService,
  buildContainerHostRemediation,
  classifyProbeOutput,
  coveringCidrs,
  type ContainerHostReachabilityDependencies,
} from "./container-host-reachability.js";
import { CommandFailedError } from "./shell.js";

// Captured from real probes (busybox 1.37 wget and the environment image's curl).
const BUSYBOX_TIMEOUT =
  "ORK_PROBE_TOOL=wget\nConnecting to host.docker.internal:38179 (172.17.0.1:38179)\nwget: download timed out\nORK_PROBE_RC=1\n";
const BUSYBOX_HTTP_405 =
  "ORK_PROBE_TOOL=wget\nConnecting to host.docker.internal:38179 (172.17.0.1:38179)\nwget: server returned error: HTTP/1.1 405 Method Not Allowed\nORK_PROBE_RC=1\n";
const BUSYBOX_REFUSED =
  "ORK_PROBE_TOOL=wget\nwget: can't connect to remote host (172.17.0.2): Connection refused\nORK_PROBE_RC=1\n";
const BUSYBOX_DNS =
  "ORK_PROBE_TOOL=wget\nwget: bad address 'host.docker.internal:9'\nORK_PROBE_RC=1\n";
const CURL_TIMEOUT =
  "ORK_PROBE_TOOL=curl\ncurl: (28) Connection timed out after 5002 milliseconds\nORK_PROBE_HTTP=000\nORK_PROBE_RC=28\n";
const CURL_HTTP_405 = "ORK_PROBE_TOOL=curl\nORK_PROBE_HTTP=405\nORK_PROBE_RC=0\n";
const CURL_REFUSED =
  "ORK_PROBE_TOOL=curl\ncurl: (7) Failed to connect to 172.17.0.3 port 9 after 0 ms: Could not connect to server\nORK_PROBE_HTTP=000\nORK_PROBE_RC=7\n";
const CURL_DNS =
  "ORK_PROBE_TOOL=curl\ncurl: (6) Could not resolve host: nosuchhost.invalid\nORK_PROBE_HTTP=000\nORK_PROBE_RC=6\n";

describe("classifyProbeOutput", () => {
  test("any HTTP status proves the path, from busybox wget and curl", () => {
    expect(classifyProbeOutput(BUSYBOX_HTTP_405)).toMatchObject({
      outcome: "reachable",
      httpStatus: 405,
    });
    expect(classifyProbeOutput(CURL_HTTP_405)).toMatchObject({
      outcome: "reachable",
      httpStatus: 405,
    });
    expect(
      classifyProbeOutput(
        "ORK_PROBE_TOOL=wget\nHTTP request sent, awaiting response... 405 Method Not Allowed\nORK_PROBE_RC=8\n",
      ),
    ).toMatchObject({ outcome: "reachable", httpStatus: 405 });
  });

  test("a dropped connection is a timeout", () => {
    expect(classifyProbeOutput(BUSYBOX_TIMEOUT)).toMatchObject({
      outcome: "timeout",
      detail: expect.stringContaining("download timed out"),
    });
    expect(classifyProbeOutput(CURL_TIMEOUT).outcome).toBe("timeout");
  });

  test("refusals, routing and DNS failures are told apart", () => {
    expect(classifyProbeOutput(BUSYBOX_REFUSED).outcome).toBe("refused");
    expect(classifyProbeOutput(CURL_REFUSED).outcome).toBe("refused");
    expect(
      classifyProbeOutput(
        "ORK_PROBE_TOOL=wget\nwget: can't connect to remote host (172.17.0.1): No route to host\nORK_PROBE_RC=1\n",
      ).outcome,
    ).toBe("unreachable");
    expect(classifyProbeOutput(BUSYBOX_DNS).outcome).toBe("dns");
    expect(classifyProbeOutput(CURL_DNS).outcome).toBe("dns");
  });

  test("a probe that could not run proves nothing", () => {
    expect(classifyProbeOutput("ORK_PROBE_TOOL=none\nORK_PROBE_RC=127\n")).toMatchObject({
      outcome: "error",
      detail: "neither curl nor wget is installed",
    });
    expect(classifyProbeOutput("").outcome).toBe("error");
    expect(classifyProbeOutput("sh: exec format error").outcome).toBe("error");
  });

  test("detail is bounded and drops the markers", () => {
    const detail = classifyProbeOutput(
      `ORK_PROBE_TOOL=wget\n${"x".repeat(2_000)}\nORK_PROBE_RC=1\n`,
    ).detail;
    expect(detail?.length).toBeLessThanOrEqual(301);
    expect(detail).not.toContain("ORK_PROBE");
  });
});

describe("remediation", () => {
  test("Docker subnets widen to the private range Docker allocates from", () => {
    expect(coveringCidrs(["172.17.0.0/16", "172.18.0.0/16", "172.30.4.0/24"])).toEqual([
      "172.16.0.0/12",
    ]);
    expect(coveringCidrs(["192.168.64.0/20", "10.200.0.0/24"])).toEqual([
      "192.168.0.0/16",
      "10.0.0.0/8",
    ]);
    expect(coveringCidrs(["100.90.0.0/16"])).toEqual(["100.90.0.0/16"]);
    expect(coveringCidrs(["fd00::/64", "garbage"])).toEqual(["172.16.0.0/12"]);
    expect(coveringCidrs([])).toEqual(["172.16.0.0/12"]);
  });

  test("ufw gets source-scoped allow rules for the actual port", () => {
    const remediation = buildContainerHostRemediation({
      firewall: "ufw",
      port: 38179,
      subnets: ["172.17.0.0/16"],
      outcomes: ["timeout"],
    });
    expect(remediation.commands).toEqual([
      "sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment 'Orkestrator agent tools'",
    ]);
    expect(remediation.steps.join(" ")).toContain("ufw");
    expect(remediation.steps.join(" ")).toContain("stays closed to other machines");
  });

  test("firewalld gets rich rules and a reload; others get iptables with a persistence note", () => {
    const firewalld = buildContainerHostRemediation({
      firewall: "firewalld",
      port: 4567,
      subnets: ["172.17.0.0/16"],
      outcomes: ["timeout"],
    });
    expect(firewalld.commands).toEqual([
      `sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.16.0.0/12" port port="4567" protocol="tcp" accept'`,
      "sudo firewall-cmd --reload",
    ]);
    const unknown = buildContainerHostRemediation({
      firewall: "unknown",
      port: 4567,
      subnets: [],
      outcomes: ["refused"],
    });
    expect(unknown.commands).toEqual([
      "sudo iptables -I INPUT -p tcp -s 172.16.0.0/12 --dport 4567 -j ACCEPT",
    ]);
    expect(unknown.steps.join(" ")).toContain("lost on reboot");
  });

  test("a DNS-only failure points at Docker's host-gateway alias, not the firewall", () => {
    const remediation = buildContainerHostRemediation({
      firewall: "ufw",
      port: 4567,
      subnets: [],
      outcomes: ["dns"],
    });
    expect(remediation.title).toContain("host.docker.internal");
    expect(remediation.commands.join(" ")).not.toContain("ufw");
  });
});

type Call = string[];

/** A scripted `docker`/`systemctl` runner. */
function fakeRunner(script: {
  probeOutput?: (args: Call) => string;
  probeImagePresent?: boolean;
  pull?: "ok" | "fail";
  fallbackPresent?: boolean;
  networkCreate?: "ok" | "fail";
  execOutput?: (args: Call) => string | Error;
  activeUnits?: string[];
}) {
  const calls: Call[] = [];
  let probeImagePresent = script.probeImagePresent ?? true;
  const run: NonNullable<ContainerHostReachabilityDependencies["run"]> = async (
    command,
    args = [],
  ) => {
    const call = [command, ...args];
    calls.push(call);
    const ok = (stdout = "") => ({ stdout, stderr: "" });
    if (command === "systemctl") {
      const unit = args[1] ?? "";
      if ((script.activeUnits ?? []).includes(unit)) return ok("active\n");
      throw new CommandFailedError("inactive", { exitCode: 3 });
    }
    if (command !== "docker") throw new Error(`unexpected ${command}`);
    const [sub, ...rest] = args;
    if (sub === "image" && rest[0] === "inspect") {
      const image = rest.at(-1);
      if (image === CONTAINER_HOST_PROBE_IMAGE && probeImagePresent) return ok("sha256:abc\n");
      if (image !== CONTAINER_HOST_PROBE_IMAGE && script.fallbackPresent) return ok("sha256:def\n");
      throw new CommandFailedError("Error: No such image", { exitCode: 1 });
    }
    if (sub === "pull") {
      if (script.pull === "fail") throw new CommandFailedError("pull denied", { exitCode: 1 });
      probeImagePresent = true;
      return ok();
    }
    if (sub === "network" && rest[0] === "ls") return ok("bridge\nork-owner-abc-net\n");
    if (sub === "network" && rest[0] === "inspect") {
      const names = rest.slice(3);
      if (names.length > 1) return ok("172.17.0.0/16 \n172.19.0.0/16 \n");
      if (names[0] === "bridge") return ok("172.17.0.0/16 ");
      return ok("172.18.0.0/16 ");
    }
    if (sub === "network" && rest[0] === "create") {
      if (script.networkCreate === "fail") throw new CommandFailedError("pool exhausted");
      return ok("netid\n");
    }
    if (sub === "network" && rest[0] === "rm") return ok();
    if (sub === "ps") return ok("");
    if (sub === "rm") return ok();
    if (sub === "run") return ok(script.probeOutput?.(call) ?? CURL_HTTP_405);
    if (sub === "exec") {
      const output = script.execOutput?.(call) ?? CURL_HTTP_405;
      if (output instanceof Error) throw output;
      return ok(output);
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };
  return { run, calls };
}

function service(
  overrides: Partial<ContainerHostReachabilityDependencies> & {
    runner?: ReturnType<typeof fakeRunner>;
  } = {},
) {
  const runner = overrides.runner ?? fakeRunner({});
  const events: ContainerHostReachability[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const svc = new ContainerHostReachabilityService({
    servicePort: () => 38179,
    ownerNamespace: "owner",
    fallbackImage: () => "orkestrator-v2:latest",
    platform: "linux",
    detectTopology: async () => ({ kind: "local-engine" }),
    readTextFile: async (path) =>
      path === "/etc/ufw/ufw.conf"
        ? "ENABLED=yes\n"
        : path === "/etc/default/ufw"
          ? 'DEFAULT_INPUT_POLICY="DROP"\n'
          : null,
    emit: (event, payload) => {
      if (event === CONTAINER_HOST_REACHABILITY_CHANGED_EVENT) {
        events.push(payload as ContainerHostReachability);
      }
    },
    now: () => now,
    log: { info: (line) => logs.push(`info ${line}`), warn: (line) => logs.push(`warn ${line}`) },
    ...overrides,
    run: overrides.run ?? runner.run,
  });
  return {
    svc,
    runner,
    events,
    logs,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ContainerHostReachabilityService.check", () => {
  test("a firewall that drops container traffic is reported with the ufw fix and logged", async () => {
    const { svc, runner, events, logs } = service({
      runner: fakeRunner({ probeOutput: () => BUSYBOX_TIMEOUT }),
    });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.firewall).toEqual({
      kind: "ufw",
      detail: "ufw is enabled; default incoming policy DROP",
    });
    expect(result.probes.map((probe) => [probe.scope, probe.outcome])).toEqual([
      ["default-bridge", "timeout"],
      ["environment-network", "timeout"],
    ]);
    expect(result.summary).toContain("port 38179");
    expect(result.summary).toContain("firewall");
    expect(result.remediation?.commands).toEqual([
      "sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment 'Orkestrator agent tools'",
    ]);
    expect(containerHostReachabilityNeedsAttention(result)).toBe(true);
    expect(events.map((event) => event.status)).toEqual(["checking", "blocked"]);

    // The probe uses the pinned busybox image, never pulls implicitly, adds
    // the host-gateway alias and carries no credential.
    const probeRuns = runner.calls.filter((call) => call[1] === "run");
    expect(probeRuns).toHaveLength(2);
    for (const call of probeRuns) {
      expect(call).toContain(CONTAINER_HOST_PROBE_IMAGE);
      expect(call).toContain("never");
      expect(call).toContain("host.docker.internal:host-gateway");
      expect(call).toContain("http://host.docker.internal:38179/mcp");
      expect(call.join(" ")).not.toMatch(/token|bearer/i);
    }
    // The temporary network is created and removed again.
    expect(runner.calls.some((call) => call[1] === "network" && call[2] === "create")).toBe(true);
    expect(runner.calls.at(-1)?.slice(1, 3)).toEqual(["network", "rm"]);

    const logText = logs.join("\n");
    expect(logText).toContain("status=blocked");
    expect(logText).toContain("outcome=timeout");
    expect(logText).toContain("fix: sudo ufw allow");
  });

  test("a reachable host passes quietly", async () => {
    const { svc, logs } = service();
    const result = await svc.check("boot");
    expect(result.status).toBe("reachable");
    expect(result.remediation).toBeNull();
    expect(containerHostReachabilityNeedsAttention(result)).toBe(false);
    expect(logs.filter((line) => line.startsWith("warn"))).toEqual([]);
  });

  test("a block on per-environment networks only is still a block", async () => {
    const { svc } = service({
      runner: fakeRunner({
        probeOutput: (call) =>
          call.includes("bridge") && !call.some((part) => part.endsWith("-net"))
            ? CURL_HTTP_405
            : BUSYBOX_TIMEOUT,
      }),
    });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("Containers on bridge can connect");
  });

  test("the environment image is the fallback when busybox cannot be pulled", async () => {
    const runner = fakeRunner({ probeImagePresent: false, pull: "fail", fallbackPresent: true });
    const { svc } = service({ runner });
    const result = await svc.check("boot");
    expect(result.status).toBe("reachable");
    expect(result.probeImage).toBe("orkestrator-v2:latest");
  });

  test("busybox is pulled once when missing", async () => {
    const runner = fakeRunner({ probeImagePresent: false, pull: "ok" });
    const { svc } = service({ runner });
    const result = await svc.check("boot");
    expect(result.probeImage).toBe(CONTAINER_HOST_PROBE_IMAGE);
    expect(runner.calls.filter((call) => call[1] === "pull")).toHaveLength(1);
  });

  test("no probe image means unverified with a pull command, never a pass", async () => {
    const runner = fakeRunner({ probeImagePresent: false, pull: "fail", fallbackPresent: false });
    const { svc } = service({ runner });
    const result = await svc.check("boot");
    expect(result).toMatchObject({ status: "unverified", reason: "probe-image-unavailable" });
    expect(result.remediation?.commands).toEqual([`docker pull ${CONTAINER_HOST_PROBE_IMAGE}`]);
    expect(containerHostReachabilityNeedsAttention(result)).toBe(true);
  });

  test("a failed network creation still checks the default bridge", async () => {
    const runner = fakeRunner({ networkCreate: "fail", probeOutput: () => BUSYBOX_TIMEOUT });
    const { svc } = service({ runner });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.probes.map((probe) => probe.scope)).toEqual(["default-bridge"]);
  });

  test("hosts where the check does not apply say so without running Docker", async () => {
    const runner = fakeRunner({});
    const mac = service({ platform: "darwin", runner });
    expect(await mac.svc.check("boot")).toMatchObject({
      status: "not-applicable",
      reason: "not-linux",
    });
    const remote = service({ detectTopology: async () => ({ kind: "remote" }), runner });
    expect(await remote.svc.check("boot")).toMatchObject({
      status: "not-applicable",
      reason: "docker-remote",
    });
    const noDocker = service({ detectTopology: async () => ({ kind: "unavailable" }), runner });
    expect(await noDocker.svc.check("boot")).toMatchObject({
      status: "unverified",
      reason: "docker-unavailable",
    });
    const noServer = service({ servicePort: () => null, runner });
    expect(await noServer.svc.check("boot")).toMatchObject({
      status: "unverified",
      reason: "agent-tools-not-listening",
    });
    expect(runner.calls.filter((call) => call[1] === "run")).toEqual([]);
  });

  test("Docker Desktop keeps its own host.docker.internal", async () => {
    const runner = fakeRunner({});
    const { svc } = service({ detectTopology: async () => ({ kind: "desktop" }), runner });
    await svc.check("boot");
    const probeRuns = runner.calls.filter((call) => call[1] === "run");
    expect(probeRuns.length).toBeGreaterThan(0);
    for (const call of probeRuns) expect(call).not.toContain("--add-host");
  });

  test("concurrent checks share one run", async () => {
    const runner = fakeRunner({});
    const { svc } = service({ runner });
    const [first, second] = await Promise.all([svc.check("boot"), svc.check("manual")]);
    expect(first).toEqual(second);
    expect(runner.calls.filter((call) => call[1] === "run")).toHaveLength(2);
  });

  test("the firewall kind falls back to active systemd units", async () => {
    const runner = fakeRunner({ activeUnits: ["firewalld"], probeOutput: () => BUSYBOX_TIMEOUT });
    const { svc } = service({ runner, readTextFile: async () => null });
    const result = await svc.check("manual");
    expect(result.firewall.kind).toBe("firewalld");
    expect(result.remediation?.commands.at(-1)).toBe("sudo firewall-cmd --reload");
  });
});

describe("environment container probes and workflow preflight", () => {
  const environment = {
    id: "env-1",
    name: "indicator-review",
    environmentType: "containerized",
    containerId: "0019d3149a22aaaa",
  };

  test("a blocked container fails the stage with the cause and the fix", async () => {
    const runner = fakeRunner({
      execOutput: () => CURL_TIMEOUT,
      probeOutput: () => BUSYBOX_TIMEOUT,
    });
    const prepared: string[] = [];
    const { svc } = service({
      runner,
      loadEnvironment: async () => environment,
      prepareContainer: async (containerId) => {
        prepared.push(containerId);
      },
    });
    const error = await svc
      .assertEnvironmentReachable("env-1", "Multi Review preparation step")
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(ContainerAgentToolsUnreachableError);
    const message = (error as Error).message;
    expect(message).toContain("did not start the Multi Review preparation step");
    expect(message).toContain("“indicator-review”");
    expect(message).toContain("http://host.docker.internal:38179/mcp");
    expect(message).toContain("timed out");
    expect(message).toContain(
      "sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment 'Orkestrator agent tools'",
    );
    expect(message).toContain("retry this stage");
    expect(prepared).toEqual([environment.containerId]);
  });

  test("a container blocked while the host is fine blames the container, not the firewall", async () => {
    const runner = fakeRunner({ execOutput: () => CURL_TIMEOUT, probeOutput: () => CURL_HTTP_405 });
    const { svc } = service({ runner, loadEnvironment: async () => environment });
    await svc.check("boot");
    const error = (await svc
      .assertEnvironmentReachable("env-1", "build pipeline reviewing step")
      .catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("block is inside this environment's container");
    expect(error.message).not.toContain("sudo ufw");
  });

  test("reachable, local, containerless and inconclusive environments pass", async () => {
    const reachable = service({ loadEnvironment: async () => environment });
    await reachable.svc.assertEnvironmentReachable("env-1", "stage");

    const local = service({
      loadEnvironment: async () => ({ ...environment, environmentType: "local" }),
      runner: fakeRunner({ execOutput: () => CURL_TIMEOUT }),
    });
    await local.svc.assertEnvironmentReachable("env-1", "stage");
    expect(local.runner.calls).toEqual([]);

    const noContainer = service({
      loadEnvironment: async () => ({ ...environment, containerId: null }),
    });
    await noContainer.svc.assertEnvironmentReachable("env-1", "stage");

    const inconclusive = service({
      loadEnvironment: async () => environment,
      runner: fakeRunner({
        execOutput: () => new CommandFailedError("No such container", { exitCode: 1 }),
      }),
    });
    await inconclusive.svc.assertEnvironmentReachable("env-1", "stage");
  });

  test("container results are cached, failures only briefly", async () => {
    let output = CURL_TIMEOUT;
    const runner = fakeRunner({ execOutput: () => output, probeOutput: () => BUSYBOX_TIMEOUT });
    const { svc, advance } = service({ runner });
    const execs = () => runner.calls.filter((call) => call[1] === "exec").length;

    expect((await svc.checkEnvironmentContainer("c1", { reason: "t" }))?.outcome).toBe("timeout");
    expect((await svc.checkEnvironmentContainer("c1", { reason: "t" }))?.outcome).toBe("timeout");
    expect(execs()).toBe(1);
    advance(11_000);
    output = CURL_HTTP_405;
    expect((await svc.checkEnvironmentContainer("c1", { reason: "t" }))?.outcome).toBe("reachable");
    expect(execs()).toBe(2);
    advance(30_000);
    await svc.checkEnvironmentContainer("c1", { reason: "t" });
    expect(execs()).toBe(2);
  });

  test("a container failure the host check has not seen re-runs the host check", async () => {
    const runner = fakeRunner({
      execOutput: () => CURL_TIMEOUT,
      probeOutput: () => BUSYBOX_TIMEOUT,
    });
    const { svc, events } = service({ runner });
    await svc.checkEnvironmentContainer("c1", { reason: "bridge-start" });
    // The recheck runs in the background; wait for it to publish.
    for (let attempt = 0; attempt < 50 && svc.snapshot().status !== "blocked"; attempt += 1) {
      await Bun.sleep(1);
    }
    expect(svc.snapshot()).toMatchObject({ status: "blocked", trigger: "recheck" });
    expect(events.at(-1)?.status).toBe("blocked");
  });
});

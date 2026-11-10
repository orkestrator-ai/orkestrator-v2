import { eventSink } from "./backend-emit.js";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { resetLogger } from "@orkestrator/protocol/logger";
import { describe, expect, spyOn, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
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
  buildRootlessHostRemediation,
  classifyProbeOutput,
  coveringCidrs,
  hostNetworkAddresses,
  type ContainerHostReachabilityDependencies,
} from "./container-host-reachability.js";
import { subscribeDockerNetworkChanges } from "./docker-network-changes.js";
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

afterEach(() => {
  resetLogger();
});

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
    // busybox's wording for a route RootlessKit refuses (host loopback disabled).
    expect(
      classifyProbeOutput(
        "ORK_PROBE_TOOL=wget\nwget: can't connect to remote host (10.0.2.2): Network unreachable\nORK_PROBE_RC=1\n",
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
  // Run the copyable command in a real shell, with no host firewall/service
  // binaries on PATH. NUL delimiters preserve spaces and argument boundaries.
  function executeRemediation(
    command: string,
    options: { failArgument?: string; blockDropIn?: boolean } = {},
  ) {
    const dir = mkdtempSync(join(tmpdir(), "ork-remediation 'quoted' "));
    const bin = join(dir, "bin");
    const log = join(dir, "calls");
    const dropIn = join(
      dir,
      ".config/systemd/user/docker.service.d/orkestrator-host-loopback.conf",
    );
    try {
      mkdirSync(bin);
      writeFileSync(log, "");
      symlinkSync("/bin/sh", join(bin, "sh"));
      writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexport STUB_PRIVILEGED=1\nexec "$@"\n', {
        mode: 0o700,
      });
      for (const name of ["ufw", "firewall-cmd", "iptables", "mkdir", "systemctl"]) {
        writeFileSync(
          join(bin, name),
          `#!/bin/sh
printf '%s\\0' '${name}' "$@" >> "$CALL_LOG"
printf '\\0' >> "$CALL_LOG"
${["ufw", "firewall-cmd", "iptables"].includes(name) ? '[ "$STUB_PRIVILEGED" = 1 ] || exit 24' : ""}
for arg do
  if [ "$arg" = "$FAIL_ARGUMENT" ]; then exit 23; fi
done
${
  name === "systemctl"
    ? `if [ "$2" = daemon-reload ]; then
  {
    IFS= read -r header && IFS= read -r environment &&
    [ "$header" = '[Service]' ] &&
    [ "$environment" = 'Environment="DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false"' ]
  } < "$DROP_IN" || exit 24
fi`
    : ""
}
${name === "mkdir" ? 'exec /bin/mkdir "$@"' : "exit 0"}
`,
          { mode: 0o700 },
        );
      }
      if (options.blockDropIn) mkdirSync(dropIn, { recursive: true });
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: {
          PATH: bin,
          HOME: dir,
          CALL_LOG: log,
          DROP_IN: dropIn,
          FAIL_ARGUMENT: options.failArgument ?? "",
        },
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.error) throw result.error;
      expect(result.signal).toBeNull();
      const entries = readFileSync(log, "utf8");
      return {
        status: result.status,
        calls: entries
          ? entries
              .slice(0, -2)
              .split("\0\0")
              .map((entry) => entry.split("\0"))
          : [],
        dropIn: options.blockDropIn
          ? null
          : (() => {
              try {
                return readFileSync(dropIn, "utf8");
              } catch {
                return null;
              }
            })(),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const firewall of ["ufw", "firewalld", "iptables"] as const) {
    for (const subnets of [["192.168.64.0/20"], ["192.168.64.0/20", "10.200.0.0/24"]]) {
      const rule = (source: string) => {
        switch (firewall) {
          case "ufw":
            return [
              "ufw",
              "allow",
              "proto",
              "tcp",
              "from",
              source,
              "to",
              "any",
              "port",
              "4567",
              "comment",
              "Orkestrator agent tools",
            ];
          case "firewalld":
            return [
              "firewall-cmd",
              "--permanent",
              `--add-rich-rule=rule family=ipv4 source address=${source} port port=4567 protocol=tcp accept`,
            ];
          case "iptables":
            return [
              "iptables",
              "-I",
              "INPUT",
              "-p",
              "tcp",
              "-s",
              source,
              "--dport",
              "4567",
              "-j",
              "ACCEPT",
            ];
        }
      };
      const command = () => {
        const commands = buildContainerHostRemediation({
          firewall,
          port: 4567,
          subnets,
          outcomes: ["timeout"],
        }).commands;
        expect(commands).toHaveLength(1);
        return commands[0]!;
      };
      test(`${firewall}, ${subnets.length} source(s): shell preserves arguments and reloads after all rules`, () => {
        const result = executeRemediation(command());
        expect(result.status).toBe(0);
        expect(result.calls).toEqual([
          ...subnets.map(rule),
          ...(firewall === "firewalld" ? [["firewall-cmd", "--reload"]] : []),
        ]);
      });
      for (const [index, source] of subnets.entries()) {
        test(`${firewall}, ${subnets.length} source(s): failure at source ${index + 1} stops later rules and reload`, () => {
          const result = executeRemediation(command(), {
            failArgument: rule(source).find((arg) => arg.includes(source)),
          });
          expect(result.status).not.toBe(0);
          expect(result.calls).toEqual(subnets.slice(0, index + 1).map(rule));
        });
      }
      if (firewall === "firewalld") {
        test(`firewalld, ${subnets.length} source(s): reload failure propagates`, () => {
          const result = executeRemediation(command(), { failArgument: "--reload" });
          expect(result.status).toBe(23);
          expect(result.calls).toEqual([...subnets.map(rule), ["firewall-cmd", "--reload"]]);
        });
      }
    }
  }

  test("rootless remediation writes the drop-in before reloading and restarting the user service", () => {
    const commands = buildRootlessHostRemediation(4567).commands;
    expect(commands).toHaveLength(1);
    const result = executeRemediation(commands[0]!);
    expect(result.status).toBe(0);
    expect(result.dropIn).toBe(
      '[Service]\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false"\n',
    );
    expect(result.calls).toEqual([
      ["mkdir", "-p", expect.stringMatching(/\/.config\/systemd\/user\/docker\.service\.d$/)],
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "restart", "docker"],
    ]);
  });

  for (const failure of ["mkdir", "write", "daemon-reload", "restart"] as const) {
    test(`rootless remediation stops and fails when ${failure} fails`, () => {
      const result = executeRemediation(buildRootlessHostRemediation(4567).commands[0]!, {
        failArgument: failure === "mkdir" ? "-p" : failure,
        blockDropIn: failure === "write",
      });
      expect(result.status).not.toBe(0);
      expect(result.calls.map((call) => (call[0] === "mkdir" ? "mkdir" : call[2]))).toEqual(
        failure === "mkdir" || failure === "write"
          ? ["mkdir"]
          : failure === "daemon-reload"
            ? ["mkdir", "daemon-reload"]
            : ["mkdir", "daemon-reload", "restart"],
      );
      if (failure === "mkdir" || failure === "write") expect(result.dropIn).toBeNull();
    });
  }

  test("only Docker's own pool is widened; LAN-style ranges keep their exact subnets", () => {
    expect(coveringCidrs(["172.17.0.0/16", "172.18.0.0/16", "172.30.4.0/24"])).toEqual([
      "172.16.0.0/12",
    ]);
    // 192.168.0.0/16 and 10.0.0.0/8 are common home and office networks: a
    // rule for the whole range would admit every machine on them.
    expect(coveringCidrs(["192.168.64.0/20", "10.200.0.0/24"])).toEqual([
      "192.168.64.0/20",
      "10.200.0.0/24",
    ]);
    expect(coveringCidrs(["172.17.0.0/16", "192.168.64.0/20"])).toEqual([
      "172.16.0.0/12",
      "192.168.64.0/20",
    ]);
    expect(coveringCidrs(["100.90.0.0/16"])).toEqual(["100.90.0.0/16"]);
    expect(coveringCidrs(["fd00::/64", "garbage"])).toEqual(["172.16.0.0/12"]);
    expect(coveringCidrs([])).toEqual(["172.16.0.0/12"]);
  });

  test("the pool is not widened to when this computer's local network uses it", () => {
    const lan = ["172.20.5.10"];
    expect(coveringCidrs(["172.17.0.0/16", "172.18.0.0/16"], lan)).toEqual([
      "172.17.0.0/16",
      "172.18.0.0/16",
    ]);
    expect(coveringCidrs([], lan)).toEqual(["172.17.0.0/16"]);
    // An address outside the pool leaves the widening alone.
    expect(coveringCidrs(["172.17.0.0/16"], ["192.168.1.20", "not-an-ip"])).toEqual([
      "172.16.0.0/12",
    ]);
  });

  test("host network addresses skip loopback, IPv6 and Docker's own interfaces", () => {
    const entry = (address: string, family: "IPv4" | "IPv6" = "IPv4", internal = false) => ({
      address,
      family,
      internal,
      netmask: "255.255.0.0",
      mac: "00:00:00:00:00:00",
      cidr: null,
      ...(family === "IPv6" ? { scopeid: 0 } : {}),
    });
    expect(
      hostNetworkAddresses({
        lo: [entry("127.0.0.1", "IPv4", true)],
        docker0: [entry("172.17.0.1")],
        "br-0123456789ab": [entry("172.18.0.1")],
        veth12345: [entry("169.254.1.1")],
        wlan0: [entry("192.168.1.20"), entry("fe80::1", "IPv6")],
        enp3s0: [entry("172.20.5.10")],
      } as Parameters<typeof hostNetworkAddresses>[0]),
    ).toEqual(["192.168.1.20", "172.20.5.10"]);
  });

  test("ufw gets source-scoped allow rules for the actual port", () => {
    const remediation = buildContainerHostRemediation({
      firewall: "ufw",
      port: 38179,
      subnets: ["172.17.0.0/16"],
      outcomes: ["timeout"],
    });
    expect(remediation.commands).toEqual([
      'sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment "Orkestrator agent tools"',
    ]);
    const steps = remediation.steps.join(" ");
    expect(steps).toContain("ufw");
    expect(steps).toContain("other machines on it still can't connect");
    expect(steps).toContain("replace that rule with Docker's exact subnets");
  });

  test("a local network in Docker's pool gets exact-subnet rules and no widening note", () => {
    const remediation = buildContainerHostRemediation({
      firewall: "ufw",
      port: 38179,
      subnets: ["172.17.0.0/16", "192.168.64.0/20"],
      outcomes: ["timeout"],
      hostAddresses: ["172.20.5.10"],
    });
    expect(remediation.commands).toEqual([
      `sudo sh -c 'for net in 172.17.0.0/16 192.168.64.0/20; do ufw allow proto tcp from $net to any port 38179 comment "Orkestrator agent tools" || exit 1; done'`,
    ]);
    const steps = remediation.steps.join(" ");
    expect(steps).not.toContain("172.16.0.0/12");
    expect(steps).toContain("needs its own rule");
  });

  test("firewalld gets rich rules and a reload; others get iptables with a persistence note", () => {
    const firewalld = buildContainerHostRemediation({
      firewall: "firewalld",
      port: 4567,
      subnets: ["172.17.0.0/16"],
      outcomes: ["timeout"],
    });
    expect(firewalld.commands).toEqual([
      `sudo firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=172.16.0.0/12 port port=4567 protocol=tcp accept" && sudo firewall-cmd --reload`,
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
  /** Names `docker network ls` lists for the owner and probe-role labels. */
  labelledNetworks?: string[];
  labelledContainers?: string[];
  /** Holds each probe `docker run` until the test settles it. */
  holdProbes?: Array<() => void>;
  /** Defers or rejects a specific command without involving Docker. */
  onCall?: (call: Call, timeoutMs: number | undefined) => Promise<void>;
}) {
  const calls: Call[] = [];
  let probeImagePresent = script.probeImagePresent ?? true;
  const run: NonNullable<ContainerHostReachabilityDependencies["run"]> = async (
    command,
    args = [],
    options,
  ) => {
    const call = [command, ...args];
    calls.push(call);
    await script.onCall?.(call, options?.timeoutMs);
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
    if (sub === "network" && rest[0] === "ls" && rest.some((arg) => arg.startsWith("label="))) {
      return ok((script.labelledNetworks ?? []).map((name) => `${name}\n`).join(""));
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
    if (sub === "ps") return ok((script.labelledContainers ?? []).join("\n"));
    if (sub === "rm") return ok();
    if (sub === "run") {
      const hold = script.holdProbes;
      if (hold) await new Promise<void>((resolve) => hold.push(resolve));
      return ok(script.probeOutput?.(call) ?? CURL_HTTP_405);
    }
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
  const capture = captureLogs();
  const logs = capture.lines;
  const warnings = () => capture.records().filter((record) => record.level === "warn");
  let now = 1_000_000;
  const svc = new ContainerHostReachabilityService({
    servicePort: () => 38179,
    ownerNamespace: "owner",
    fallbackImage: () => "orkestrator-v2:latest",
    platform: "linux",
    // Deterministic: the real interfaces of the machine running the suite vary.
    hostAddresses: () => ["192.168.1.20"],
    detectTopology: async () => ({ kind: "local-engine" }),
    readTextFile: async (path) =>
      path === "/etc/ufw/ufw.conf"
        ? "ENABLED=yes\n"
        : path === "/etc/default/ufw"
          ? 'DEFAULT_INPUT_POLICY="DROP"\n'
          : null,
    emit: eventSink((event, payload) => {
      if (event === CONTAINER_HOST_REACHABILITY_CHANGED_EVENT) {
        events.push(payload as ContainerHostReachability);
      }
    }),
    now: () => now,
    ...overrides,
    run: overrides.run ?? runner.run,
  });
  return {
    svc,
    runner,
    events,
    logs,
    warnings,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ContainerHostReachabilityService.check", () => {
  for (const rejected of [false, true]) {
    test(`probe logs omit private diagnostics (${rejected ? "rejected" : "resolved"} command)`, async () => {
      const privateOutput = "PRIVATE-PROBE password=credential-probe-marker";
      const failure = new CommandFailedError(
        `Cannot connect to the Docker daemon ${privateOutput}`,
        { exitCode: 125 },
      );
      const runner = fakeRunner({
        probeOutput: () => privateOutput,
        execOutput: () => (rejected ? failure : privateOutput),
        onCall: async (call) => {
          if (rejected && call[1] === "run") throw failure;
        },
      });
      const { svc, logs, warnings } = service({
        runner,
        run: async (command, args, options) => {
          const result = await runner.run(command, args, options);
          return command === "docker" && ["run", "exec"].includes(args?.[0] ?? "")
            ? { ...result, stderr: "PRIVATE-PROBE-STDERR password=stderr-credential-marker" }
            : result;
        },
      });
      try {
        const result = await svc.check("boot");
        // UI diagnostics remain available; logs carry only fixed metadata.
        expect(result.probes[0]?.detail).toContain("PRIVATE-PROBE");
        await svc.checkEnvironmentContainer("container-private", { reason: "bridge-ready" });
        const records = warnings().filter((entry) =>
          ["probe.result", "check.probe", "check.summary"].includes(entry.event),
        );
        expect(new Set(records.map((entry) => entry.event))).toEqual(
          new Set(["probe.result", "check.probe", "check.summary"]),
        );
        for (const entry of records.filter((entry) => entry.event !== "check.summary")) {
          expect(entry.fields).toMatchObject({
            outcome: "error",
            elapsedMs: expect.any(Number),
            http: null,
          });
          if (rejected)
            expect(entry.fields).toMatchObject({ reason: "daemon-unavailable", exitCode: 125 });
        }
        expect(logs.join("\n")).not.toContain("PRIVATE-PROBE");
        expect(logs.join("\n")).not.toContain("credential-probe-marker");
        expect(logs.join("\n")).not.toContain("stderr-credential-marker");
      } finally {
        await svc.dispose();
      }
    });
  }
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
      'sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment "Orkestrator agent tools"',
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
    expect(logText).toContain("check.remediation");
    expect(logText).toContain("sudo ufw allow");
  });

  test("the fix never widens to a range this computer's local network uses", async () => {
    const { svc } = service({
      runner: fakeRunner({ probeOutput: () => BUSYBOX_TIMEOUT }),
      hostAddresses: () => ["172.20.5.10"],
    });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.remediation?.commands.join("\n")).not.toContain("172.16.0.0/12");
    expect(result.remediation?.commands.length).toBeGreaterThan(0);
  });

  test("a reachable host passes quietly", async () => {
    const { svc, warnings } = service();
    const result = await svc.check("boot");
    expect(result.status).toBe("reachable");
    expect(result.remediation).toBeNull();
    expect(containerHostReachabilityNeedsAttention(result)).toBe(false);
    expect(warnings()).toEqual([]);
  });

  test("probe networks and containers carry the content-free creator label", async () => {
    const labelled = service({ creator: "agent-test/temporary" });
    await labelled.svc.check("boot");
    const created = labelled.runner.calls.filter(
      (call) => (call[1] === "network" && call[2] === "create") || call[1] === "run",
    );
    expect(created.length).toBeGreaterThan(1);
    for (const call of created) {
      expect(call).toContain("orkestrator-owner=owner");
      expect(call).toContain("orkestrator-resource-role=host-reachability-probe");
      expect(call).toContain("orkestrator-creator=agent-test/temporary");
    }

    // A backend that names no creator adds no label at all.
    const unlabelled = service();
    await unlabelled.svc.check("boot");
    expect(
      unlabelled.runner.calls.flat().some((part) => part.includes("orkestrator-creator")),
    ).toBe(false);
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
    expect(result.remediation?.commands).toHaveLength(1);
    expect(result.remediation?.commands[0]).toEndWith("&& sudo firewall-cmd --reload");
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
      'sudo ufw allow proto tcp from 172.16.0.0/12 to any port 38179 comment "Orkestrator agent tools"',
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

// Captured on Docker 29.9.1 rootless (RootlessKit 3.3.0, slirp4netns):
// host-gateway names the bridge inside RootlessKit's namespace, and 10.0.2.2
// is refused while host loopback is disabled.
const ROOTLESS_GATEWAY_REFUSED =
  "ORK_PROBE_TOOL=wget\nwget: can't connect to remote host (172.17.0.1): Connection refused\nORK_PROBE_RC=1\n";
const ROOTLESS_LOOPBACK_DISABLED =
  "ORK_PROBE_TOOL=wget\nwget: can't connect to remote host (10.0.2.2): Network unreachable\nORK_PROBE_RC=1\n";
const viaLoopback = (args: string[]) => args.includes("host.docker.internal:10.0.2.2");

describe("rootless Docker", () => {
  const rootless = async () => ({ kind: "local-engine" as const, rootless: true });

  test("RootlessKit's host loopback is chosen for host.docker.internal once it answers", async () => {
    const runner = fakeRunner({
      probeOutput: (args) => (viaLoopback(args) ? BUSYBOX_HTTP_405 : ROOTLESS_GATEWAY_REFUSED),
    });
    const { svc } = service({ runner, detectTopology: rootless });
    const result = await svc.check("boot");
    expect(result).toMatchObject({
      status: "reachable",
      dockerRootless: true,
      hostAddress: "10.0.2.2",
      remediation: null,
    });
    expect(result.summary).toContain("RootlessKit's host loopback (10.0.2.2)");
    // Both networks were probed both ways; the loopback probes say so.
    expect(result.probes.filter((probe) => probe.hostAddress === "10.0.2.2")).toHaveLength(2);
    expect(result.probes.filter((probe) => !probe.hostAddress)).toHaveLength(2);
    expect(svc.containerHostAddress()).toBe("10.0.2.2");
    expect(await svc.resolveContainerHostAddress()).toBe("10.0.2.2");
  });

  test("with host loopback disabled the fix is the daemon setting, not a firewall rule", async () => {
    const runner = fakeRunner({
      probeOutput: (args) =>
        viaLoopback(args) ? ROOTLESS_LOOPBACK_DISABLED : ROOTLESS_GATEWAY_REFUSED,
    });
    const { svc } = service({ runner, detectTopology: rootless });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.hostAddress ?? null).toBeNull();
    expect(result.summary).toContain("Docker runs rootless");
    expect(result.remediation).toEqual(buildRootlessHostRemediation(38179));
    expect(result.remediation?.commands.join("\n")).toContain(
      "DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=false",
    );
    expect(result.remediation?.commands.join("\n")).not.toContain("ufw");
    expect(svc.containerHostAddress()).toBeNull();
  });

  test("a rootless daemon whose host-gateway answers keeps host-gateway and skips the loopback probes", async () => {
    const runner = fakeRunner({ probeOutput: () => BUSYBOX_HTTP_405 });
    const { svc } = service({ runner, detectTopology: rootless });
    const result = await svc.check("boot");
    expect(result).toMatchObject({ status: "reachable", dockerRootless: true });
    expect(result.hostAddress ?? null).toBeNull();
    expect(runner.calls.some(viaLoopback)).toBe(false);
  });

  test("a rootful daemon never probes RootlessKit's address", async () => {
    const runner = fakeRunner({ probeOutput: () => BUSYBOX_TIMEOUT });
    const { svc } = service({ runner });
    const result = await svc.check("boot");
    expect(result.status).toBe("blocked");
    expect(result.dockerRootless).toBe(false);
    expect(runner.calls.some(viaLoopback)).toBe(false);
  });

  test("container creation waits for the first check, bounded", async () => {
    const runner = fakeRunner({
      probeOutput: (args) => (viaLoopback(args) ? BUSYBOX_HTTP_405 : ROOTLESS_GATEWAY_REFUSED),
    });
    const { svc } = service({ runner, detectTopology: rootless });
    // No check has run yet: the call starts one and waits for its verdict.
    expect(await svc.resolveContainerHostAddress()).toBe("10.0.2.2");
    const stalled = service({
      detectTopology: () => new Promise(() => undefined),
    }).svc;
    expect(await stalled.resolveContainerHostAddress(20)).toBeNull();
  });
});

/** Lets the service's pending Docker calls run until `predicate` holds. */
async function until(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1_000 && !predicate(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const PROBE_NETWORK = "ork-owner-reach-probe-net";
const isNetworkRemoval = (call: Call) =>
  call[1] === "network" && call[2] === "rm" && call[3] === PROBE_NETWORK;

describe("shutdown and stale probe cleanup", () => {
  test("shutdown during a check removes the probe containers and network within the bound", async () => {
    const held: Array<() => void> = [];
    const runner = fakeRunner({ holdProbes: held });
    const { svc } = service({ runner });
    const checked = svc.check("boot");
    // Both probes are running: one on the bridge, one on the probe network.
    await until(() => held.length === 2);
    const probeNames = runner.calls
      .filter((call) => call[1] === "run")
      .map((call) => call[call.indexOf("--name") + 1]!);
    const before = runner.calls.length;
    // The probes never return; dispose must not wait for them past its bound.
    await svc.dispose(5);
    const after = runner.calls.slice(before);
    expect(after).toEqual([
      ...probeNames.map((name) => ["docker", "rm", "-f", name]),
      ["docker", "network", "rm", PROBE_NETWORK],
    ]);
    // The cut-short check winds down; once closed, a later check starts nothing.
    for (const release of held) release();
    await checked;
    const calls = runner.calls.length;
    await svc.check("manual");
    expect(runner.calls.length).toBe(calls);
  });

  test("shutdown waits for a check that finishes in time and lets it clean up itself", async () => {
    const held: Array<() => void> = [];
    const runner = fakeRunner({ holdProbes: held });
    const { svc } = service({ runner });
    const checked = svc.check("boot");
    await until(() => held.length === 2);
    const disposed = svc.dispose(60_000);
    for (const release of held) release();
    await disposed;
    await checked;
    expect(runner.calls.filter(isNetworkRemoval)).toHaveLength(2);
    // The leftover removal before create, then the check's own release;
    // shutdown added no network removal of its own. The check was never
    // interrupted, so no early removal can have preceded a container's
    // creation, and `docker run --rm` removed each probe itself.
    const probeNames = new Set(
      runner.calls
        .filter((call) => call[1] === "run")
        .map((call) => call[call.indexOf("--name") + 1]),
    );
    expect(runner.calls.filter((call) => call[1] === "rm" && probeNames.has(call[3]))).toEqual([]);
  });

  test("a check still preparing when shutdown begins never creates a probe network", async () => {
    let topology: (value: { kind: "local-engine" }) => void = () => undefined;
    const runner = fakeRunner({});
    const { svc } = service({
      runner,
      detectTopology: () => new Promise((resolve) => (topology = resolve)),
    });
    const checked = svc.check("boot");
    // Nothing exists yet, so the bound elapses with nothing to remove.
    await svc.dispose(5);
    topology({ kind: "local-engine" });
    await checked;
    expect(runner.calls.some((call) => call[1] === "network" && call[2] === "create")).toBe(false);
    expect(runner.calls.some((call) => call[1] === "run")).toBe(false);
  });

  for (const phase of ["initial removal", "create", "subnet inspection"] as const) {
    test(`shutdown during network ${phase} prevents late probes and cleans up`, async () => {
      const entered = deferred();
      const release = deferred();
      let exists = false;
      let held = false;
      const runner = fakeRunner({
        onCall: async (call) => {
          const isCreate = call[1] === "network" && call[2] === "create";
          const isSubnet =
            call[1] === "network" && call[2] === "inspect" && call.at(-1) === PROBE_NETWORK;
          if (
            !held &&
            ((phase === "initial removal" && isNetworkRemoval(call)) ||
              (phase === "create" && isCreate) ||
              (phase === "subnet inspection" && isSubnet))
          ) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          if (isCreate) exists = true;
          if (isNetworkRemoval(call)) {
            if (!exists) throw new Error("No such network");
            exists = false;
          }
        },
      });
      const { svc, logs } = service({ runner });
      const checked = svc.check("boot");
      await entered.promise;
      let finished = false;
      const disposed = svc.dispose(0).then(() => {
        finished = true;
      });
      await until(() => logs.some((line) => line.includes("shutdown.awaiting-network")));
      expect(finished).toBe(false);
      // No early shutdown removal while a future create could still succeed.
      expect(runner.calls.filter(isNetworkRemoval)).toHaveLength(1);
      release.resolve();
      await Promise.all([checked, disposed]);
      expect(exists).toBe(false);
      expect(runner.calls.filter((call) => call[1] === "run")).toEqual([]);
      expect(runner.calls.filter((call) => call[2] === "create")).toHaveLength(
        phase === "initial removal" ? 0 : 1,
      );
    });
  }

  test("dispose during the network create removes it only after the create settles, and starts no probe", async () => {
    const entered = deferred();
    const release = deferred();
    const order: string[] = [];
    const runner = fakeRunner({
      onCall: async (call) => {
        if (call[1] === "network" && call[2] === "create") {
          entered.resolve();
          await release.promise;
          order.push("created");
        } else if (isNetworkRemoval(call)) {
          order.push("removed");
        }
      },
    });
    const { svc, events, logs } = service({ runner });
    const checked = svc.check("boot");
    await entered.promise;
    const disposed = svc.dispose(0);
    await until(() => logs.some((line) => line.includes("shutdown.awaiting-network")));
    // Only the leftover removal before the create; nothing while it runs.
    expect(order).toEqual(["removed"]);
    release.resolve();
    await disposed;
    expect(order).toEqual(["removed", "created", "removed"]);
    expect(runner.calls.filter((call) => call[1] === "run")).toEqual([]);
    // Interrupted: the check publishes no verdict.
    expect((await checked).status).toBe("checking");
    expect(events.map((event) => event.status)).toEqual(["checking"]);
  });

  test("dispose during the probe runs removes each container, and again once its run ends", async () => {
    const held: Array<() => void> = [];
    const order: string[] = [];
    const runner = fakeRunner({
      holdProbes: held,
      probeOutput: (call) => {
        order.push(`ended ${call[call.indexOf("--name") + 1]}`);
        return CURL_HTTP_405;
      },
      onCall: async (call, timeoutMs) => {
        if (call[1] === "rm") {
          expect(timeoutMs).toBe(5_000);
          order.push(`rm ${call[3]}`);
        }
        if (isNetworkRemoval(call) && held.length === 2) order.push("network rm");
      },
    });
    const { svc, events } = service({ runner });
    let settled = false;
    const checked = svc.check("boot").then((result) => {
      settled = true;
      return result;
    });
    await until(() => held.length === 2);
    const names = runner.calls
      .filter((call) => call[1] === "run")
      .map((call) => call[call.indexOf("--name") + 1]!);
    await svc.dispose(0);
    expect(order).toEqual([...names.map((name) => `rm ${name}`), "network rm"]);
    // The check settles only after the late removals.
    expect(settled).toBe(false);
    for (const resume of held) resume();
    const result = await checked;
    for (const name of names) {
      expect(order.filter((entry) => entry.endsWith(name))).toEqual([
        `rm ${name}`,
        `ended ${name}`,
        `rm ${name}`,
      ]);
    }
    expect(result.status).toBe("checking");
    expect(events.map((event) => event.status)).toEqual(["checking"]);
  });

  test("a failure mid-check releases the probe network and the still-running probe container", async () => {
    const release = deferred();
    let failClock = false;
    let clock = 1_000_000;
    const runner = fakeRunner({
      onCall: async (call) => {
        // Hold the probe on the temporary network; the bridge probe finishes.
        if (call[1] === "run" && call.includes(PROBE_NETWORK)) await release.promise;
        // The bridge probe's subnet lookup: its next clock read throws.
        if (call[1] === "network" && call[2] === "inspect" && call.at(-1) === "bridge") {
          failClock = true;
        }
      },
    });
    const { svc, logs } = service({
      runner,
      now: () => {
        if (failClock) {
          failClock = false;
          throw new Error("clock failed");
        }
        return clock++;
      },
    });
    const checked = svc.check("boot");
    const heldName = () =>
      runner.calls
        .filter((call) => call[1] === "run" && call.includes(PROBE_NETWORK))
        .map((call) => call[call.indexOf("--name") + 1]!)[0];
    await until(
      () =>
        heldName() !== undefined &&
        runner.calls.some((call) => call[1] === "rm" && call[3] === heldName()) &&
        runner.calls.filter(isNetworkRemoval).length === 2,
    );
    // Removed while its run still holds: the failure interrupted it.
    expect(runner.calls).toContainEqual(["docker", "rm", "-f", heldName()!]);
    release.resolve();
    const result = await checked;
    expect(result).toMatchObject({ status: "unverified", reason: "probe-failed" });
    expect(result.summary).toContain("clock failed");
    expect(logs.some((line) => line.includes("check.crashed"))).toBe(true);
    // Removed again once its run ended.
    expect(runner.calls.filter((call) => call[1] === "rm" && call[3] === heldName())).toHaveLength(
      2,
    );
  });

  for (const createFails of [false, true]) {
    test(`network preparation beyond the shutdown budget gets late cleanup (create fails=${createFails})`, async () => {
      const entered = deferred();
      const release = deferred();
      let exists = false;
      const runner = fakeRunner({
        onCall: async (call) => {
          if (call[1] === "network" && call[2] === "create") {
            entered.resolve();
            await release.promise;
            exists = true;
            // The daemon can create a network even if its client reports failure.
            if (createFails) throw new Error("client disconnected");
          }
          if (isNetworkRemoval(call)) {
            if (!exists) throw new Error("No such network");
            exists = false;
          }
        },
      });
      const { svc, logs } = service({ runner });
      const checked = svc.check("boot");
      await entered.promise;
      // Drive only the shutdown preparation deadline without a wall-clock wait.
      const schedule = globalThis.setTimeout;
      let expire: (() => void) | undefined;
      const interceptTimer = Object.assign((...args: Parameters<typeof setTimeout>) => {
        const [handler, ms, ...handlerArgs] = args;
        if (ms === 21_000) {
          expire = () => {
            handler(...handlerArgs);
          };
          return schedule(() => undefined, 60_000);
        }
        return schedule(handler, ms, ...handlerArgs);
      }, schedule);
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(interceptTimer);
      try {
        const disposed = svc.dispose(0);
        await until(() => expire !== undefined);
        expire!();
        await disposed;
        expect(runner.calls.filter(isNetworkRemoval)).toHaveLength(1);
        expect(logs.some((line) => line.includes("shutdown.cleanup-deferred"))).toBe(true);
      } finally {
        timer.mockRestore();
        release.resolve();
        await checked;
      }
      expect(exists).toBe(false);
      expect(runner.calls.filter(isNetworkRemoval)).toHaveLength(2);
      expect(runner.calls.filter((call) => call[1] === "run")).toEqual([]);
    });
  }

  test("a late container creation is removed after an early not-found shutdown removal", async () => {
    const held: Array<() => void> = [];
    const live = new Set<string>();
    const runner = fakeRunner({
      holdProbes: held,
      probeOutput: (call) => {
        live.add(call[call.indexOf("--name") + 1]!);
        return CURL_HTTP_405;
      },
      onCall: async (call) => {
        if (call[1] === "rm" && !live.delete(call[3]!)) throw new Error("No such container");
        if (isNetworkRemoval(call) && live.size > 0) throw new Error("active endpoints");
      },
    });
    const { svc } = service({ runner });
    const checked = svc.check("boot");
    await until(() => held.length === 2);
    await svc.dispose(0);
    for (const release of held) release();
    await checked;
    expect(live.size).toBe(0);
    for (const call of runner.calls.filter((call) => call[1] === "run")) {
      const name = call[call.indexOf("--name") + 1]!;
      expect(runner.calls.filter((call) => call[1] === "rm" && call[3] === name)).toHaveLength(2);
    }
  });

  for (const timedOut of [false, true]) {
    test(`shutdown continues after container removal failure and retries endpoints (timeout=${timedOut})`, async () => {
      const held: Array<() => void> = [];
      const removals: Call[] = [];
      let firstName: string | undefined;
      let networkAttempts = 0;
      const runner = fakeRunner({
        holdProbes: held,
        onCall: async (call, timeoutMs) => {
          if (call[1] === "rm") {
            expect(timeoutMs).toBe(5_000);
            expect(call).toHaveLength(4);
            removals.push(call);
            firstName ??= call[3];
            if (removals.length === 1) throw new CommandFailedError("removal failed", { timedOut });
          }
          // Ignore the normal leftover removal before the network is created.
          if (isNetworkRemoval(call) && held.length === 2) {
            expect(timeoutMs).toBe(5_000);
            networkAttempts += 1;
            if (networkAttempts === 1) throw new Error("active endpoints");
          }
        },
      });
      const { svc, logs } = service({ runner });
      const checked = svc.check("boot");
      await until(() => held.length === 2);
      await svc.dispose(0);
      expect(removals.map((call) => call[3])).toEqual([firstName, expect.any(String), firstName]);
      expect(removals[1]![3]).not.toBe(firstName);
      expect(networkAttempts).toBe(2);
      expect(logs.some((line) => line.includes("shutdown.container-remove-failed"))).toBe(true);
      expect(logs.some((line) => line.includes("shutdown.network-remove-failed"))).toBe(true);
      for (const release of held) release();
      await checked;
    });
  }

  test("retries the network after late endpoints settle beyond the dispose bound", async () => {
    const held: Array<() => void> = [];
    const live = new Set<string>();
    let networkExists = false;
    let runsSettled = false;
    let networkAttempts = 0;
    const runner = fakeRunner({
      holdProbes: held,
      onCall: async (call, timeoutMs) => {
        if (call[1] === "run") live.add(call[call.indexOf("--name") + 1]!);
        if (call[1] === "network" && call[2] === "create") networkExists = true;
        if (call[1] === "rm") {
          expect(timeoutMs).toBe(5_000);
          if (!runsSettled) throw new Error("daemon still attaching endpoint");
          live.delete(call[3]!);
        }
        if (isNetworkRemoval(call) && networkExists) {
          networkAttempts += 1;
          expect(timeoutMs).toBe(5_000);
          if (live.size > 0) throw new Error("active endpoints");
          networkExists = false;
        }
      },
    });
    const { svc } = service({ runner });
    const checked = svc.check("boot");
    try {
      await until(() => held.length === 2);
      await svc.dispose(0);
      expect(live.size).toBe(2);
      expect(networkAttempts).toBe(2);
      expect(networkExists).toBe(true);
    } finally {
      runsSettled = true;
      for (const release of held) release();
      await checked;
      await svc.dispose(0);
    }
    expect(live.size).toBe(0);
    expect(networkAttempts).toBe(3);
    expect(networkExists).toBe(false);
  });

  test("permanent shutdown cleanup failures stop after the bounded late network retry", async () => {
    const held: Array<() => void> = [];
    let networkAttempts = 0;
    let containerAttempts = 0;
    const runner = fakeRunner({
      holdProbes: held,
      onCall: async (call, timeoutMs) => {
        if (call[1] === "rm" || (isNetworkRemoval(call) && held.length === 2)) {
          expect(timeoutMs).toBe(5_000);
          if (call[1] === "rm") containerAttempts += 1;
          else networkAttempts += 1;
          throw new CommandFailedError("Docker deadline", { timedOut: true });
        }
      },
    });
    const { svc, logs } = service({ runner });
    const checked = svc.check("boot");
    await until(() => held.length === 2);
    await svc.dispose(0);
    expect(containerAttempts).toBe(4);
    expect(networkAttempts).toBe(2);
    expect(logs.filter((line) => line.includes("shutdown.network-remove-failed"))).toHaveLength(2);
    for (const release of held) release();
    await checked;
    expect(networkAttempts).toBe(3);
    expect(containerAttempts).toBe(6);
  });

  test("shutdown skips the rootless loopback retry after the first probes settle", async () => {
    const held: Array<() => void> = [];
    const runner = fakeRunner({ holdProbes: held, probeOutput: () => BUSYBOX_TIMEOUT });
    const { svc } = service({
      runner,
      detectTopology: async () => ({ kind: "local-engine", rootless: true }),
    });
    const checked = svc.check("boot");
    await until(() => held.length === 2);
    const disposed = svc.dispose(60_000);
    for (const release of held) release();
    await Promise.all([checked, disposed]);
    expect(runner.calls.filter((call) => call[1] === "run")).toHaveLength(2);
    expect(runner.calls.some((call) => call.includes("host.docker.internal:10.0.2.2"))).toBe(false);
  });

  test("shutdown with no check running touches no Docker", async () => {
    const runner = fakeRunner({});
    const { svc } = service({ runner });
    await svc.dispose();
    expect(runner.calls).toEqual([]);
  });

  test("probe creation, removal and stale reap each report a network change", async () => {
    const runner = fakeRunner({ labelledNetworks: ["ork-owner-reach-old-net"] });
    const { svc } = service({ runner });
    const changes: string[][] = [];
    const unsubscribe = subscribeDockerNetworkChanges(() => {
      changes.push(runner.calls.at(-1)!);
    });
    try {
      await svc.check("boot");
      expect(changes).toHaveLength(3);
      expect(changes[0]).toEqual(["docker", "network", "rm", "ork-owner-reach-old-net"]);
      expect(changes[1]!.slice(0, 3)).toEqual(["docker", "network", "create"]);
      expect(changes[2]).toEqual(["docker", "network", "rm", PROBE_NETWORK]);
    } finally {
      unsubscribe();
      await svc.dispose();
    }
  });

  test("the reaper removes this owner's unattached probe networks, one per call", async () => {
    const runner = fakeRunner({
      // Docker's label filter already scopes to this owner; a listed name of
      // another shape is still never removed.
      labelledNetworks: [PROBE_NETWORK, "ork-owner-reach-old-net", "ork-other-reach-probe-net"],
    });
    const { svc } = service({ runner });
    await svc.check("boot");
    const listing = runner.calls.find(
      (call) =>
        call[1] === "network" && call[2] === "ls" && call.some((arg) => arg.startsWith("label=")),
    );
    expect(listing).toContain("label=orkestrator-owner=owner");
    expect(listing).toContain("label=orkestrator-resource-role=host-reachability-probe");
    const create = runner.calls.findIndex((call) => call[2] === "create");
    const removedBeforeCreate = runner.calls
      .slice(0, create)
      .filter((call) => call[1] === "network" && call[2] === "rm")
      .map((call) => call.slice(3));
    expect(removedBeforeCreate).toEqual([
      [PROBE_NETWORK],
      ["ork-owner-reach-old-net"],
      // createProbeNetwork's own leftover removal.
      [PROBE_NETWORK],
    ]);
  });
  test("a refused stale container does not skip the remaining container or network", async () => {
    const runner = fakeRunner({
      labelledContainers: ["refused-container", "later-container"],
      labelledNetworks: ["ork-owner-reach-old-net"],
      onCall: async (call) => {
        if (call[1] === "rm" && call[3] === "refused-container") throw new Error("removal refused");
      },
    });
    const { svc } = service({ runner });
    expect((await svc.check("boot")).status).toBe("reachable");
    expect(runner.calls).toContainEqual(["docker", "rm", "-f", "later-container"]);
    expect(runner.calls).toContainEqual(["docker", "network", "rm", "ork-owner-reach-old-net"]);
  });

  test("a refused stale network does not skip later networks or the host check", async () => {
    const refused = "ork-owner-reach-attached-net";
    const later = "ork-owner-reach-old-net";
    const runner = fakeRunner({
      labelledNetworks: [refused, later],
      onCall: async (call) => {
        if (call[1] === "network" && call[2] === "rm" && call[3] === refused) {
          throw new Error("active endpoints");
        }
      },
    });
    const { svc } = service({ runner });
    expect((await svc.check("boot")).status).toBe("reachable");
    expect(runner.calls).toContainEqual(["docker", "network", "rm", later]);
  });

  test("stale network listing failure leaves host checking best effort", async () => {
    const runner = fakeRunner({
      onCall: async (call) => {
        if (
          call[1] === "network" &&
          call[2] === "ls" &&
          call.some((arg) => arg.startsWith("label="))
        ) {
          throw new Error("listing unavailable");
        }
      },
    });
    const { svc } = service({ runner });
    expect((await svc.check("boot")).status).toBe("reachable");
    expect(runner.calls.filter((call) => call[1] === "run")).toHaveLength(2);
  });
});

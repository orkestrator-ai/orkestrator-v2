import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getHostPort } from "../src/core/commands-container-exec";
import {
  parseNetworkModeOwner,
  rememberNetworkOwner,
  resetNetworkOwnerCache,
} from "../src/core/container-network-owner";
import {
  createEgressGateway,
  egressEnforcement,
  egressGatewayCreateArguments,
  egressGatewayName,
  parseDockerCreatedAt,
  prepareEgressGatewayForStart,
  removeRuntimeContainer,
  stopRuntimeContainer,
  sweepOrphanEgressGateways,
  waitForEgressGatewayFirewall,
  type EgressGatewaySpec,
} from "../src/core/egress-gateway";
import { tempDir, withDockerScript } from "./container-lifecycle-fixtures";

const GATEWAY = "a".repeat(64);
const OWNER = "0123456789abcdef";
const cleanup: string[] = [];

afterEach(async () => {
  resetNetworkOwnerCache();
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * A fake daemon with one workload (`wl`) joined to one gateway. State lives in
 * files so `docker start`/`stop` change what later inspects report.
 */
async function fakeDaemon(options: {
  gateway?: "present" | "missing";
  gatewayRunning?: boolean;
  workloadRunning?: boolean;
  /** Firewall report the gateway serves once it runs. */
  firewall?: string;
  gatewayStartedAt?: string;
  workloadStartedAt?: string;
  gatewayOwner?: string;
  inspectFailsOnce?: boolean;
  firewallAfterRestart?: string;
  /** Polls that find no report before the firewall shows; then the gateway exits if `exitInstead`. */
  pendingPolls?: number;
  exitInstead?: boolean;
}): Promise<string> {
  const dir = await tempDir("ork-egress-daemon-");
  cleanup.push(dir);
  await fs.writeFile(path.join(dir, "gw-running"), options.gatewayRunning ? "true" : "false");
  await fs.writeFile(path.join(dir, "wl-running"), options.workloadRunning ? "true" : "false");
  const gatewayInspect =
    options.gateway === "missing"
      ? `echo "Error: No such object: ${GATEWAY}" >&2; exit 1`
      : `printf '${GATEWAY}\\t%s\\t${options.gatewayStartedAt ?? "2026-10-25T10:00:00Z"}\\t${options.gatewayOwner ?? OWNER}\\tegress-gateway\\twl-name\\tenv-1\\n' "$(cat ${dir}/gw-running)"`;
  return `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  *"{{.HostConfig.NetworkMode}} wl")
    if [ "${options.inspectFailsOnce ?? false}" = true ] && [ ! -e ${dir}/inspected ]; then
      touch ${dir}/inspected; echo 'daemon transport failed' >&2; exit 1
    fi
    printf 'container:${GATEWAY}\\n' ;;
  *"{{.HostConfig.NetworkMode}}"*) printf 'bridge\\n' ;;
  "inspect --type container --format {{.State.Running}}"*" wl") printf '%s\\t${options.workloadStartedAt ?? "2026-10-25T11:00:00Z"}\\n' "$(cat ${dir}/wl-running)" ;;
  *"--format {{.Id}}"*) ${gatewayInspect} ;;
  "start ${GATEWAY}") printf true > ${dir}/gw-running ;;
  "restart ${GATEWAY}") printf true > ${dir}/gw-running; touch ${dir}/restarted ;;
  "stop ${GATEWAY}") printf false > ${dir}/gw-running ;;
  "stop wl") printf false > ${dir}/wl-running ;;
  "exec ${GATEWAY} sh -c"*)
    if [ "$(cat ${dir}/gw-running)" != true ]; then
      echo "Error response from daemon: container ${GATEWAY} is not running" >&2; exit 1
    fi
    polls=$(( $(cat ${dir}/polls 2>/dev/null || echo 0) + 1 )); printf '%s' "$polls" > ${dir}/polls
    if [ "$polls" -le ${options.pendingPolls ?? 0} ]; then exit 0; fi
    if [ "${options.exitInstead ?? false}" = true ]; then printf false > ${dir}/gw-running; exit 0; fi
    if [ -e ${dir}/restarted ]; then printf '%s' '${options.firewallAfterRestart ?? options.firewall ?? '{"state":"applied"}'}';
    else printf '%s' '${options.firewall ?? '{"state":"applied"}'}'; fi ;;
  "port ${GATEWAY} 4097/tcp") printf '127.0.0.1:49200\\n' ;;
  "port wl 4097/tcp") ;;
esac
exit 0
`;
}

describe("where a runtime's firewall runs", () => {
  test("a gateway needs restricted mode, the environment network and a gateway image", () => {
    const base = {
      networkMode: "restricted" as const,
      networkPolicy: 3 as const,
      imageGatewayVersion: 1,
      override: undefined,
    };
    expect(egressEnforcement(base)).toBe("gateway");
    expect(egressEnforcement({ ...base, networkMode: "full" })).toBe("none");
    expect(egressEnforcement({ ...base, imageGatewayVersion: 0 })).toBe("container");
    expect(egressEnforcement({ ...base, networkPolicy: 1 })).toBe("container");
    expect(egressEnforcement({ ...base, networkPolicy: 2 })).toBe("gateway");
    expect(egressEnforcement({ ...base, override: "in-container" })).toBe("container");
    expect(egressEnforcement({ ...base, override: "anything-else" })).toBe("gateway");
  });

  test("names and creation arguments", () => {
    expect(egressGatewayName("ork-x-env-g2")).toBe("ork-x-env-g2-egress");
    expect(egressGatewayName("w".repeat(200))).toHaveLength(127);
    const spec: EgressGatewaySpec = {
      name: "ork-x-env-egress",
      workloadName: "ork-x-env",
      environmentId: "env",
      owner: OWNER,
      image: "sha256:abc",
      network: "ork-net",
      publishArguments: ["-p", "127.0.0.1::4097/tcp"],
      addHostGateway: true,
      githubSeed: null,
      policyEnvironment: { NETWORK_MODE: "restricted" },
      limits: { memory: true, pids: false },
      logArguments: ["--log-driver", "local"],
    };
    const args = egressGatewayCreateArguments(spec).join(" ");
    expect(args).toContain("--memory 128m --memory-swap 128m");
    expect(args).not.toContain("--pids-limit");
    expect(args).toContain("--add-host host.docker.internal:host-gateway");
    expect(args).not.toContain("github-ranges");
    expect(args).toContain("--log-driver local");
    expect(args.endsWith("-e NETWORK_MODE=restricted sha256:abc")).toBe(true);
    expect(
      egressGatewayCreateArguments({ ...spec, addHostGateway: false }).join(" "),
    ).not.toContain("--add-host");
    // Rootless: RootlessKit's host address once the reachability check chose it.
    expect(
      egressGatewayCreateArguments({ ...spec, hostAliasTarget: "10.0.2.2" }).join(" "),
    ).toContain("--add-host host.docker.internal:10.0.2.2");
    // The seed is copied in after creation, even when there is one.
    expect(
      egressGatewayCreateArguments({ ...spec, githubSeed: "/data/github-ranges.txt" }).join(" "),
    ).not.toContain("github-ranges");
  });

  test("parsers accept only what Docker reports", () => {
    expect(parseNetworkModeOwner(`container:${GATEWAY}\n`)).toBe(GATEWAY);
    expect(parseNetworkModeOwner("container:short")).toBeNull();
    expect(parseNetworkModeOwner("bridge")).toBeNull();
    expect(parseNetworkModeOwner("ork-net")).toBeNull();
    expect(parseDockerCreatedAt("2026-10-25 10:11:12 +0000 UTC")).toBe(
      Date.parse("2026-10-25T10:11:12Z"),
    );
    expect(parseDockerCreatedAt("2026-10-25 12:11:12 +0200 CEST")).toBe(
      Date.parse("2026-10-25T10:11:12Z"),
    );
    expect(Number.isNaN(parseDockerCreatedAt("yesterday"))).toBe(true);
  });
});

describe("starting a runtime behind its gateway", () => {
  for (const failure of ["transport", "malformed"] as const) {
    test(`a failed exec surfaces a ${failure} inspection failure without polling to a policy timeout`, async () => {
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  exec) echo 'exec unavailable' >&2; exit 1 ;;
  inspect) ${failure === "transport" ? "echo 'daemon transport failed' >&2; exit 1" : "echo 'invalid inspect output'"} ;;
esac
`,
        async (log) => {
          await expect(
            waitForEgressGatewayFirewall(GATEWAY, { timeoutMs: 20, pollMs: 1 }),
          ).rejects.toThrow(
            failure === "transport"
              ? "daemon transport failed"
              : "Unrecognized docker inspect output",
          );
          const calls = (await log.read()).trim().split("\n");
          expect(calls).toHaveLength(2);
          expect(calls[0]).toStartWith(`exec ${GATEWAY}`);
          expect(calls[1]).toStartWith("inspect ");
        },
      );
    });
  }

  for (const outcome of ["applied", "failed"] as const) {
    test(`the gateway's ${outcome} report is seen within one bounded read`, async () => {
      const dir = await tempDir("ork-egress-report-");
      cleanup.push(dir);
      const report = path.join(dir, "firewall.json");
      await fs.writeFile(report, '{"mode":"restricted"}\n');
      // Written aside and renamed, as init-firewall.sh does.
      setTimeout(() => {
        void fs
          .writeFile(`${report}.tmp`, `{"mode":"restricted","state":"${outcome}"}\n`)
          .then(() => fs.rename(`${report}.tmp`, report));
      }, 300);
      // The fake gateway runs the read it is handed against a host directory.
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$1" >> "$FAKE_DOCKER_LOG"
[ "$1" = exec ] || exit 0
exec sh -c "$(printf '%s' "$5" | sed 's#/run/orkestrator-firewall#${dir}#g')"
`,
        async (log) => {
          const started = performance.now();
          const waited = waitForEgressGatewayFirewall(GATEWAY);
          if (outcome === "applied") await waited;
          else await expect(waited).rejects.toThrow("could not apply its network policy");
          expect(performance.now() - started).toBeLessThan(1_500);
          expect((await log.read()).trim().split("\n")).toEqual(["exec"]);
        },
      );
    });
  }

  test("early unfinished gateway responses are spaced by pollMs", async () => {
    await withDockerScript(
      await fakeDaemon({ gatewayRunning: true, pendingPolls: 2 }),
      async (log) => {
        const started = performance.now();
        await waitForEgressGatewayFirewall(GATEWAY, { pollMs: 150, timeoutMs: 2_000 });
        expect(performance.now() - started).toBeGreaterThanOrEqual(290);
        const calls = (await log.read()).trim().split("\n");
        expect(calls).toHaveLength(3);
        expect(calls.every((line) => line.startsWith(`exec ${GATEWAY}`))).toBe(true);
      },
    );
  });

  test("a runtime without a gateway is left to the normal start", async () => {
    await withDockerScript(await fakeDaemon({}), async (log) => {
      expect(await prepareEgressGatewayForStart("other")).toBe("none");
      expect(await log.read()).not.toContain("start ");
    });
  });

  test("a stopped gateway starts first and the runtime waits for its firewall", async () => {
    await withDockerScript(await fakeDaemon({ gatewayRunning: false }), async (log) => {
      expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("ready");
      const calls = (await log.read()).split("\n");
      const started = calls.indexOf(`start ${GATEWAY}`);
      expect(started).toBeGreaterThan(-1);
      expect(calls.findIndex((line) => line.startsWith(`exec ${GATEWAY}`))).toBeGreaterThan(
        started,
      );
      expect(calls).not.toContain("start wl");
    });
  });

  test("a poll before the firewall applies costs one call, and a stopped gateway is reported", async () => {
    await withDockerScript(
      await fakeDaemon({ gatewayRunning: false, pendingPolls: 3 }),
      async (log) => {
        expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("ready");
        const calls = (await log.read()).split("\n");
        expect(calls.filter((line) => line.startsWith(`exec ${GATEWAY}`))).toHaveLength(4);
        // Only the lookup before the start inspects the gateway.
        expect(
          calls.filter((line) => line.startsWith("inspect") && line.endsWith(GATEWAY)),
        ).toHaveLength(1);
      },
    );
    resetNetworkOwnerCache();
    await withDockerScript(
      await fakeDaemon({ gatewayRunning: false, pendingPolls: 1, exitInstead: true }),
      async () => {
        await expect(prepareEgressGatewayForStart("wl", { pollMs: 1 })).rejects.toThrow(
          "stopped before applying its network policy",
        );
      },
    );
  });

  test("a running gateway's applied firewall is read once, and a just-created runtime is not inspected", async () => {
    rememberNetworkOwner("wl", GATEWAY);
    await withDockerScript(await fakeDaemon({ gatewayRunning: true }), async (log) => {
      expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("ready");
      const calls = (await log.read()).split("\n");
      expect(calls.filter((line) => line.startsWith(`exec ${GATEWAY}`))).toHaveLength(1);
      expect(calls.some((line) => line.includes("{{.HostConfig.NetworkMode}}"))).toBe(false);
      expect(calls).not.toContain(`start ${GATEWAY}`);
    });
  });

  test("a gateway whose firewall failed, or that never reports, refuses the start", async () => {
    await withDockerScript(
      await fakeDaemon({ gatewayRunning: true, firewall: '{"state":"failed"}' }),
      async () => {
        await expect(prepareEgressGatewayForStart("wl", { pollMs: 1 })).rejects.toThrow(
          "ContainerLifecycleError:not-ready",
        );
      },
    );
    resetNetworkOwnerCache();
    await withDockerScript(await fakeDaemon({ gatewayRunning: true, firewall: "" }), async () => {
      await expect(
        prepareEgressGatewayForStart("wl", { pollMs: 1, timeoutMs: 20 }),
      ).rejects.toThrow("did not apply its network policy in time");
    });
  });

  test("a new start restarts a failed running gateway once and waits for a fresh report", async () => {
    await withDockerScript(
      await fakeDaemon({
        gatewayRunning: true,
        firewall: '{"state":"failed"}',
        firewallAfterRestart: '{"state":"applied"}',
      }),
      async (log) => {
        expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("ready");
        expect(
          (await log.read()).split("\n").filter((line) => line === `restart ${GATEWAY}`),
        ).toHaveLength(1);
      },
    );
  });

  test("a missing gateway needs a rebuild rather than an unrestricted start", async () => {
    await withDockerScript(await fakeDaemon({ gateway: "missing" }), async (log) => {
      await expect(prepareEgressGatewayForStart("wl")).rejects.toThrow(
        "ContainerLifecycleError:needs-attention",
      );
      expect(await log.read()).not.toContain("start ");
    });
  });

  test("a runtime left on a gateway's earlier boot is stopped so it rejoins", async () => {
    await withDockerScript(
      await fakeDaemon({
        gatewayRunning: true,
        workloadRunning: true,
        gatewayStartedAt: "2026-10-25T12:00:00Z",
        workloadStartedAt: "2026-10-25T11:00:00Z",
      }),
      async (log) => {
        expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("restarted-gateway");
        const calls = (await log.read()).trim().split("\n");
        const reads = calls.filter((line) => line.startsWith(`exec ${GATEWAY}`));
        expect(reads).toHaveLength(1);
        expect(calls.filter((line) => line === "stop wl")).toHaveLength(1);
        expect(calls.indexOf("stop wl")).toBeGreaterThan(calls.indexOf(reads[0]!));
        expect(calls).not.toContain(`restart ${GATEWAY}`);
        expect(calls).not.toContain(`start ${GATEWAY}`);
      },
    );
    resetNetworkOwnerCache();
    await withDockerScript(
      await fakeDaemon({
        gatewayRunning: true,
        workloadRunning: true,
        gatewayStartedAt: "2026-10-25T10:00:00Z",
        workloadStartedAt: "2026-10-25T11:00:00Z",
      }),
      async (log) => {
        expect(await prepareEgressGatewayForStart("wl", { pollMs: 1 })).toBe("ready");
        expect(await log.read()).not.toContain("stop wl");
      },
    );
  });
});

describe("stopping and removing a runtime with its gateway", () => {
  test("a stop takes the gateway down after the runtime", async () => {
    await withDockerScript(await fakeDaemon({ gatewayRunning: true }), async (log) => {
      await stopRuntimeContainer("wl");
      const calls = (await log.read()).split("\n");
      expect(calls.indexOf("stop wl")).toBeLessThan(calls.indexOf(`stop ${GATEWAY}`));
    });
  });

  test("removal takes only this registry's gateway", async () => {
    await withDockerScript(await fakeDaemon({}), async (log) => {
      await removeRuntimeContainer("wl", OWNER);
      const calls = (await log.read()).split("\n");
      expect(calls.indexOf("rm -f wl")).toBeLessThan(calls.indexOf(`rm -f ${GATEWAY}`));
    });
    resetNetworkOwnerCache();
    await withDockerScript(await fakeDaemon({ gatewayOwner: "someone-else" }), async (log) => {
      await removeRuntimeContainer("wl", OWNER, undefined, { force: false });
      const calls = await log.read();
      expect(calls).toContain("rm wl");
      expect(calls).not.toContain(`rm -f ${GATEWAY}`);
    });
  });

  for (const operation of ["stop", "remove"] as const) {
    test(`${operation} propagates a cold-cache inspect failure, then retries gateway teardown`, async () => {
      await withDockerScript(
        await fakeDaemon({ gatewayRunning: true, inspectFailsOnce: true }),
        async (log) => {
          const teardown = () =>
            operation === "stop" ? stopRuntimeContainer("wl") : removeRuntimeContainer("wl", OWNER);
          await expect(teardown()).rejects.toThrow("daemon transport failed");
          expect(await log.read()).not.toContain(
            `${operation === "stop" ? "stop" : "rm -f"} ${GATEWAY}`,
          );
          if (operation === "remove") expect(await log.read()).not.toContain("rm -f wl");
          await teardown();
          expect(await log.read()).toContain(
            `${operation === "stop" ? "stop" : "rm -f"} ${GATEWAY}`,
          );
        },
      );
    });
  }

  test("a failed gateway removal retains ownership for a retry after the workload is gone", async () => {
    await withDockerScript(await fakeDaemon({}), async (log) => {
      let workloadRemoved = false;
      let attempts = 0;
      const run = async (_command: string, args: string[]) => {
        if (args.at(-1) === "wl") {
          if (workloadRemoved) throw new Error("No such container: wl");
          workloadRemoved = true;
        } else if (++attempts === 1) {
          throw new Error("daemon transport failed");
        }
        return { stdout: "", stderr: "" };
      };
      await expect(removeRuntimeContainer("wl", OWNER, run)).rejects.toThrow(
        "daemon transport failed",
      );
      await removeRuntimeContainer("wl", OWNER, run);
      expect(attempts).toBe(2);
      expect(
        (await log.read()).split("\n").filter((line) => line.includes("HostConfig.NetworkMode")),
      ).toHaveLength(1);
    });
  });

  test("published ports are read from the gateway", async () => {
    await withDockerScript(await fakeDaemon({ gatewayRunning: true }), async () => {
      expect(await getHostPort("wl", 4097)).toBe(49200);
    });
  });
});

describe("orphaned gateways", () => {
  test("only an old gateway whose runtime is gone is removed", async () => {
    const now = Date.parse("2026-10-25T12:00:00Z");
    const old = "2026-10-25 10:00:00 +0000 UTC";
    const young = "2026-10-25 11:58:00 +0000 UTC";
    await withDockerScript(
      `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  "ps -a --no-trunc"*)
    printf '%s\\t%s\\t%s\\t%s\\t\\n' ${"1".repeat(64)} gone-wl env "${old}"
    printf '%s\\t%s\\t%s\\t%s\\t\\n' ${"2".repeat(64)} live-wl env "${old}"
    printf '%s\\t%s\\t%s\\t%s\\t\\n' ${"3".repeat(64)} gone-young env "${young}"
    printf '%s\\t%s\\t%s\\t%s\\torkestrator-v2\\n' ${"4".repeat(64)} gone-wl env "${old}" ;;
  *" gone-wl"|*" gone-young") echo "Error: No such object" >&2; exit 1 ;;
esac
exit 0
`,
      async (log) => {
        expect(await sweepOrphanEgressGateways(OWNER, { now })).toBe(1);
        const removed = (await log.read()).split("\n").filter((line) => line.startsWith("rm "));
        expect(removed).toEqual([`rm -f ${"1".repeat(64)}`]);
      },
    );
  });
});

describe("same-name gateway recovery", () => {
  for (const scenario of [
    "foreign",
    "workload-present",
    "interrupted",
    "ambiguous",
    "inspect-error",
  ] as const) {
    test(scenario, async () => {
      const dir = await tempDir("ork-gateway-conflict-");
      cleanup.push(dir);
      const script = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in
  create*)
    if [ ! -e ${dir}/created ]; then touch ${dir}/created; echo 'name already in use' >&2; exit 1; fi
    echo ${GATEWAY} ;;
  *"--format {{.Id}}"*" gw")
    ${scenario === "inspect-error" ? "echo 'transport failed' >&2; exit 1" : `printf '${GATEWAY}\\tfalse\\t2026-10-25T10:00:00Z\\t${scenario === "foreign" ? "foreign" : OWNER}\\tegress-gateway\\twl-name\\tenv\\n'`} ;;
  *" wl-name")
    ${scenario === "interrupted" ? "echo 'No such container' >&2; exit 1" : scenario === "ambiguous" ? "echo 'transport failed' >&2; exit 1" : `echo ${"b".repeat(64)}`} ;;
esac
`;
      await withDockerScript(script, async (log) => {
        const create = () =>
          createEgressGateway({
            name: "gw",
            workloadName: "wl-name",
            environmentId: "env",
            owner: OWNER,
            image: "image",
            network: "network",
            publishArguments: [],
            addHostGateway: false,
            githubSeed: null,
            policyEnvironment: {},
            limits: { memory: false, pids: false },
            logArguments: [],
          });
        if (scenario === "interrupted") {
          expect(await create()).toBe(GATEWAY);
          expect(await log.read()).toContain(`rm -f ${GATEWAY}`);
        } else {
          await expect(create()).rejects.toThrow();
          expect(await log.read()).not.toContain("rm ");
        }
      });
    });
  }
});

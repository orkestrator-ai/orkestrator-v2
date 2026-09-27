import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import {
  ensureEnvironmentNetwork,
  environmentNetworkName,
  ingressPorts,
  parseFirewallStatus,
  removeEnvironmentNetwork,
} from "../../../apps/backend/src/core/container-network";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function context() {
  const dir = await tempDir("ork-network-");
  cleanup.push(dir);
  return {
    ...memoryLifecycleContext([lifecycleEnvironment()], dir),
    owner: dockerOwnerNamespace(dir),
  };
}

describe("environment networks", () => {
  test("names are valid, bounded and stable per owner and environment", () => {
    const name = environmentNetworkName("0123456789abcdef", "Env/With Spaces");
    expect(name).toMatch(/^ork-0123456789abcdef-[0-9a-f]{16}-net$/);
    expect(environmentNetworkName("0123456789abcdef", "Env/With Spaces")).toBe(name);
    expect(environmentNetworkName("0123456789abcdef", "other")).not.toBe(name);
  });

  test("creates a labelled network and adopts only an exact earlier one", async () => {
    const { context: ctx, owner } = await context();
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  network:inspect) printf 'Error: network x not found\\n' >&2; exit 1 ;;
esac
exit 0
`,
      async (log) => {
        const name = await ensureEnvironmentNetwork(ctx, "env-lifecycle");
        const calls = await log.read();
        expect(calls).toContain(`network create --driver bridge`);
        expect(calls).toContain(`--label orkestrator-owner=${owner}`);
        expect(calls).toContain("--label environment-id=env-lifecycle");
        expect(calls).toContain("--label orkestrator-resource-role=network");
        expect(calls).toContain(name);
      },
    );
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
[ "$1:$2" = network:inspect ] && printf '{"app":"orkestrator-v2","orkestrator-owner":"someone-else"}\\t0\\n'
exit 0
`,
      async (log) => {
        await expect(ensureEnvironmentNetwork(ctx, "env-lifecycle")).rejects.toThrow(
          "ContainerLifecycleError:needs-attention",
        );
        expect(await log.read()).not.toContain("network create");
      },
    );
  });

  test("reports exhausted address pools without falling back", async () => {
    const { context: ctx } = await context();
    await withDockerScript(
      `#!/bin/sh
case "$1:$2" in
  network:inspect) printf 'Error: network x not found\\n' >&2; exit 1 ;;
  network:create) printf 'Error response from daemon: all predefined address pools have been fully subnetted\\n' >&2; exit 1 ;;
esac
exit 0
`,
      async () => {
        await expect(ensureEnvironmentNetwork(ctx, "env-lifecycle")).rejects.toThrow(
          "ContainerLifecycleError:resource-exhausted",
        );
      },
    );
  });

  test("removes only an unattached network of this environment", async () => {
    const { context: ctx, owner } = await context();
    const labels = `{"app":"orkestrator-v2","orkestrator-owner":"${owner}","environment-id":"env-lifecycle","orkestrator-resource-role":"network"}`;
    for (const [attached, foreign, expected] of [
      ["1", false, "in-use"],
      ["0", true, "foreign"],
      ["0", false, "removed"],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
[ "$1:$2" = network:inspect ] && printf '%s\\t${attached}\\n' '${foreign ? '{"app":"orkestrator-v2"}' : labels}'
exit 0
`,
        async (log) => {
          expect(await removeEnvironmentNetwork(ctx, "env-lifecycle")).toBe(expected);
          expect((await log.read()).includes("network rm")).toBe(expected === "removed");
        },
      );
    }
  });

  test("derives ingress ports from publish arguments", () => {
    expect(
      ingressPorts([
        "-p",
        "127.0.0.1:3000:3000/tcp",
        "-p",
        "127.0.0.1::4096/tcp",
        "-p",
        "127.0.0.1::5353/udp",
        "--name",
        "x",
      ]),
    ).toEqual([3000, 4096]);
  });

  test("parses only a well-formed firewall report", () => {
    expect(
      parseFirewallStatus(
        '{"policy":2,"mode":"restricted","state":"applied","appliedAt":"2026-09-27T00:00:00Z","resolvedDomains":3,"unresolvedDomains":1,"allowedEntries":40,"hostServicePorts":"41234","ipv6":"blocked"}',
      ),
    ).toEqual({
      mode: "restricted",
      state: "applied",
      appliedAt: "2026-09-27T00:00:00Z",
      resolvedDomains: 3,
      unresolvedDomains: 1,
      allowedEntries: 40,
      hostServicePorts: "41234",
      ipv6: "blocked",
      githubRanges: null,
    });
    expect(parseFirewallStatus("not json")).toBeNull();
    expect(parseFirewallStatus('{"mode":"open"}')).toBeNull();
    expect(
      parseFirewallStatus('{"mode":"restricted","hostServicePorts":"1;rm"}')?.hostServicePorts,
    ).toBeNull();
  });
});

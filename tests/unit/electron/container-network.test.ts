import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  allowedDomainsArgument,
  allowedDomainsRevision,
  applyEnvironmentAllowedDomains,
  configuredAllowedDomains,
  ensureEnvironmentNetwork,
  environmentNetworkName,
  ingressPorts,
  parseFirewallStatus,
  removeEnvironmentNetwork,
} from "../../../apps/backend/src/core/container-network";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { resetImageManifestCache } from "../../../apps/backend/src/core/docker-image";
import { environmentSnapshot } from "../../../apps/backend/src/core/public-api/actions-settings";
import { defaultConfig } from "../../../apps/backend/src/core/storage-shared";
import {
  lifecycleEnvironment,
  memoryLifecycleContext,
  tempDir,
  withDockerScript,
} from "./container-lifecycle-fixtures";

const cleanup: string[] = [];
test("public environment settings report inherited domains when the saved list is empty", async () => {
  const config = defaultConfig();
  config.global.allowedDomains = ["global.example"];
  const environment = lifecycleEnvironment({ allowedDomains: [] });
  const snapshot = await environmentSnapshot(environment, {
    command: { storage: { loadConfig: async () => config } },
  } as never);
  const domains = snapshot.settings.find((setting) => setting.key === "allowedDomains");
  expect(domains).toMatchObject({ value: [], effective: ["global.example"], source: "global" });
});
afterEach(async () => {
  resetImageManifestCache();
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
      domainsRevision: null,
      refreshedAt: null,
      nextRefreshAt: null,
      carriedDomains: null,
      carriedUntil: null,
      refreshFailures: null,
      revokedEntries: null,
      revocation: null,
    });
    expect(
      parseFirewallStatus(
        '{"mode":"restricted","state":"applied","domainsRevision":"0123456789abcdef","carriedDomains":2,"revocation":"conntrack"}',
      ),
    ).toMatchObject({
      domainsRevision: "0123456789abcdef",
      carriedDomains: 2,
      revocation: "conntrack",
    });
    expect(
      parseFirewallStatus('{"mode":"restricted","domainsRevision":"not-a-digest"}')
        ?.domainsRevision,
    ).toBeNull();
    expect(parseFirewallStatus("not json")).toBeNull();
    expect(parseFirewallStatus('{"mode":"open"}')).toBeNull();
    expect(
      parseFirewallStatus('{"mode":"restricted","hostServicePorts":"1;rm"}')?.hostServicePorts,
    ).toBeNull();
  });
});

const IMAGE_ID = `sha256:${"e".repeat(64)}`;

async function manifestTar(capabilities: Record<string, number>): Promise<string> {
  const dir = await tempDir("ork-network-manifest-");
  cleanup.push(dir);
  await fs.writeFile(
    path.join(dir, "image-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: "2.17.0",
      sourceRevision: "b27421dcfa8de61b9c20a08e79efd7dfbd0c7fc2",
      architecture: "amd64",
      runtimes: {},
      agents: {},
      bridges: [],
      capabilities,
      stateFormats: {},
    }),
  );
  const tarPath = path.join(dir, "out.tar");
  expect(spawnSync("tar", ["-cf", tarPath, "-C", dir, "image-manifest.json"]).status).toBe(0);
  return tarPath;
}

async function allowlistContext(allowedDomains: string[] | undefined) {
  const dir = await tempDir("ork-network-apply-");
  cleanup.push(dir);
  const memory = memoryLifecycleContext(
    [lifecycleEnvironment({ containerId: "container-1", allowedDomains })],
    dir,
  );
  (memory.context.storage as unknown as { loadConfig: () => Promise<unknown> }).loadConfig =
    async () => ({ global: { allowedDomains: ["global.example"], enabledAgentPlatforms: [] } });
  return { ...memory, dir };
}

/**
 * A running policy-2 container whose firewall reports `before` until the
 * backend applies a list, and `after` once it has.
 */
function allowlistDocker(options: {
  tarPath: string;
  running?: boolean;
  before: string;
  after: string;
  marker: string;
}): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  network) printf '172.30.0.0/16\\t172.30.0.1\\n' ;;
  inspect) printf '2\\t${IMAGE_ID}\\t${options.running === false ? "false" : "true"}\\n' ;;
  create) printf 'probe-container\\n' ;;
  cp) cat '${options.tarPath}' ;;
  rm) exit 0 ;;
  exec)
    case "$*" in
      *--set-domains*) : > '${options.marker}' ;;
      *firewall.json*)
        if [ -e '${options.marker}' ]; then rev=${options.after}; else rev=${options.before}; fi
        printf '{"mode":"restricted","state":"applied","domainsRevision":"%s"}\\n' "$rev" ;;
    esac ;;
esac
exit 0
`;
}

describe("allowlist edits in place", () => {
  test("the configured list is the environment's or the global one plus required hosts", () => {
    const config = {
      global: { allowedDomains: ["global.example"], enabledAgentPlatforms: ["pi"] },
    };
    const own = configuredAllowedDomains({ allowedDomains: ["own.example"] }, config as never);
    expect(own[0]).toBe("own.example");
    expect(own).not.toContain("global.example");
    expect(own.length).toBeGreaterThan(1);
    expect(
      configuredAllowedDomains({ allowedDomains: undefined }, {
        global: { allowedDomains: ["global.example"], enabledAgentPlatforms: [] },
      } as never),
    ).toEqual(["global.example"]);
    // An empty environment list means the global list, as the dialog saves it.
    expect(
      configuredAllowedDomains({ allowedDomains: [] }, {
        global: { allowedDomains: ["global.example"], enabledAgentPlatforms: [] },
      } as never),
    ).toEqual(["global.example"]);
    // An empty result is sent as none to images that understand it.
    expect(allowedDomainsArgument([], true)).toBe("none");
    expect(allowedDomainsArgument([], false)).toBe("");
    expect(allowedDomainsArgument(["a.example", "b.example"], true)).toBe("a.example,b.example");
    expect(allowedDomainsRevision(["a.example", "b.example"])).toMatch(/^[0-9a-f]{16}$/);
    expect(allowedDomainsRevision(["a.example", "b.example"])).not.toBe(
      allowedDomainsRevision(["b.example", "a.example"]),
    );
  });

  test("a saved list the container does not enforce is applied through the firewall script", async () => {
    const { context, dir } = await allowlistContext(["one.example", "two.example"]);
    const tarPath = await manifestTar({ "network-policy": 2, "network-refresh": 1 });
    const configured = allowedDomainsRevision(["one.example", "two.example"]);
    await withDockerScript(
      allowlistDocker({
        tarPath,
        before: allowedDomainsRevision(["one.example"]),
        after: configured,
        marker: path.join(dir, "applied"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("applied");
        expect(result.policy.domains).toBe("applied");
        expect(result.policy.configured.domainsRevision).toBe(configured);
        // The environment's network, as Docker reports it.
        expect(result.policy.network).toMatchObject({
          subnet: "172.30.0.0/16",
          gateway: "172.30.0.1",
        });
        expect(await log.read()).toContain(
          "exec --user root container-1 /usr/local/bin/update-firewall.sh --set-domains one.example,two.example",
        );
      },
    );
  });

  test("an image without in-place updates, or a stopped container, is left as it is", async () => {
    const { context, dir } = await allowlistContext(["one.example"]);
    const legacy = await manifestTar({ "network-policy": 2 });
    await withDockerScript(
      allowlistDocker({
        tarPath: legacy,
        before: allowedDomainsRevision(["old.example"]),
        after: allowedDomainsRevision(["one.example"]),
        marker: path.join(dir, "applied-legacy"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("rebuild-required");
        expect(result.policy.domains).toBe("rebuild-required");
        expect(await log.read()).not.toContain("--set-domains");
      },
    );
    resetImageManifestCache();
    const capable = await manifestTar({ "network-policy": 2, "network-refresh": 1 });
    await withDockerScript(
      allowlistDocker({
        tarPath: capable,
        running: false,
        before: allowedDomainsRevision(["old.example"]),
        after: allowedDomainsRevision(["one.example"]),
        marker: path.join(dir, "applied-stopped"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("not-running");
        expect(await log.read()).not.toContain("--set-domains");
      },
    );
  });

  test("a list already enforced is not applied again", async () => {
    const { context, dir } = await allowlistContext(undefined);
    const tarPath = await manifestTar({ "network-policy": 2, "network-refresh": 1 });
    const current = allowedDomainsRevision(["global.example"]);
    await withDockerScript(
      allowlistDocker({ tarPath, before: current, after: current, marker: path.join(dir, "m") }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("applied");
        expect(await log.read()).not.toContain("--set-domains");
      },
    );
  });
});

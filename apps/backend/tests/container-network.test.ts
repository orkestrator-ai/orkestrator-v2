import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  allowedDomainsArgument,
  allowedDomainsRevision,
  applyEnvironmentAllowedDomains,
  configuredAllowedDomains,
  containerNetworkPolicy,
  ensureEnvironmentNetwork,
  environmentNetworkName,
  environmentNetworkPolicy,
  FIREWALL_STATUS_READ,
  ingressPorts,
  parseEgressRefusals,
  parseFirewallReport,
  parseFirewallStatus,
  removeEnvironmentNetwork,
} from "../src/core/container-network";
import { subscribeDockerNetworkChanges } from "../src/core/docker-network-changes";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { resetImageManifestCache } from "../src/core/docker-image";
import {
  BlockedRegistryWriter,
  RegistrySchemaBlockedError,
} from "../src/core/registry-writer-lease";
import { environmentSnapshot } from "../src/core/public-api/actions-settings";
import { defaultConfig } from "../src/core/storage-shared";
import { containerNetworkView } from "../src/core/commands-registry-mcp";
import { urlReachabilityWarning } from "../src/core/mcp-management/network-hints";
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
    dir,
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

  for (const mode of ["create", "adopt", "ambiguous-create"] as const) {
    test(`${mode} reports the environment network change`, async () => {
      const { context: ctx, owner, dir } = await context();
      const labels = JSON.stringify({
        app: "orkestrator-v2",
        "orkestrator-owner": owner,
        "environment-id": "env-lifecycle",
        "orkestrator-resource-role": "network",
      });
      let changes = 0;
      const unsubscribe = subscribeDockerNetworkChanges(() => {
        changes += 1;
      });
      try {
        await withDockerScript(
          `#!/bin/sh
case "$1:$2" in
 network:inspect)
   if [ "${mode}" = adopt ] || [ -f "${dir}/created" ]; then
     printf '%s\\t0\\n' '${labels}'
   else
     echo 'No such network' >&2; exit 1
   fi ;;
 network:create)
   touch "${dir}/created"
   [ "${mode}" != ambiguous-create ] || exit 1 ;;
esac
exit 0
`,
          async () => {
            await ensureEnvironmentNetwork(ctx, "env-lifecycle");
            expect(changes).toBe(1);
          },
        );
      } finally {
        unsubscribe();
      }
    });
  }

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
          let changes = 0;
          const unsubscribe = subscribeDockerNetworkChanges(() => {
            changes += 1;
          });
          try {
            expect(await removeEnvironmentNetwork(ctx, "env-lifecycle")).toBe(expected);
            expect((await log.read()).includes("network rm")).toBe(expected === "removed");
            expect(changes).toBe(expected === "removed" ? 1 : 0);
          } finally {
            unsubscribe();
          }
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
      // A report from an image before the gateway's name checks has no field:
      // addresses only, which the status shows rather than implying checks.
      egressFilter: null,
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
    for (const value of ["enforced", "off", "unavailable"] as const) {
      expect(
        parseFirewallStatus(`{"mode":"restricted","egressFilter":"${value}"}`)?.egressFilter,
      ).toBe(value);
    }
    expect(
      parseFirewallStatus('{"mode":"restricted","egressFilter":"maybe"}')?.egressFilter,
    ).toBeNull();
  });

  test("reads the name checks' refusal counts only as two bounded numbers", () => {
    expect(parseEgressRefusals('{"refusedConnections":3,"refusedQueries":2}\n')).toEqual({
      connections: 3,
      queries: 2,
    });
    for (const text of [
      "",
      "not json",
      "null",
      '{"refusedConnections":3}',
      '{"refusedConnections":-1,"refusedQueries":2}',
      '{"refusedConnections":1.5,"refusedQueries":2}',
      '{"refusedConnections":"3","refusedQueries":2}',
      `{"refusedConnections":1,"refusedQueries":1,"pad":"${"x".repeat(300)}"}`,
    ]) {
      expect(parseEgressRefusals(text)).toBeNull();
    }
  });

  test("the firewall report read returns the counts beside an enforcing gateway's report", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-firewall-read-"));
    try {
      const read = FIREWALL_STATUS_READ.replaceAll("/run/", `${root}/`);
      const run = () => spawnSync("sh", ["-c", read], { encoding: "utf8" });
      // No report at all (a stopped or failed firewall): nothing to show.
      expect(run().status).toBe(0);
      expect(parseFirewallReport(run().stdout)).toBeNull();

      await fs.mkdir(path.join(root, "orkestrator-firewall"));
      const report = path.join(root, "orkestrator-firewall", "firewall.json");
      const counts = path.join(root, "orkestrator-firewall", "egress-refusals.json");
      await fs.writeFile(
        report,
        '{"mode":"restricted","state":"applied","egressFilter":"enforced"}\n',
      );
      // A gateway from before the counts: the checks run, the counts are unknown.
      expect(parseFirewallReport(run().stdout)).toMatchObject({
        egressFilter: "enforced",
        refusals: null,
      });
      await fs.writeFile(counts, '{"refusedConnections":4,"refusedQueries":7}\n');
      expect(parseFirewallReport(run().stdout)).toMatchObject({
        state: "applied",
        egressFilter: "enforced",
        refusals: { connections: 4, queries: 7 },
      });
      // Counts are kept only where the name checks are enforced.
      await fs.writeFile(report, '{"mode":"restricted","state":"applied","egressFilter":"off"}\n');
      expect(parseFirewallReport(run().stdout)?.refusals).toBeNull();
      // A report without a trailing newline still parses.
      await fs.writeFile(
        report,
        '{"mode":"restricted","state":"applied","egressFilter":"enforced"}',
      );
      expect(parseFirewallReport(run().stdout)?.refusals).toEqual({ connections: 4, queries: 7 });
      // The output of an older read, with no separator, has no counts.
      expect(
        parseFirewallReport('{"mode":"restricted","state":"applied","egressFilter":"enforced"}'),
      ).toMatchObject({ refusals: null });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
  expect(
    spawnSync("tar", ["--format=ustar", "-cf", tarPath, "-C", dir, "image-manifest.json"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    }).status,
  ).toBe(0);
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

describe("MCP runtime network hints", () => {
  test("a kept policy-1 runtime uses its label even on a policy-3 image", async () => {
    const { context } = await allowlistContext(["one.example", "db.example:8080"]);
    const tarPath = await manifestTar({ "network-policy": 3 });
    const environment = await context.storage.getEnvironment("env-lifecycle");
    await context.storage.updateEnvironment("env-lifecycle", {
      containerLifecycle: {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        runtime: {
          containerId: "container-1",
          runtimeGeneration: 1,
          owner: "test",
          imageId: IMAGE_ID,
        },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      },
    });
    expect(environment?.containerId).toBe("container-1");
    for (const label of ["1", "2", "3", "<no value>"]) {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  inspect) case "$*" in *orkestrator-debian-archive*) printf '<no value>\\n' ;; *) printf '${label}\\n' ;; esac ;;
  create) printf 'probe-container\\n' ;;
  cp) cat '${tarPath}' ;;
esac
`,
        async () => {
          const view = await containerNetworkView(context)("env-lifecycle");
          const policyVersion = label === "<no value>" ? 3 : Number(label);
          expect(view).toEqual({
            mode: "restricted",
            policyVersion,
            allowedDomains:
              policyVersion < 3
                ? ["one.example", "db.example"]
                : ["one.example", "db.example:8080"],
          });
          expect(urlReachabilityWarning("https://one.example:8080/mcp", view) === undefined).toBe(
            policyVersion < 3,
          );
        },
      );
    }
  });

  test("a runtime labelled for Debian's archive lists deb.debian.org (to-do 7770)", async () => {
    const { context } = await allowlistContext(["one.example"]);
    await context.storage.updateEnvironment("env-lifecycle", {
      containerLifecycle: {
        schemaVersion: 1,
        revision: 1,
        lastRuntimeGeneration: 1,
        runtime: {
          containerId: "container-1",
          runtimeGeneration: 1,
          owner: "test",
          imageId: IMAGE_ID,
        },
        storage: { format: "legacy-layer", workspaceGeneration: 1 },
        outcomes: [],
      },
    });
    for (const [archiveLabel, expected] of [
      ["1", ["one.example", "deb.debian.org"]],
      ["0", ["one.example"]],
      ["<no value>", ["one.example"]],
    ] as const) {
      await withDockerScript(
        `#!/bin/sh
case "$1" in
  inspect) case "$*" in *orkestrator-debian-archive*) printf '${archiveLabel}\\n' ;; *) printf '3\\n' ;; esac ;;
esac
`,
        async () => {
          const view = await containerNetworkView(context)("env-lifecycle");
          expect(view).toEqual({
            mode: "restricted",
            policyVersion: 3,
            allowedDomains: [...expected],
          });
          expect(urlReachabilityWarning("https://deb.debian.org/debian", view) === undefined).toBe(
            archiveLabel === "1",
          );
        },
      );
    }
  });
});

/**
 * A running policy-2 container whose firewall reports `before` until the
 * backend applies a list, and `after` once it has.
 */
function allowlistDocker(options: {
  tarPath: string;
  running?: boolean;
  runningMarker?: string;
  mirror?: boolean;
  debianArchive?: boolean;
  gitUrl?: string;
  statusUnavailable?: boolean;
  policy?: 2 | 3;
  before: string;
  after: string;
  marker: string;
}): string {
  return `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  network) printf '172.30.0.0/16\\t172.30.0.1\\n' ;;
  inspect) ${options.runningMarker ? `if [ -e '${options.runningMarker}' ]; then running=true; else running=false; fi` : `running=${options.running === false ? "false" : "true"}`}
    printf '${options.policy ?? 2}\\t${IMAGE_ID}\\t%s\\t${options.mirror ? "mirror" : ""}\\t${options.debianArchive ? "1" : ""}\\nGIT_URL=${options.gitUrl ?? "https://git.example.com/project.git"}\\n' "$running" ;;
  create) printf 'probe-container\\n' ;;
  cp) cat '${options.tarPath}' ;;
  rm) exit 0 ;;
  exec)
    case "$*" in
      *--set-domains*) : > '${options.marker}' ;;
      *firewall.json*)
        ${options.statusUnavailable ? "exit 1" : ":"}
        if [ -e '${options.marker}' ]; then rev=${options.after}; else rev=${options.before}; fi
        printf '{"mode":"restricted","state":"applied","domainsRevision":"%s"}\\n' "$rev" ;;
    esac ;;
esac
exit 0
`;
}

describe("Debian's archive for declared packages (to-do 7770)", () => {
  test("only a runtime created to install packages has deb.debian.org in its list", () => {
    const config = { global: { allowedDomains: ["global.example"], enabledAgentPlatforms: [] } };
    expect(configuredAllowedDomains({ allowedDomains: [] }, config as never)).toEqual([
      "global.example",
    ]);
    expect(
      configuredAllowedDomains({ allowedDomains: [] }, config as never, { debianArchive: true }),
    ).toEqual(["global.example", "deb.debian.org"]);
    // A saved list that already names it is not doubled.
    expect(
      configuredAllowedDomains({ allowedDomains: ["deb.debian.org"] }, config as never, {
        debianArchive: true,
      }),
    ).toEqual(["deb.debian.org"]);
  });

  test("a live edit keeps the archive on the runtime labelled for it", async () => {
    const { context, dir } = await allowlistContext(["one.example"]);
    const tarPath = await manifestTar({ "network-policy": 2, "network-refresh": 1 });
    const configured = allowedDomainsRevision(["one.example", "deb.debian.org"]);
    await withDockerScript(
      allowlistDocker({
        tarPath,
        debianArchive: true,
        before: allowedDomainsRevision(["one.example"]),
        after: configured,
        marker: path.join(dir, "applied"),
      }),
      async (log) => {
        const before = await environmentNetworkPolicy("env-lifecycle", context);
        expect(before.configured.domainsRevision).toBe(configured);
        expect(before.domains).toBe("pending");
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("applied");
        expect(await log.read()).toContain("--set-domains one.example,deb.debian.org");
      },
    );
  });
});

describe("allowlist edits in place", () => {
  for (const policy of [2, 3] as const) {
    for (const gitUrl of ["https://github.com/org/repo.git", "https://git.example.com/repo.git"]) {
      test(`policy ${policy} mirrored ${gitUrl} applies unrelated domain removal live and after start`, async () => {
        const initial = ["git.example.com", "other.example"];
        const saved = ["git.example.com"];
        const { context, dir } = await allowlistContext(initial);
        const tarPath = await manifestTar({ "network-policy": policy, "network-refresh": 1 });
        const marker = path.join(dir, "applied");
        const runningMarker = path.join(dir, "running");
        await fs.writeFile(runningMarker, "");
        await withDockerScript(
          allowlistDocker({
            tarPath,
            policy,
            mirror: true,
            gitUrl,
            runningMarker,
            before: allowedDomainsRevision(initial),
            after: allowedDomainsRevision(saved),
            marker,
          }),
          async (log) => {
            expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
              "applied",
            );
            await context.storage.updateEnvironment("env-lifecycle", { allowedDomains: saved });
            expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
              "pending",
            );
            expect((await applyEnvironmentAllowedDomains("env-lifecycle", context)).kind).toBe(
              "applied",
            );
            expect(await log.read()).toContain("--set-domains git.example.com");
            expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
              "applied",
            );

            // Save while stopped, then use the same apply entry point as container start.
            await fs.rm(marker);
            await context.storage.updateEnvironment("env-lifecycle", { allowedDomains: initial });
            await fs.rm(runningMarker);
            await context.storage.updateEnvironment("env-lifecycle", { allowedDomains: saved });
            expect((await applyEnvironmentAllowedDomains("env-lifecycle", context)).kind).toBe(
              "not-running",
            );
            expect(await fs.exists(marker)).toBe(false);
            await fs.writeFile(runningMarker, "");
            const restarted = await applyEnvironmentAllowedDomains("env-lifecycle", context);
            expect(restarted.kind).toBe("applied");
            expect(restarted.policy.effective?.domainsRevision).toBe(allowedDomainsRevision(saved));
            expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
              "applied",
            );
          },
        );
      });
    }
  }

  test.each([
    "",
    "file:///old/project",
    "https://unknown.example/repo.git",
    "https://git.example.com:8443/repo.git",
  ])(
    "a mirror with an unverifiable or blocked original remote %s requires rebuild",
    async (gitUrl) => {
      const { context, dir } = await allowlistContext(["git.example.com"]);
      const tarPath = await manifestTar({ "network-policy": 3, "network-refresh": 1 });
      await withDockerScript(
        allowlistDocker({
          tarPath,
          policy: 3,
          mirror: true,
          gitUrl,
          before: allowedDomainsRevision(["other.example"]),
          after: allowedDomainsRevision(["git.example.com"]),
          marker: path.join(dir, "applied"),
        }),
        async (log) => {
          expect((await applyEnvironmentAllowedDomains("env-lifecycle", context)).kind).toBe(
            "rebuild-required",
          );
          expect(await log.read()).not.toContain("--set-domains");
        },
      );
    },
  );

  test.each([2, 3] as const)(
    "policy %i mirror mount requires rebuild after remote revocation",
    async (policy) => {
      const { context, dir } = await allowlistContext(["git.example.com", "other.example"]);
      const tarPath = await manifestTar({ "network-policy": policy, "network-refresh": 1 });
      await withDockerScript(
        allowlistDocker({
          tarPath,
          policy,
          mirror: true,
          before: allowedDomainsRevision(["git.example.com", "other.example"]),
          after: allowedDomainsRevision(["other.example"]),
          marker: path.join(dir, "applied"),
        }),
        async (log) => {
          expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
            "applied",
          );
          // Same save/apply sequence as update_environment_allowed_domains.
          await context.storage.updateEnvironment("env-lifecycle", {
            allowedDomains: ["other.example"],
          });
          const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
          expect(result.kind).toBe("rebuild-required");
          expect(result.policy.domains).toBe("rebuild-required");
          expect(result.policy.effective?.domainsRevision).toBe(
            allowedDomainsRevision(["git.example.com", "other.example"]),
          );
          const calls = await log.read();
          expect(calls).not.toContain("--set-domains");

          // A later snapshot still reports the required rebuild after a missed event.
          expect((await environmentNetworkPolicy("env-lifecycle", context)).domains).toBe(
            "rebuild-required",
          );
        },
      );
    },
  );

  test("a mirror still requires rebuild when the previous firewall status is unreadable", async () => {
    const { context, dir } = await allowlistContext(["other.example"]);
    const tarPath = await manifestTar({ "network-policy": 3, "network-refresh": 1 });
    await withDockerScript(
      allowlistDocker({
        tarPath,
        mirror: true,
        statusUnavailable: true,
        before: allowedDomainsRevision(["git.example.com"]),
        after: allowedDomainsRevision(["other.example"]),
        marker: path.join(dir, "applied"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("rebuild-required");
        expect(result.policy.effective).toBeNull();
        expect(await log.read()).not.toContain("--set-domains");
      },
    );
  });

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
          "exec --env PATH=/usr/sbin:/usr/bin:/sbin:/bin --user root container-1 /usr/local/bin/update-firewall.sh --set-domains one.example,two.example",
        );
      },
    );
  });

  test("a new container gets the newest policy its image implements unless capped", () => {
    expect(containerNetworkPolicy(0, undefined)).toBe(1);
    expect(containerNetworkPolicy(2, undefined)).toBe(2);
    expect(containerNetworkPolicy(3, undefined)).toBe(3);
    expect(containerNetworkPolicy(3, "2")).toBe(2);
    expect(containerNetworkPolicy(2, "3")).toBe(2);
    // The shared-bridge opt-out is gone: a capable image never joins the
    // default bridge, where siblings can reach each other.
    expect(containerNetworkPolicy(3, "1")).toBe(3);
    expect(containerNetworkPolicy(2, "1")).toBe(2);
    expect(containerNetworkPolicy(0, "3")).toBe(1);
  });

  test("ports reach only a policy 3 container; earlier policies get each domain once", async () => {
    const saved = ["one.example", "db.example:5432", "db.example"];
    const { context, dir } = await allowlistContext(saved);
    const tarPath = await manifestTar({ "network-policy": 3, "network-refresh": 1 });
    const tuples = allowedDomainsRevision(saved);
    await withDockerScript(
      allowlistDocker({
        tarPath,
        policy: 3,
        before: allowedDomainsRevision(["one.example"]),
        after: tuples,
        marker: path.join(dir, "applied-v3"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("applied");
        expect(result.policy.policyVersion).toBe(3);
        expect(result.policy.configured.domainsRevision).toBe(tuples);
        expect(await log.read()).toContain("--set-domains one.example,db.example:5432,db.example");
      },
    );
    resetImageManifestCache();
    const domains = allowedDomainsRevision(["one.example", "db.example"]);
    await withDockerScript(
      allowlistDocker({
        tarPath,
        before: allowedDomainsRevision(["one.example"]),
        after: domains,
        marker: path.join(dir, "applied-v2"),
      }),
      async (log) => {
        const result = await applyEnvironmentAllowedDomains("env-lifecycle", context);
        expect(result.kind).toBe("applied");
        expect(result.policy.policyVersion).toBe(2);
        // The revision is of the list this container was sent.
        expect(result.policy.configured.domainsRevision).toBe(domains);
        expect(await log.read()).toContain("--set-domains one.example,db.example\n");
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

  test("a backend without the registry writer saves the list but does not push it", async () => {
    const { context, dir } = await allowlistContext(["one.example", "two.example"]);
    context.registryWriterLease = new BlockedRegistryWriter(
      new RegistrySchemaBlockedError(),
      "schema-incompatible",
    );
    const tarPath = await manifestTar({ "network-policy": 2, "network-refresh": 1 });
    await withDockerScript(
      allowlistDocker({
        tarPath,
        before: allowedDomainsRevision(["one.example"]),
        after: allowedDomainsRevision(["one.example", "two.example"]),
        marker: path.join(dir, "applied-blocked"),
      }),
      async (log) => {
        await expect(applyEnvironmentAllowedDomains("env-lifecycle", context)).rejects.toThrow(
          "ContainerLifecycleError:unsupported-format",
        );
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

describe("recorded host-service ports", () => {
  test.each([
    ["3\n41234\n", 42345, true],
    ["3\n41234,42345\n", 42345, false],
    ["2\n41234\n", 42345, true],
    ["1\n41234\n", 42345, false],
    ["", 42345, false],
    ["3\n41234\n", null, false],
  ])("record %s with service port %s updates: %s", async (record, port, updates) => {
    const { ensureContainerHostServicePorts } = await import("../src/core/commands-environment");
    await withDockerScript(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$*" in *'cat /etc/orkestrator/network-policy'*) printf '%s' '${record}' ;; esac
`,
      async (log) => {
        await ensureContainerHostServicePorts("container-1", port);
        const calls = await log.read();
        expect(
          calls.includes(
            "exec --env PATH=/usr/sbin:/usr/bin:/sbin:/bin --user root container-1 /usr/local/bin/update-firewall.sh --host-ports 42345",
          ),
        ).toBe(updates);
        if (port === null) expect(calls).toBe("");
      },
    );
  });

  test("a failed host-port update rejects before callers can use a stale tools URL", async () => {
    const { ensureContainerHostServicePorts } = await import("../src/core/commands-environment");
    await withDockerScript(
      `#!/bin/sh
case "$*" in *--host-ports*) exit 1 ;; *) printf '3\\n41234\\n' ;; esac
`,
      async () => {
        await expect(ensureContainerHostServicePorts("container-1", 42345)).rejects.toThrow();
      },
    );
  });
});

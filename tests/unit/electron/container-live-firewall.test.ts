/**
 * Real-Docker qualification for allowlist edits, refresh and revocation
 * (plan step 09, scenario C23).
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * Needs outbound access to api.github.com, registry.npmjs.org and example.com.
 * Every resource is labelled with this run's private owner namespace and
 * removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { waitForContainerBoot } from "../../../apps/backend/src/core/container-readiness";
import type { Environment } from "../../../apps/backend/src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `f${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

async function dockerStatus(args: string[], timeoutMs = 60_000): Promise<number> {
  try {
    await runCommand("docker", args, { timeoutMs });
    return 0;
  } catch {
    return 1;
  }
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-firewall-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  const networks = (
    await docker(["network", "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`])
  )
    .split("\n")
    .filter(Boolean);
  if (networks.length > 0) await docker(["network", "rm", ...networks]).catch(() => undefined);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

function firewallContext(environments: Environment[]) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, {
    runtimeFlavor: "agent-test",
    credentialSources: new Set(),
  });
  Object.assign(fixture.context.storage, {
    getProject: async () => ({
      id: "project-1",
      name: "Project",
      gitUrl: "https://example.invalid/none.git",
      localPath: null,
      addedAt: new Date(0).toISOString(),
      order: 0,
    }),
    loadConfig: async () => ({
      version: "1.0.0",
      global: { allowedDomains: ["registry.npmjs.org"], enabledAgentPlatforms: [] },
      repositories: {},
    }),
  });
  return fixture;
}

async function probe(containerId: string, url: string): Promise<number> {
  const out = await docker([
    "exec",
    "-u",
    "node",
    containerId,
    "sh",
    "-c",
    `curl -fsS -o /dev/null --max-time 6 ${url} 2>/dev/null; echo $?`,
  ]);
  return Number(out.split("\n").at(-1));
}

/**
 * Opens one keep-alive HTTP connection to example.com as node, answers a
 * first request, then waits for `/tmp/<tag>.go` and sends a second request on
 * the same socket. `/tmp/<tag>.second` records what happened.
 */
async function openHeldConnection(containerId: string, tag: string): Promise<void> {
  const script = [
    "exec 3<>/dev/tcp/example.com/80 || exit 1",
    "request() { printf 'HEAD / HTTP/1.1\\r\\nHost: example.com\\r\\nConnection: keep-alive\\r\\n\\r\\n' >&3; }",
    "headers() { status=''; while IFS= read -r -t 5 line <&3; do [ -z \"$status\" ] && status=\"$line\"; [ \"$line\" = $'\\r' ] && break; done; printf '%s' \"${status%$'\\r'}\"; }",
    "request",
    `headers > /tmp/${tag}.first`,
    `while [ ! -e /tmp/${tag}.go ]; do sleep 0.1; done`,
    `if ! request 2>/dev/null; then echo write-failed > /tmp/${tag}.second; exit 0; fi`,
    `answer=$(headers); echo "\${answer:-no-answer}" > /tmp/${tag}.second`,
  ].join("\n");
  await docker(["exec", "-d", "-u", "node", containerId, "bash", "-c", script]);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const first = await docker(["exec", containerId, "cat", `/tmp/${tag}.first`]).catch(() => "");
    if (first) {
      expect(first).toStartWith("HTTP/1.1 ");
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("the held connection never answered its first request");
}

async function secondRequest(containerId: string, tag: string): Promise<string> {
  await docker(["exec", "-u", "node", containerId, "touch", `/tmp/${tag}.go`]);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const second = await docker(["exec", containerId, "cat", `/tmp/${tag}.second`]).catch(() => "");
    if (second) return second;
    await Bun.sleep(100);
  }
  return "timeout";
}

/** Waits for a boot; a failed one reports the container's last log lines. */
async function booted(containerId: string): Promise<void> {
  try {
    await waitForContainerBoot(containerId);
  } catch (error) {
    const logs = await docker(["logs", "--tail", "40", containerId]).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

async function refresherPids(containerId: string): Promise<string[]> {
  const out = await docker([
    "exec",
    containerId,
    "sh",
    "-c",
    // The refresher is a root session leader (setsid); its refresh subshells
    // and this probe are not.
    "ps -eo pid=,sid=,uid=,args= | awk '$1 == $2 && $3 == 0 && /update-firewall.sh --refresh-loop/ { print $1 }'",
  ]);
  return out.split("\n").filter(Boolean);
}

describe("C23 allowlist edits, refresh and revocation", () => {
  live(
    "an edit applies in place, revokes removed addresses, survives a restart and never widens on failure",
    async () => {
      const { createDockerContainer } =
        await import("../../../apps/backend/src/core/commands-containers");
      const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
      const { applyEnvironmentAllowedDomains, environmentNetworkPolicy } =
        await import("../../../apps/backend/src/core/container-network");
      const environment = lifecycleEnvironment({
        id: `env-${RUN}`,
        networkAccessMode: "restricted",
        allowedDomains: ["registry.npmjs.org"],
      });
      const { context } = firewallContext([environment]);
      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
      await docker(["start", containerId]);
      await booted(containerId);

      // Booted with the saved list, which it reports by revision.
      let policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(policy.effective?.domainsRevision).toBe(policy.configured.domainsRevision);
      expect(policy.effective?.refreshedAt).toBeTruthy();
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);
      // Resolved addresses carry kernel expiry.
      expect(
        await docker(["exec", "--user", "root", containerId, "ipset", "list", "allowed-domains"]),
      ).toMatch(/^\d+\.\d+\.\d+\.\d+ timeout \d+$/m);

      // One root refresher, which node can neither signal nor duplicate.
      const [refresher] = await refresherPids(containerId);
      expect(refresher).toBeTruthy();
      expect(
        await dockerStatus(["exec", "-u", "node", containerId, "kill", "-TERM", refresher!]),
      ).toBe(1);
      await docker(["exec", "-u", "node", containerId, "sudo", "/usr/local/bin/init-firewall.sh"]);
      expect(await refresherPids(containerId)).toHaveLength(1);
      // node cannot write the firewall's report or schedule.
      expect(
        await dockerStatus([
          "exec",
          "-u",
          "node",
          containerId,
          "sh",
          "-c",
          "echo 1 > /run/orkestrator-firewall/refresh-delay",
        ]),
      ).toBe(1);

      // Saved but not yet applied is reported as pending, then applied in place.
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com"],
      });
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("pending");
      const applied = await applyEnvironmentAllowedDomains(environment.id, context);
      expect(applied.kind).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect(await docker(["exec", containerId, "cat", "/etc/orkestrator/allowed-domains"])).toBe(
        "registry.npmjs.org,example.com",
      );

      // Control: an edit that keeps example.com leaves an open connection alone.
      await openHeldConnection(containerId, "kept");
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com", "bun.sh"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await secondRequest(containerId, "kept")).toStartWith("HTTP/1.1 ");

      // Removing example.com revokes the connection that was already open.
      await openHeldConnection(containerId, "revoked");
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org"],
      });
      const removed = await applyEnvironmentAllowedDomains(environment.id, context);
      expect(removed.kind).toBe("applied");
      expect(removed.policy.effective?.revocation).toBe("conntrack");
      expect(removed.policy.effective?.revokedEntries ?? 0).toBeGreaterThan(0);
      expect(await secondRequest(containerId, "revoked")).not.toStartWith("HTTP/1.1 ");
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);

      // A refresh re-resolves in place and keeps the same list.
      await docker([
        "exec",
        "--user",
        "root",
        containerId,
        "/usr/local/bin/update-firewall.sh",
        "--refresh",
      ]);
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(policy.effective?.refreshFailures).toBe(0);

      // An invalid list is refused and changes nothing.
      expect(
        await dockerStatus([
          "exec",
          "--user",
          "root",
          containerId,
          "/usr/local/bin/update-firewall.sh",
          "--set-domains",
          "example.com;id",
        ]),
      ).toBe(1);
      expect(await docker(["exec", containerId, "cat", "/etc/orkestrator/allowed-domains"])).toBe(
        "registry.npmjs.org",
      );

      // Durable: a restart boots with the applied list, with nothing to re-apply.
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org", "example.com"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      await docker(["restart", "-t", "5", containerId]);
      await booted(containerId);
      policy = await environmentNetworkPolicy(environment.id, context);
      expect(policy.domains).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect(await refresherPids(containerId)).toHaveLength(1);

      // An edit saved while the container is stopped is pending until applied.
      await docker(["stop", "-t", "5", containerId]);
      await context.storage.updateEnvironment(environment.id, {
        allowedDomains: ["registry.npmjs.org"],
      });
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe(
        "not-running",
      );
      await docker(["start", containerId]);
      await booted(containerId);
      expect((await environmentNetworkPolicy(environment.id, context)).domains).toBe("pending");
      expect(await probe(containerId, "https://example.com/")).toBe(0);
      expect((await applyEnvironmentAllowedDomains(environment.id, context)).kind).toBe("applied");
      expect(await probe(containerId, "https://example.com/")).not.toBe(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

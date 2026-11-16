/**
 * Real-Docker qualification for the GitHub ranges seed bind (to-do 7549
 * task 2): a restricted runtime's firewall reads the seed the backend bound
 * into it, and a restart reads the seed as the backend last refreshed it,
 * with no `docker cp` into a stopped container and no fetch of its own.
 *
 * Opt-in: RUN_LIVE_DOCKER_TESTS=1 and ORKESTRATOR_QUALIFICATION_IMAGE=<image>.
 * ORKESTRATOR_LIVE_GITHUB_RANGES_SEED=<file> supplies GitHub's ranges; without
 * it the backend fetches them once, as it would for a first restricted
 * container. Run it against a rootless daemon through `DOCKER_HOST` as well
 * (docs/development/container-qualification.md, "Disposable Docker daemon").
 * Every resource is labelled with this run's private owner namespace and
 * removed by that label afterwards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { networkOwnerContainer } from "../src/core/container-network-owner";
import { stopRuntimeContainer } from "../src/core/egress-gateway";
import { startContainerWithAgentAccounts } from "../src/core/agent-accounts-containers";
import {
  formatGithubRangesSeed,
  githubRangesSeed,
  githubRangesSeedDirectory,
  githubRangesSeedFile,
  readGithubRangesSeed,
} from "../src/core/github-ranges-cache";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";
import { removeLabelledResources } from "./container-live-cleanup";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_LIVE_DOCKER_TESTS === "1" && IMAGE.length > 0;
const live = ENABLED ? test : test.skip;
const RUN = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const LIVE_TIMEOUT_MS = 600_000;
/** TEST-NET-2: marks the refreshed seed; nothing answers there. */
const MARKER_RANGE = "198.51.100.0/24";

let dataDir = "";
let owner = "";

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-github-seed-"));
  owner = dockerOwnerNamespace(dataDir);
});

afterAll(async () => {
  if (!ENABLED) return;
  const leftovers = await removeLabelledResources(docker, [`label=orkestrator-owner=${owner}`]);
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
  expect(leftovers).toEqual([]);
}, 180_000);

function seedContext(environment: ReturnType<typeof lifecycleEnvironment>) {
  const fixture = memoryLifecycleContext([environment], dataDir);
  Object.assign(fixture.context, { runtimeFlavor: "agent-test", credentialSources: new Set() });
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
  return fixture.context;
}

async function firewallReport(
  container: string,
): Promise<{ state?: string; githubRanges?: string }> {
  const text = await docker([
    "exec",
    "--user",
    "root",
    container,
    "sh",
    "-c",
    "head -c 8192 /run/orkestrator-firewall/firewall.json",
  ]);
  return JSON.parse(text) as { state?: string; githubRanges?: string };
}

async function booted(containerId: string): Promise<void> {
  try {
    await waitForContainerBoot(containerId);
  } catch (error) {
    const logs = await docker(["logs", "--tail", "40", containerId]).catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs}`);
  }
}

describe("7549 the GitHub ranges seed is bound, not copied", () => {
  live(
    "a restricted boot reads the bound seed, and a restart reads it as last refreshed",
    async () => {
      const { createDockerContainer } = await import("../src/core/commands-containers");
      const { resolveDockerImage } = await import("../src/core/docker-image");
      const environment = lifecycleEnvironment({
        id: `seed-${RUN}`,
        networkAccessMode: "restricted",
        allowedDomains: ["registry.npmjs.org"],
      });
      const context = seedContext(environment);
      // A workflow seed was copied in by the fixture; otherwise one backend
      // fetch, as for a host's first restricted container.
      const seedFile = githubRangesSeedFile(dataDir);
      if (!(await readGithubRangesSeed(seedFile))) {
        expect(await githubRangesSeed(dataDir)).toBe(seedFile);
      }
      const seeded = await readGithubRangesSeed(seedFile);
      expect(seeded?.ranges.length).toBeGreaterThan(0);

      const resolved = await resolveDockerImage(IMAGE);
      if (resolved.kind !== "present") throw new Error("qualification image missing");
      const containerId = await createDockerContainer(environment, context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
      });
      await context.storage.updateEnvironment(environment.id, { containerId, status: "running" });
      const firewall = await networkOwnerContainer(containerId);

      // The container that runs the firewall binds the seed directory read-only.
      const mounts = JSON.parse(
        await docker(["inspect", "--format", "{{json .Mounts}}", firewall]),
      ) as Array<{ Source: string; Destination: string; RW: boolean }>;
      const seedMount = mounts.find((mount) => mount.Destination === "/etc/orkestrator-seed");
      expect(seedMount?.RW).toBe(false);
      expect(await fs.realpath(seedMount!.Source)).toBe(
        await fs.realpath(githubRangesSeedDirectory(dataDir)),
      );

      await startContainerWithAgentAccounts(context, null, containerId);
      await booted(containerId);
      let report = await firewallReport(firewall);
      expect(report.state).toBe("applied");
      expect(report.githubRanges).toBe("seed");

      // The backend's hourly refresh replaces the file by rename; a stopped
      // container sees the new file at its next boot through the bind.
      await stopRuntimeContainer(containerId);
      const refreshed = [...seeded!.ranges, MARKER_RANGE];
      const temporary = path.join(dataDir, ".seed-refresh.tmp");
      await fs.writeFile(temporary, formatGithubRangesSeed(refreshed, Date.now()), {
        mode: 0o644,
      });
      await fs.rename(temporary, seedFile);

      await startContainerWithAgentAccounts(context, null, containerId);
      await booted(containerId);
      report = await firewallReport(firewall);
      expect(report.state).toBe("applied");
      expect(report.githubRanges).toBe("seed");
      expect(
        await docker(["exec", "--user", "root", firewall, "ipset", "list", "allowed-domains"]),
      ).toContain(MARKER_RANGE);
      // The container could only have read it from the bind: it never copied.
      const events = await docker([
        "events",
        "--since",
        "15m",
        "--until",
        "0s",
        "--filter",
        `container=${firewall}`,
        "--format",
        "{{.Action}}",
      ]);
      expect(events.split("\n")).not.toContain("extract-to-dir");
    },
    LIVE_TIMEOUT_MS,
  );
});

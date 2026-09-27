/**
 * Container performance baselines (containers plan step 13).
 *
 * Opt-in and slow: RUN_CONTAINER_BENCHMARKS=1 and
 * ORKESTRATOR_QUALIFICATION_IMAGE=<image>. Uses synthetic fixtures only, runs
 * with concurrency 1 (and a bounded 3-environment case), and removes every
 * resource it labelled. Results go to output/benchmarks/<run>.json and a table
 * on stdout; nothing here records commands, paths or file contents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { commandInvocationCount, runCommand } from "../../../apps/backend/src/core/shell";
import { dockerOwnerNamespace } from "../../../apps/backend/src/core/docker-ownership";
import { waitForContainerBoot } from "../../../apps/backend/src/core/container-readiness";
import type { Environment } from "../../../apps/backend/src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_CONTAINER_BENCHMARKS === "1" && IMAGE.length > 0;
const bench = ENABLED ? test : test.skip;
const RUN = `b${Date.now().toString(36)}`;
const TIMEOUT = 1_800_000;

let dataDir = "";
let owner = "";
const results: Record<string, unknown> = {};

async function docker(args: string[], timeoutMs = 120_000): Promise<string> {
  return (await runCommand("docker", args, { timeoutMs })).stdout.trim();
}

function summarize(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!;
  return {
    n: sorted.length,
    min: Math.round(sorted[0] ?? 0),
    median: Math.round(at(0.5)),
    p90: Math.round(at(0.9)),
    max: Math.round(sorted.at(-1) ?? 0),
  };
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ ms: number; value: T; dockerCalls: number }> {
  const calls = commandInvocationCount("docker");
  const start = performance.now();
  const value = await fn();
  return {
    ms: performance.now() - start,
    value,
    dockerCalls: commandInvocationCount("docker") - calls,
  };
}

beforeAll(async () => {
  if (!ENABLED) return;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-bench-"));
  owner = dockerOwnerNamespace(dataDir);
  // A small synthetic provider home, staged for every new runtime.
  const home = path.join(dataDir, "fixture-home");
  await fs.mkdir(path.join(home, ".claude", "commands"), { recursive: true });
  await fs.writeFile(path.join(home, ".claude", "CLAUDE.md"), "fixture");
  await fs.writeFile(path.join(home, ".claude", ".credentials.json"), "{}");
  for (let index = 0; index < 50; index += 1) {
    await fs.writeFile(path.join(home, ".claude", "commands", `c${index}.md`), "x".repeat(512));
  }
  process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = path.join(home, ".claude");
  process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = home;
});

afterAll(async () => {
  if (!ENABLED) return;
  const ids = (await docker(["ps", "-aq", "--filter", `label=orkestrator-owner=${owner}`]))
    .split("\n")
    .filter(Boolean);
  if (ids.length > 0) await docker(["rm", "-f", ...ids]).catch(() => undefined);
  for (const kind of ["volume", "network"] as const) {
    const names = (await docker([kind, "ls", "-q", "--filter", `label=orkestrator-owner=${owner}`]))
      .split("\n")
      .filter(Boolean);
    if (names.length > 0) await docker([kind, "rm", ...names]).catch(() => undefined);
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
}, 600_000);

function benchContext(environments: Environment[]) {
  const fixture = memoryLifecycleContext(environments, dataDir);
  Object.assign(fixture.context, {
    dockerImage: IMAGE,
    runtimeFlavor: "agent-test",
    credentialSources: new Set(["claude"]),
    agentTools: {
      connection: () => {
        throw new Error("unused");
      },
      revokeEnvironment: () => undefined,
      servicePort: () => 41234,
    },
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
      global: { allowedDomains: ["registry.npmjs.org"], enabledAgentPlatforms: ["claude"] },
      repositories: {},
    }),
    listMultiReviewWorkflows: async () => [],
    listAllBuildPipelines: async () => [],
  });
  return fixture;
}

async function writeReport(): Promise<void> {
  const out = path.resolve(import.meta.dir, "../../../output/benchmarks");
  await fs.mkdir(out, { recursive: true });
  const engine = await docker(["version", "--format", "{{.Server.Version}}"]).catch(
    () => "unknown",
  );
  const imageId = await docker(["image", "inspect", "-f", "{{.Id}}", IMAGE]).catch(() => "unknown");
  const report = {
    run: RUN,
    at: new Date().toISOString(),
    platform: `${process.platform}/${process.arch}`,
    cpus: os.cpus().length,
    engine,
    image: imageId,
    results,
  };
  await fs.writeFile(path.join(out, `${RUN}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function freshRuntime(id: string, mode: "restricted" | "full") {
  const { createDockerContainer } =
    await import("../../../apps/backend/src/core/commands-containers");
  const { resolveDockerImage } = await import("../../../apps/backend/src/core/docker-image");
  const { ensureStorageVolumes, initializeStorageSet, planStorageSet } =
    await import("../../../apps/backend/src/core/container-storage");
  const environment = lifecycleEnvironment({ id, networkAccessMode: mode });
  const fixture = benchContext([environment]);
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("image missing");
  const storage = planStorageSet(id, owner, 1);
  const phases: Record<string, number> = {};
  const storageStep = await timed(async () => {
    await ensureStorageVolumes(fixture.context, id, storage);
    await initializeStorageSet(fixture.context, resolved.imageId, id, storage);
  });
  phases.storage = storageStep.ms;
  const create = await timed(() =>
    createDockerContainer(environment, fixture.context, {
      imageId: resolved.imageId,
      runtimeGeneration: 1,
      storage,
    }),
  );
  phases.create = create.ms;
  const containerId = create.value;
  const boot = await timed(async () => {
    await docker(["start", containerId]);
    await waitForContainerBoot(containerId);
  });
  phases.startToReady = boot.ms;
  await fixture.context.storage.updateEnvironment(id, {
    containerId,
    status: "running",
    containerLifecycle: {
      schemaVersion: 1,
      revision: 1,
      lastRuntimeGeneration: 1,
      runtime: {
        containerId,
        runtimeGeneration: 1,
        owner,
        imageRef: IMAGE,
        imageId: resolved.imageId,
      },
      storage,
      outcomes: [],
    },
  });
  return {
    fixture,
    containerId,
    phases,
    dockerCalls: storageStep.dockerCalls + create.dockerCalls + boot.dockerCalls,
  };
}

describe("container baselines", () => {
  bench(
    "fresh environment, warm stop/start, rebuild, sampler and observer churn",
    async () => {
      const { resetResourceCaches, sampleContainerUsage } =
        await import("../../../apps/backend/src/core/container-resources");
      const { drainContainerProcesses } =
        await import("../../../apps/backend/src/core/container-readiness");
      const { replaceRuntimePreservingState } =
        await import("../../../apps/backend/src/core/container-replacement");
      const { ContainerLogService } =
        await import("../../../apps/backend/src/core/container-log-service");

      // Fresh environments (per-environment cold: new network, volumes, staged
      // inputs; the image and Docker's global caches are left alone).
      const fresh: Record<string, number[]> = {
        total: [],
        storage: [],
        create: [],
        startToReady: [],
      };
      const freshCalls: number[] = [];
      let last: Awaited<ReturnType<typeof freshRuntime>> | null = null;
      const incomplete: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        try {
          const runtime = await freshRuntime(`env-${RUN}-fresh-${index}`, "restricted");
          last = runtime;
          fresh.total!.push(performance.now() - started);
          for (const [phase, ms] of Object.entries(runtime.phases)) fresh[phase]!.push(ms);
          freshCalls.push(runtime.dockerCalls);
        } catch (error) {
          // Recorded, not retried: a fail-closed firewall start is a result.
          incomplete.push(
            /not-ready|container-exited/.test(String(error)) ? "boot-failed" : "error",
          );
        }
      }
      if (!last) last = await freshRuntime(`env-${RUN}-fresh-full`, "full");
      results.freshRestricted = {
        ...Object.fromEntries(Object.entries(fresh).map(([key, value]) => [key, summarize(value)])),
        dockerCalls: summarize(freshCalls),
        incomplete,
      };

      // Warm stop (drain) and start to current-boot readiness.
      const warm = { stop: [] as number[], start: [] as number[] };
      const containerId = last!.containerId;
      for (let index = 0; index < 10; index += 1) {
        const stop = await timed(async () => {
          await drainContainerProcesses(containerId);
          await docker(["stop", containerId]);
        });
        warm.stop.push(stop.ms);
        const start = await timed(async () => {
          await docker(["start", containerId]);
          await waitForContainerBoot(containerId);
        });
        warm.start.push(start.ms);
      }
      results.warmStopStart = { stop: summarize(warm.stop), start: summarize(warm.start) };

      // Preserving rebuilds at two workspace sizes. Durations come from the
      // operation's own phase timing.
      const rebuild: Record<string, unknown> = {};
      for (const [label, files, bytesPerFile, repetitions] of [
        ["small", 200, 4 * 1024, 5],
        ["medium", 5_000, 20 * 1024, 3],
      ] as const) {
        const totals: number[] = [];
        const copying: number[] = [];
        let copiedBytes = 0;
        for (let index = 0; index < repetitions; index += 1) {
          const runtime = await freshRuntime(`env-${RUN}-rb-${label}-${index}`, "full");
          await docker([
            "exec",
            "-u",
            "node",
            runtime.containerId,
            "bash",
            "-c",
            `mkdir -p /workspace/data && cd /workspace/data && for i in $(seq 1 ${files}); do head -c ${bytesPerFile} /dev/urandom > f$i; done`,
          ]);
          const id = `env-${RUN}-rb-${label}-${index}`;
          const outcome = await replaceRuntimePreservingState(
            { environmentId: id, expectedContainerId: runtime.containerId },
            runtime.fixture.context,
          );
          copiedBytes = outcome?.bytes ?? 0;
          const record = parseContainerLifecycle(
            (await runtime.fixture.context.storage.getEnvironment(id))?.containerLifecycle,
          );
          const last = record.supported ? record.record.outcomes.at(-1) : undefined;
          expect(last?.status).toBe("succeeded");
          totals.push(last?.durationMs ?? 0);
          const copy = (last?.phases ?? [])
            .filter((entry) => entry.phase === "copying")
            .reduce((sum, entry) => sum + entry.ms, 0);
          copying.push(copy);
          rebuild[`${label}Phases`] = last?.phases;
        }
        rebuild[label] = {
          files,
          bytes: copiedBytes,
          total: summarize(totals),
          copying: summarize(copying),
        };
      }
      results.rebuild = rebuild;

      // Usage sampler cost with the environments above running.
      const sampler: number[] = [];
      const samplerCalls: number[] = [];
      for (let index = 0; index < 10; index += 1) {
        resetResourceCaches();
        const sample = await timed(() => sampleContainerUsage(last!.fixture.context));
        sampler.push(sample.ms);
        samplerCalls.push(sample.dockerCalls);
      }
      const running = (await sampleContainerUsage(last!.fixture.context)).containers.filter(
        (entry) => entry.state === "running",
      ).length;
      results.sampler = { running, ms: summarize(sampler), dockerCalls: summarize(samplerCalls) };

      // Observer churn: 200 open/close cycles over 3 containers.
      const service = new ContainerLogService();
      const ids = (
        await docker(["ps", "-q", "--no-trunc", "--filter", `label=orkestrator-owner=${owner}`])
      )
        .split("\n")
        .filter(Boolean)
        .slice(0, 3);
      const rssBefore = process.memoryUsage().rss;
      const churn = await timed(async () => {
        for (let index = 0; index < 200; index += 1) {
          const handle = service.open(ids[index % ids.length]!);
          service.close(handle.subscriptionId);
        }
      });
      const peakFollowers = service.followerCount();
      await Bun.sleep(6_000);
      results.observerChurn = {
        cycles: 200,
        ms: Math.round(churn.ms),
        followersDuringChurn: peakFollowers,
        followersAfterGrace: service.followerCount(),
        dockerCalls: churn.dockerCalls,
        rssDeltaMiB: Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024),
      };
      service.shutdown();
      expect(service.followerCount()).toBe(0);
      await writeReport();
    },
    TIMEOUT,
  );
});

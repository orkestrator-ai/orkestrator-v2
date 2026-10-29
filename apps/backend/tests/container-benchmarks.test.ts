/**
 * Container performance baselines. The regression targets the report is
 * compared against are in docs/development/container-qualification.md.
 *
 * Opt-in and slow: RUN_CONTAINER_BENCHMARKS=1 and
 * ORKESTRATOR_QUALIFICATION_IMAGE=<image>. Runtimes get the built-in default
 * budget, as a new install's would; ORKESTRATOR_BENCHMARK_UNRESTRICTED=1 runs
 * them without limits instead. The report records the budget Docker applied.
 * Uses synthetic fixtures only, runs
 * with concurrency 1 (and a bounded 3-environment case), and removes every
 * resource it labelled. Results go to output/benchmarks/<run>.json and a table
 * on stdout; nothing here records commands, paths or file contents.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { commandInvocationCount, observeCommandInvocations, runCommand } from "../src/core/shell";
import { dockerOwnerNamespace } from "../src/core/docker-ownership";
import { waitForContainerBoot } from "../src/core/container-readiness";
import { egressGatewayOf } from "../src/core/container-network-owner";
import { egressGatewayName, prepareEgressGatewayForStart } from "../src/core/egress-gateway";
import type { Environment } from "../src/core/models";
import { lifecycleEnvironment, memoryLifecycleContext } from "./container-lifecycle-fixtures";

const IMAGE = process.env.ORKESTRATOR_QUALIFICATION_IMAGE?.trim() ?? "";
const ENABLED = process.env.RUN_CONTAINER_BENCHMARKS === "1" && IMAGE.length > 0;
const bench = ENABLED ? test : test.skip;
const RUN = `b${Date.now().toString(36)}`;
const TIMEOUT = 1_800_000;
const UNRESTRICTED = process.env.ORKESTRATOR_BENCHMARK_UNRESTRICTED === "1";

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

/**
 * The Docker calls made while it runs, each tagged with the step that was
 * current. Arguments are held only until `attributeCalls` reduces them to a
 * verb and a target; nothing else reads or keeps them.
 */
function recordDockerCalls() {
  const calls: Array<{ step: string; args: readonly string[] }> = [];
  let step = "";
  const stop = observeCommandInvocations("docker", (args) => calls.push({ step, args: [...args] }));
  return {
    calls,
    stop,
    step: (next: string) => {
      step = next;
    },
  };
}

const COMPOUND_VERBS = new Set(["container", "context", "image", "network", "system", "volume"]);

function dockerVerb(args: readonly string[]): string {
  const at = args.findIndex((arg) => !arg.startsWith("-"));
  if (at < 0) return "none";
  const verb = args[at]!;
  return COMPOUND_VERBS.has(verb) && args[at + 1] ? `${verb} ${args[at + 1]}` : verb;
}

function createdName(args: readonly string[]): string | null {
  if (!["create", "container create", "run"].includes(dockerVerb(args))) return null;
  const at = args.indexOf("--name");
  return at >= 0 ? (args[at + 1] ?? null) : null;
}

interface CallIdentities {
  runtime: string[];
  gateway: string[];
}

/**
 * A fresh runtime's identities, from its own calls: the creates' names and the
 * runtime's `container:<gateway>` network. Finding them costs no Docker call.
 */
function freshIdentities(
  calls: ReadonlyArray<{ args: readonly string[] }>,
  runtimeId: string,
): CallIdentities {
  const names = calls.map((call) => createdName(call.args)).filter((name) => name !== null);
  const runtimeName =
    names.find((name) => names.includes(egressGatewayName(name))) ?? names.at(-1) ?? "";
  const gatewayName = names.includes(egressGatewayName(runtimeName))
    ? egressGatewayName(runtimeName)
    : "";
  const gatewayId =
    calls
      .find((call) => createdName(call.args) === runtimeName)
      ?.args.find((arg) => arg.startsWith("container:"))
      ?.slice("container:".length) ?? "";
  return {
    runtime: [runtimeId, runtimeName].filter(Boolean),
    gateway: [gatewayId, gatewayName].filter(Boolean),
  };
}

/**
 * Counts calls by `<step> <target> <verb>`, where the target is the runtime,
 * its egress gateway, or neither (volumes, the network, storage helpers).
 */
function attributeCalls(
  calls: ReadonlyArray<{ step: string; args: readonly string[] }>,
  ids: CallIdentities,
): Record<string, number> {
  const mentions = (names: string[], args: readonly string[]) =>
    args.some((arg) =>
      names.some(
        (name) => arg === name || arg.startsWith(`${name}:`) || arg === `container:${name}`,
      ),
    );
  const counts: Record<string, number> = {};
  for (const call of calls) {
    const created = createdName(call.args);
    const target =
      created !== null
        ? ids.runtime.includes(created)
          ? "runtime"
          : ids.gateway.includes(created)
            ? "gateway"
            : "other"
        : mentions(ids.runtime, call.args)
          ? "runtime"
          : mentions(ids.gateway, call.args)
            ? "gateway"
            : "other";
    const key = `${call.step} ${target} ${dockerVerb(call.args)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Per key, the count in each sample (0 where a sample had none). */
function collectBreakdowns(samples: Array<Record<string, number>>): Record<string, number[]> {
  const keys = [...new Set(samples.flatMap((sample) => Object.keys(sample)))].sort();
  return Object.fromEntries(keys.map((key) => [key, samples.map((sample) => sample[key] ?? 0)]));
}

/** Totals by step (field 0) or by target (field 1) of `<step> <target> <verb>` keys. */
function totalsBy(breakdown: Record<string, number>, field: 0 | 1): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const [key, count] of Object.entries(breakdown)) {
    const name = key.split(" ")[field]!;
    totals[name] = (totals[name] ?? 0) + count;
  }
  return totals;
}

/**
 * Starts a runtime the way `startRuntime` (`container-live-start.ts`) does,
 * timing its three steps: the egress gateway brought up to an applied
 * firewall, the runtime's `docker start`, and its entrypoint to current-boot
 * readiness.
 */
async function bootRuntime(
  containerId: string,
  step: (name: string) => void = () => undefined,
): Promise<Record<BootStep, number>> {
  const steps = {} as Record<BootStep, number>;
  let at = performance.now();
  const mark = (name: BootStep) => {
    const now = performance.now();
    steps[name] = now - at;
    at = now;
  };
  step("boot.gateway");
  await prepareEgressGatewayForStart(containerId);
  mark("gateway");
  step("boot.runtimeStart");
  await runCommand("docker", ["start", containerId], { timeoutMs: 120_000 });
  mark("runtimeStart");
  step("boot.ready");
  await waitForContainerBoot(containerId);
  mark("ready");
  return steps;
}

type BootStep = "gateway" | "runtimeStart" | "ready";
const BOOT_STEPS: BootStep[] = ["gateway", "runtimeStart", "ready"];

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
      global: {
        allowedDomains: ["registry.npmjs.org"],
        enabledAgentPlatforms: ["claude"],
        ...(UNRESTRICTED
          ? { containerResourceLimits: { cpus: null, memoryMiB: null, pids: null } }
          : {}),
      },
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
  // Reports are kept for 30 days; only this harness's own `<run>.json` files.
  const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
  for (const name of await fs.readdir(out)) {
    if (!/^b[0-9a-z]+\.json$/.test(name)) continue;
    const file = path.join(out, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true });
  }
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
    budget: UNRESTRICTED ? "unrestricted" : "built-in default",
    results,
  };
  await fs.writeFile(path.join(out, `${RUN}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

async function freshRuntime(id: string, mode: "restricted" | "full", attribute = false) {
  const { createDockerContainer } = await import("../src/core/commands-containers");
  const { resolveDockerImage } = await import("../src/core/docker-image");
  const { ensureStorageVolumes, initializeStorageSet, planStorageSet } =
    await import("../src/core/container-storage");
  const environment = lifecycleEnvironment({ id, networkAccessMode: mode });
  const fixture = benchContext([environment]);
  const resolved = await resolveDockerImage(IMAGE);
  if (resolved.kind !== "present") throw new Error("image missing");
  const storage = planStorageSet(id, owner, 1);
  const phases: Record<string, number> = {};
  // Only sequential runs attribute: concurrent ones would see each other's calls.
  const recorder = attribute ? recordDockerCalls() : null;
  let containerId: string;
  let dockerCalls: number;
  try {
    recorder?.step("storage");
    const storageStep = await timed(async () => {
      await ensureStorageVolumes(fixture.context, id, storage);
      await initializeStorageSet(fixture.context, resolved.imageId, id, storage);
    });
    phases.storage = storageStep.ms;
    recorder?.step("create");
    const create = await timed(() =>
      createDockerContainer(environment, fixture.context, {
        imageId: resolved.imageId,
        runtimeGeneration: 1,
        storage,
      }),
    );
    phases.create = create.ms;
    containerId = create.value;
    const boot = await timed(() => bootRuntime(containerId, (name) => recorder?.step(name)));
    phases.startToReady = boot.ms;
    for (const step of BOOT_STEPS) phases[`startToReady.${step}`] = boot.value[step];
    dockerCalls = storageStep.dockerCalls + create.dockerCalls + boot.dockerCalls;
  } finally {
    recorder?.stop();
  }
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
    dockerCalls,
    callBreakdown: recorder
      ? attributeCalls(recorder.calls, freshIdentities(recorder.calls, containerId))
      : null,
  };
}

describe("container baselines", () => {
  bench(
    "fresh environment, warm stop/start, rebuild, sampler and observer churn",
    async () => {
      const { inspectAppliedLimits, resetResourceCaches, sampleContainerUsage } =
        await import("../src/core/container-resources");
      const { drainContainerProcesses } = await import("../src/core/container-readiness");
      const { replaceRuntimePreservingState } = await import("../src/core/container-replacement");
      const { ContainerLogService } = await import("../src/core/container-log-service");

      // Fresh environments (per-environment cold: new network, volumes, staged
      // inputs; the image and Docker's global caches are left alone).
      const fresh: Record<string, number[]> = {
        total: [],
        storage: [],
        create: [],
        startToReady: [],
        ...Object.fromEntries(BOOT_STEPS.map((step) => [`startToReady.${step}`, []])),
      };
      const freshCalls: number[] = [];
      const freshBreakdowns: Array<Record<string, number>> = [];
      let last: Awaited<ReturnType<typeof freshRuntime>> | null = null;
      const incomplete: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const started = performance.now();
        try {
          const runtime = await freshRuntime(`env-${RUN}-fresh-${index}`, "restricted", true);
          last = runtime;
          fresh.total!.push(performance.now() - started);
          for (const [phase, ms] of Object.entries(runtime.phases)) fresh[phase]!.push(ms);
          freshCalls.push(runtime.dockerCalls);
          if (runtime.callBreakdown) freshBreakdowns.push(runtime.callBreakdown);
        } catch (error) {
          // Recorded, not retried: a fail-closed firewall start is a result.
          incomplete.push(
            /not-ready|container-exited/.test(String(error)) ? "boot-failed" : "error",
          );
        }
      }
      if (!last) last = await freshRuntime(`env-${RUN}-fresh-full`, "full");
      results.appliedLimits = await inspectAppliedLimits(last.containerId);
      results.freshRestricted = {
        ...Object.fromEntries(Object.entries(fresh).map(([key, value]) => [key, summarize(value)])),
        dockerCalls: summarize(freshCalls),
        // Where the calls go, per completed run: by phase, by container (the
        // runtime, its egress gateway, or neither), and by step, container
        // and verb.
        dockerCallsByPhase: collectBreakdowns(freshBreakdowns.map((entry) => totalsBy(entry, 0))),
        dockerCallsByTarget: collectBreakdowns(freshBreakdowns.map((entry) => totalsBy(entry, 1))),
        dockerCallBreakdown: collectBreakdowns(freshBreakdowns),
        incomplete,
      };

      // Three fresh environments at once: total wall time and each one's
      // slowdown against the sequential median above.
      const concurrent = await timed(() =>
        Promise.allSettled(
          [0, 1, 2].map(async (index) => {
            const started = performance.now();
            await freshRuntime(`env-${RUN}-concurrent-${index}`, "restricted");
            return performance.now() - started;
          }),
        ),
      );
      const concurrentTotals = concurrent.value
        .filter((entry): entry is PromiseFulfilledResult<number> => entry.status === "fulfilled")
        .map((entry) => entry.value);
      const sequentialMedian = summarize(fresh.total!).median;
      results.freshConcurrent3 = {
        wallMs: Math.round(concurrent.ms),
        each: summarize(concurrentTotals),
        incomplete: concurrent.value.length - concurrentTotals.length,
        slowdownVsSequentialMedian:
          sequentialMedian && concurrentTotals.length > 0
            ? Math.round((summarize(concurrentTotals).median! / sequentialMedian) * 100) / 100
            : null,
      };

      // Warm stop (drain) and start to current-boot readiness.
      const warm = { stop: [] as number[], start: [] as number[] };
      const warmSteps = Object.fromEntries(BOOT_STEPS.map((step) => [step, [] as number[]]));
      const warmCalls: number[] = [];
      const warmBreakdowns: Array<Record<string, number>> = [];
      const containerId = last!.containerId;
      // Cached since the fresh start above, so this lookup runs no Docker call.
      const warmIds: CallIdentities = {
        runtime: [containerId],
        gateway: [(await egressGatewayOf(containerId)) ?? ""].filter(Boolean),
      };
      for (let index = 0; index < 10; index += 1) {
        const stop = await timed(async () => {
          await drainContainerProcesses(containerId);
          await docker(["stop", containerId]);
        });
        warm.stop.push(stop.ms);
        const recorder = recordDockerCalls();
        const start = await timed(() => bootRuntime(containerId, recorder.step)).finally(
          recorder.stop,
        );
        warm.start.push(start.ms);
        for (const step of BOOT_STEPS) warmSteps[step]!.push(start.value[step]);
        warmCalls.push(start.dockerCalls);
        warmBreakdowns.push(attributeCalls(recorder.calls, warmIds));
      }
      results.warmStopStart = {
        stop: summarize(warm.stop),
        start: summarize(warm.start),
        startSteps: Object.fromEntries(
          Object.entries(warmSteps).map(([step, samples]) => [step, summarize(samples)]),
        ),
        startDockerCalls: summarize(warmCalls),
        startDockerCallBreakdown: collectBreakdowns(warmBreakdowns),
      };

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

      // Docker calls per minute while the Docker view is open (it refreshes
      // every 5 s; the sampler shares one sample per interval).
      const viewMinute = await timed(async () => {
        const deadline = performance.now() + 60_000;
        while (performance.now() < deadline) {
          await sampleContainerUsage(last!.fixture.context);
          await Bun.sleep(5_000);
        }
      });
      results.dockerCallsPerMinuteViewOpen = viewMinute.dockerCalls;

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

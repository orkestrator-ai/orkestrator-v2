import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILD_PIPELINE_VERSION,
  type BuildPipeline,
  type PipelineSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import { BuildPipelineService } from "./build-pipeline-service.js";
import type { BuildPipelineProvider, ProviderStatus } from "./build-pipeline-provider.js";
import {
  buildPipelineObligation,
  discoverBuildPipelines,
  needsBuildTerminalReconciliation,
} from "./build-pipeline-scheduling.js";
import { TEST_REVIEW_PREPARATION } from "./build-pipeline-test-fixtures.js";
import {
  ManualTime,
  advanceKeyedWork,
  deferred,
  settleKeyedWork,
  type Deferred,
} from "./recurring-test-support.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageService } from "./storage.js";
import type { WorkflowResultService } from "./workflow-result-service.js";

/** Build-stage stand-in: busy until released, then idle with a result. */
class Provider {
  readonly agent = "claude" as const;
  readonly phases = new Map<string, PipelineSessionPhase>();
  readonly sent: { sessionId: string; requestId: string }[] = [];
  readonly statusReads = new Map<string, number>();
  busy = true;
  /** Status reads of sessions created for this environment block until released. */
  gate: Deferred<void> | null = null;
  private counter = 0;

  constructor(readonly name: string) {}

  registerSession(): void {}

  async createSession(phase: PipelineSessionPhase): Promise<string> {
    const id = `${this.name}-${phase}-${++this.counter}`;
    this.phases.set(id, phase);
    return id;
  }

  async send(sessionId: string, _prompt: string, options: { requestId: string }) {
    this.sent.push({ sessionId, requestId: options.requestId });
  }

  async status(sessionId: string): Promise<ProviderStatus> {
    this.statusReads.set(sessionId, (this.statusReads.get(sessionId) ?? 0) + 1);
    if (this.gate) await this.gate.promise;
    return this.busy ? "running" : "idle";
  }

  async messages(sessionId: string): Promise<unknown[]> {
    return [{ id: `${sessionId}-a`, role: "assistant", parts: [{ type: "text", content: "ok" }] }];
  }

  async structured<T>(_sessionId: string, requestId: string): Promise<StructuredOutputResult<T>> {
    return { ok: true, provider: "claude", requestId, value: TEST_REVIEW_PREPARATION as T };
  }

  async abort(): Promise<void> {}

  reads(): number {
    let total = 0;
    for (const count of this.statusReads.values()) total += count;
    return total;
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function environment(storage: StorageService, id: string) {
  await storage.addEnvironment({
    id,
    projectId: "project-1",
    name: id,
    branch: id,
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: `/tmp/${id}`,
    setupScriptsComplete: true,
  });
}

function invokeFor(storage: StorageService) {
  return async <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (
      command === "start_environment" ||
      command === "run_environment_setup" ||
      command === "update_environment_agent_settings"
    ) {
      return (await storage.getEnvironment(String(args.environmentId ?? "env-1"))) as T;
    }
    if (command === "get_environment_uncommitted_paths") {
      return { head: "1".repeat(40), paths: [] } as T;
    }
    return undefined as T;
  };
}

interface Fixture {
  dataDir: string;
  storage: StorageService;
  providers: Map<string, Provider>;
  active: string[];
  completed: string[];
}

/**
 * Persisted fixture shared by both drivers: `completed` pipelines that
 * finished long ago and `active` ones mid-build, one environment each.
 */
async function fixture(options: { completed: number; active: number }): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-build-keyed-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const providers = new Map<string, Provider>();
  const seeder = new BuildPipelineService(storage, invokeFor(storage), {
    autoAdvance: false,
    keyedScheduling: false,
    provider: async (pipeline) => providerFor(providers, pipeline.environmentId),
  });
  const active: string[] = [];
  const completed: string[] = [];
  const total = options.completed + options.active;
  for (let index = 0; index < total; index += 1) {
    const environmentId = `env-${index}`;
    await environment(storage, environmentId);
    const started = await seeder.start({
      taskId: `task-${index}`,
      projectId: "project-1",
      environmentType: "local",
      agentType: "claude",
      taskTitle: "Pipeline",
      taskSnapshot: {
        title: "Pipeline",
        description: "Build it",
        acceptanceCriteria: "Works",
        comments: [],
        images: [],
      },
      existingEnvironmentId: environmentId,
    });
    await seeder.advanceNow(started.id);
    await seeder.advanceNow(started.id);
    if (index < options.completed) {
      const record = (await storage.getBuildPipeline(started.id))!;
      const snapshot = { ...(record.snapshot as BuildPipeline), phase: "complete" as const };
      await storage.saveBuildPipeline(
        started.id,
        "project-1",
        environmentId,
        BUILD_PIPELINE_VERSION,
        { ...snapshot, backendRevision: record.revision + 1 },
        record.revision,
      );
      completed.push(started.id);
    } else {
      active.push(started.id);
    }
  }
  await seeder.shutdown();
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, storage, providers, active, completed };
}

function providerFor(providers: Map<string, Provider>, environmentId: string): Provider {
  let provider = providers.get(environmentId);
  if (!provider) {
    provider = new Provider(environmentId);
    providers.set(environmentId, provider);
  }
  return provider;
}

function service(
  context: Fixture,
  mode: "legacy" | "keyed",
  time: ManualTime,
  extra: ConstructorParameters<typeof BuildPipelineService>[2] = {},
) {
  const created = new BuildPipelineService(context.storage, invokeFor(context.storage), {
    ...(mode === "legacy"
      ? { autoAdvance: false, keyedScheduling: false }
      : { keyedScheduling: true, schedulerClock: { now: time.now, timers: time.timerFactory } }),
    provider: async (pipeline) =>
      providerFor(context.providers, pipeline.environmentId) as unknown as BuildPipelineProvider,
    ...extra,
  });
  cleanups.unshift(() => created.shutdown());
  return created;
}

async function phaseOf(storage: StorageService, id: string) {
  return ((await storage.getBuildPipeline(id))!.snapshot as BuildPipeline).phase;
}

describe("build pipeline obligations", () => {
  test("cover consumption, provisioning, fan-out, stages and terminal side effects", async () => {
    const context = await fixture({ completed: 1, active: 1 });
    const done = (await context.storage.getBuildPipeline(context.completed[0]!))!.snapshot;
    const live = (await context.storage.getBuildPipeline(context.active[0]!))!.snapshot;
    expect(buildPipelineObligation(live)).toBe("advance");
    expect(buildPipelineObligation(done)).toBeNull();
    const pipeline = live as BuildPipeline;
    expect(buildPipelineObligation({ ...pipeline, phase: "waiting-for-setup" })).toBe("provision");
    expect(
      buildPipelineObligation({ ...pipeline, phase: "complete", pendingResultConsumptions: ["k"] }),
    ).toBe("result-consumption");
    expect(buildPipelineObligation({ ...pipeline, phase: "paused" })).toBeNull();
    const withSource = {
      ...pipeline,
      phase: "failed" as const,
      source: { type: "kanban" as const, taskId: "task" },
    } as BuildPipeline;
    expect(needsBuildTerminalReconciliation(withSource)).toBe(true);
    expect(buildPipelineObligation(withSource)).toBe("terminal-reconciliation");
    expect(
      buildPipelineObligation({ ...withSource, completionCommentStatus: "posted" }),
    ).toBeNull();
    expect(buildPipelineObligation({ phase: "building" })).toBeNull();
    const discovered = await discoverBuildPipelines(context.storage);
    expect(discovered).toMatchObject({ scanned: 2, complete: true });
    expect(discovered.entries.map((entry) => entry.key)).toEqual(context.active);
  });
});

describe("BuildPipelineService keyed scheduling", () => {
  test("old and new drivers make the same transitions from one persisted fixture", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const mode of ["legacy", "keyed"] as const) {
      const context = await fixture({ completed: 30, active: 2 });
      const time = new ManualTime(0);
      const supervisor = service(context, mode, time);
      await supervisor.init();
      const tick = async () => {
        if (mode === "legacy") {
          await (supervisor as unknown as { requestTick(): Promise<void> }).requestTick();
        } else {
          await advanceKeyedWork(time, [supervisor], 1_500);
        }
      };
      for (let index = 0; index < 3; index += 1) await tick();
      const whileBusy = await Promise.all(context.active.map((id) => phaseOf(context.storage, id)));
      for (const provider of context.providers.values()) provider.busy = false;
      for (let index = 0; index < 3; index += 1) await tick();
      outcomes[mode] = {
        whileBusy,
        after: await Promise.all(context.active.map((id) => phaseOf(context.storage, id))),
        completedUntouched: await Promise.all(
          context.completed.map((id) => phaseOf(context.storage, id)),
        ),
        sends: [...context.providers.values()].reduce((sum, p) => sum + p.sent.length, 0),
      };
    }
    expect(outcomes.keyed).toEqual(outcomes.legacy);
    const keyed = outcomes.keyed as { whileBusy: string[]; after: string[] };
    expect(keyed.whileBusy).toEqual(["building", "building"]);
    expect(keyed.after.every((phase) => phase !== "building")).toBe(true);
  });

  test("retained history is enumerated only by the safety scan", async () => {
    const context = await fixture({ completed: 40, active: 1 });
    const time = new ManualTime(0);
    const supervisor = service(context, "keyed", time, { discoveryIntervalMs: 30_000 });
    recurringWorkMetrics.reset();
    await supervisor.init();
    await advanceKeyedWork(time, [supervisor], 60_000, 1_500);
    const counters = recurringWorkMetrics.snapshot().kinds["build-supervisor-tick"]!;
    // Discovery at start, 30 s and 60 s; the active pipeline every 1.5 s.
    expect(counters.workUnits["record-scanned"]).toBe(3 * 41);
    expect(counters.workUnits["record-selected"]).toBeGreaterThanOrEqual(40);
    const [activeProvider] = [...context.providers.values()].filter((p) => p.reads() > 0);
    expect(activeProvider?.reads()).toBeGreaterThanOrEqual(40);
    expect([...context.providers.values()].filter((p) => p.reads() > 0)).toHaveLength(1);
  });

  test("a terminal pipeline's pending result consumption is finished without a restart", async () => {
    for (const mode of ["legacy", "keyed"] as const) {
      const context = await fixture({ completed: 0, active: 1 });
      const [id] = context.active;
      let consumeCalls = 0;
      const workflowResults = {
        consume: async () => {
          consumeCalls += 1;
        },
      } as unknown as WorkflowResultService;
      const time = new ManualTime(0);
      const supervisor = service(context, mode, time, { workflowResults });
      await supervisor.init();
      await settleKeyedWork(time, [supervisor]);
      // A terminal commit that still owes a consumption lands after startup
      // (the deferred-consumption path), with no wakeup delivered.
      const record = (await context.storage.getBuildPipeline(id!))!;
      await context.storage.saveBuildPipeline(
        id!,
        "project-1",
        (record.snapshot as BuildPipeline).environmentId,
        BUILD_PIPELINE_VERSION,
        {
          ...(record.snapshot as BuildPipeline),
          phase: "complete",
          pendingResultConsumptions: ["result-1"],
          backendRevision: record.revision + 1,
        },
        record.revision,
      );
      for (let index = 0; index < 3; index += 1) {
        if (mode === "legacy") {
          await (supervisor as unknown as { requestTick(): Promise<void> }).requestTick();
        } else {
          // The pipeline is already indexed; its own pass settles the outbox.
          await advanceKeyedWork(time, [supervisor], 1_500);
        }
      }
      const snapshot = (await context.storage.getBuildPipeline(id!))!.snapshot as BuildPipeline;
      if (mode === "legacy") {
        // The whole-store tick selected only active or comment-owing pipelines.
        expect(snapshot.pendingResultConsumptions).toEqual(["result-1"]);
      } else {
        expect(snapshot.pendingResultConsumptions).toBeUndefined();
        expect(consumeCalls).toBe(1);
      }
    }
  });

  test("one pipeline's hung provider never delays another pipeline", async () => {
    const context = await fixture({ completed: 0, active: 2 });
    const [slow, fast] = context.active;
    const time = new ManualTime(0);
    const supervisor = service(context, "keyed", time);
    await supervisor.init();
    await settleKeyedWork(time, [supervisor]);
    const slowEnvironment = (
      (await context.storage.getBuildPipeline(slow!))!.snapshot as BuildPipeline
    ).environmentId;
    const fastEnvironment = (
      (await context.storage.getBuildPipeline(fast!))!.snapshot as BuildPipeline
    ).environmentId;
    const slowProvider = providerFor(context.providers, slowEnvironment);
    const fastProvider = providerFor(context.providers, fastEnvironment);
    slowProvider.gate = deferred();
    const fastBefore = fastProvider.reads();
    await advanceKeyedWork(time, [supervisor], 9_000, 1_500, { allowInFlight: 1 });
    expect(fastProvider.reads() - fastBefore).toBeGreaterThanOrEqual(5);
    // The hung pass is one read that never returned; no pile-up behind it.
    expect(slowProvider.reads()).toBeLessThanOrEqual(3);
    slowProvider.gate.resolve();
    slowProvider.gate = null;
  });

  test("a deletion by another path retires the key at once", async () => {
    const context = await fixture({ completed: 0, active: 1 });
    const [id] = context.active;
    const time = new ManualTime(0);
    const supervisor = service(context, "keyed", time);
    await supervisor.init();
    await settleKeyedWork(time, [supervisor]);
    expect(supervisor.schedulingStatus()?.keys).toBe(1);
    await context.storage.deleteBuildPipelinesByEnvironment(
      ((await context.storage.getBuildPipeline(id!))!.snapshot as BuildPipeline).environmentId,
    );
    expect(supervisor.schedulingStatus()?.keys).toBe(0);
  });

  test("a scoped wake runs the waiting pipeline before its fallback cadence", async () => {
    const context = await fixture({ completed: 0, active: 1 });
    const time = new ManualTime(0);
    const supervisor = service(context, "keyed", time);
    await supervisor.init();
    await settleKeyedWork(time, [supervisor]);
    const provider = [...context.providers.values()][0]!;
    const before = provider.reads();
    const environmentId = provider.name;
    supervisor.wakeEnvironment(environmentId, "result-accepted");
    await settleKeyedWork(time, [supervisor]);
    expect(provider.reads()).toBe(before + 1);
    // Another environment's wake touches nothing here.
    supervisor.wakeEnvironment("env-unrelated", "result-accepted");
    await settleKeyedWork(time, [supervisor]);
    expect(provider.reads()).toBe(before + 1);
  });
});

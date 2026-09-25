import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FEATURE_PLANNING_RECORD_VERSION,
  type FeaturePlanningRecord,
} from "@orkestrator/protocol/feature-planning";
import type { BuildPipelineProvider } from "./build-pipeline-provider.js";
import { FeaturePlanningService } from "./feature-planning.js";
import {
  discoverFeaturePlanning,
  featurePlanningObligation,
} from "./feature-planning-scheduling.js";
import {
  ManualTime,
  advanceKeyedWork,
  deferred,
  settleKeyedWork,
  type Deferred,
} from "./recurring-test-support.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageService } from "./storage.js";

const PLANNER_REPLY = [
  "Here is what I understand so far.",
  "<feature_planner_state>",
  '{"phase":"confirming","title":"Bulk export","summary":"Export every report as CSV"}',
  "</feature_planner_state>",
].join("\n");

/** Codex stand-in with one transcript per session; every read is counted. */
class Provider {
  readonly agent = "codex" as const;
  readonly sends: { sessionId: string; requestId: string }[] = [];
  readonly aborted: string[] = [];
  readonly transcripts = new Map<string, unknown[]>();
  readonly busy = new Set<string>();
  reads = 0;
  /** Holds every activity read for `gatedSession` until released. */
  gatedSession: string | null = null;
  gate: Deferred<void> | null = null;

  async createSession(): Promise<string> {
    return `created-${this.sends.length}`;
  }

  async send(sessionId: string, _prompt: string, options: { requestId: string }): Promise<void> {
    this.sends.push({ sessionId, requestId: options.requestId });
    this.busy.add(sessionId);
  }

  async status(sessionId: string) {
    this.reads += 1;
    return this.busy.has(sessionId) ? ("running" as const) : ("idle" as const);
  }

  async activity(sessionId: string) {
    this.reads += 1;
    if (this.gate && sessionId === this.gatedSession) await this.gate.promise;
    return this.busy.has(sessionId) ? ("working" as const) : ("idle" as const);
  }

  async messages(sessionId: string): Promise<unknown[]> {
    this.reads += 1;
    return this.transcripts.get(sessionId) ?? [];
  }

  async structured(): Promise<null> {
    return null;
  }

  async settleTurn(): Promise<boolean> {
    return true;
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    this.busy.delete(sessionId);
  }

  async dispose(): Promise<void> {}

  reply(sessionId: string, content = PLANNER_REPLY): void {
    const transcript = this.transcripts.get(sessionId) ?? [];
    transcript.push({
      id: `assistant-${sessionId}-${transcript.length + 1}`,
      role: "assistant",
      content,
      createdAt: new Date(Date.now() + 1_000).toISOString(),
    });
    this.transcripts.set(sessionId, transcript);
    this.busy.delete(sessionId);
  }
}

interface Fixture {
  dataDir: string;
  storage: StorageService;
  active: string[];
  sessions: Map<string, string>;
  completed: number;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Persisted fixture shared by old and new scheduling: many plans whose
 * planning finished long ago, and a few with an exchange still dispatching.
 */
async function fixture(options: { completed?: number; active?: number } = {}): Promise<Fixture> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-feature-planning-keyed-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "env-1",
    projectId: "project-1",
    name: "planning",
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "full",
    order: 0,
    environmentType: "local",
    worktreePath: "/tmp/planning",
    setupScriptsComplete: true,
  });
  const completed = options.completed ?? 0;
  const timestamp = new Date().toISOString();
  const record = (featureId: string, phase: FeaturePlanningRecord["phase"]) =>
    ({
      version: FEATURE_PLANNING_RECORD_VERSION,
      operationId: `operation-${featureId}`,
      featureId,
      projectId: "project-1",
      kind: "feature",
      userMessage: "Let me export reports",
      environmentId: "env-1",
      phase,
      startedAt: timestamp,
      attemptStartedAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    }) satisfies FeaturePlanningRecord;
  for (let index = 0; index < completed; index += 1) {
    const plan = await storage.createFeaturePlan("project-1");
    await storage.startFeaturePlanning(record(plan.id, "complete"));
  }
  const active: string[] = [];
  const sessions = new Map<string, string>();
  for (let index = 0; index < (options.active ?? 0); index += 1) {
    const plan = await storage.createFeaturePlan("project-1");
    const sessionId = `session-${index}`;
    await storage.updateFeaturePlan(plan.id, {
      codexEnvironmentId: "env-1",
      codexSessionId: sessionId,
    });
    await storage.startFeaturePlanning(record(plan.id, "dispatching"));
    active.push(plan.id);
    sessions.set(plan.id, sessionId);
  }
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, storage, active, sessions, completed };
}

function keyedService(
  storage: StorageService,
  provider: Provider,
  time: ManualTime,
  options: ConstructorParameters<typeof FeaturePlanningService>[2] = {},
) {
  const service = new FeaturePlanningService(storage, async <T>() => undefined as T, {
    keyedScheduling: true,
    provider: async () => provider as unknown as BuildPipelineProvider,
    schedulerClock: { now: time.now, timers: time.timerFactory },
    ...options,
  });
  cleanups.unshift(() => service.shutdown());
  return service;
}

async function planningState(storage: StorageService, featureId: string) {
  const plan = await storage.getFeaturePlan(featureId);
  return { status: plan?.status, planning: plan?.planning as FeaturePlanningRecord | undefined };
}

describe("feature planning obligations", () => {
  test("classify every active phase and nothing terminal", () => {
    const base = {
      version: FEATURE_PLANNING_RECORD_VERSION,
      operationId: "op",
      featureId: "feature",
      projectId: "project",
      kind: "feature" as const,
      userMessage: "hi",
      startedAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      backendRevision: 0,
    };
    expect(featurePlanningObligation({ ...base, phase: "dispatching" })).toBe("dispatch");
    expect(featurePlanningObligation({ ...base, phase: "running" })).toBe("await-reply");
    expect(featurePlanningObligation({ ...base, phase: "persisting" })).toBe("persist");
    expect(featurePlanningObligation({ ...base, phase: "cancelling" })).toBe("cancelling");
    expect(featurePlanningObligation({ ...base, phase: "complete" })).toBeNull();
    expect(featurePlanningObligation({ ...base, phase: "failed" })).toBeNull();
    expect(featurePlanningObligation({ phase: "running" })).toBeNull();
    expect(featurePlanningObligation(undefined)).toBeNull();
  });
});

describe("FeaturePlanningService keyed scheduling", () => {
  test("old and new drivers make the same transitions from one persisted fixture", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const mode of ["legacy", "keyed"] as const) {
      const context = await fixture({ completed: 40, active: 2 });
      const provider = new Provider();
      const time = new ManualTime(0);
      const service =
        mode === "keyed"
          ? keyedService(context.storage, provider, time)
          : new FeaturePlanningService(context.storage, async <T>() => undefined as T, {
              autoAdvance: false,
              keyedScheduling: false,
              provider: async () => provider as unknown as BuildPipelineProvider,
            });
      if (mode === "legacy") cleanups.unshift(() => service.shutdown());
      await service.init();
      // The legacy driver's interval, stepped by hand so both runs see the
      // same sequence of passes.
      const legacyTick = () =>
        (service as unknown as { requestTick(): Promise<void> }).requestTick();
      const step = async () => {
        if (mode === "legacy") await legacyTick();
        else await advanceKeyedWork(time, [service], 1_000);
      };
      await step();
      for (const featureId of context.active) {
        expect((await planningState(context.storage, featureId)).planning?.phase).toBe("running");
      }
      for (const featureId of context.active) provider.reply(context.sessions.get(featureId)!);
      await step();
      await step();
      outcomes[mode] = {
        sends: provider.sends.length,
        states: await Promise.all(
          context.active.map((featureId) => planningState(context.storage, featureId)),
        ),
      };
    }
    expect(outcomes.keyed).toEqual(outcomes.legacy);
    expect(outcomes.keyed).toEqual({
      sends: 2,
      states: [
        { status: "confirming", planning: undefined },
        { status: "confirming", planning: undefined },
      ],
    });
  });

  test("idle history no longer multiplies fast-tick work; only the safety scan reads it", async () => {
    const context = await fixture({ completed: 200, active: 0 });
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyedService(context.storage, provider, time, {
      discoveryIntervalMs: 30_000,
    });
    recurringWorkMetrics.reset();
    await service.init();
    await advanceKeyedWork(time, [service], 60_000, 1_000);
    const counters = recurringWorkMetrics.snapshot().kinds["feature-planning-tick"];
    // Start plus two safety scans in a minute, instead of sixty whole-store ticks.
    expect(counters?.started).toBe(3);
    expect(counters?.workUnits["record-scanned"]).toBe(600);
    expect(counters?.workUnits["record-selected"] ?? 0).toBe(0);
    expect(provider.reads).toBe(0);
  });

  test("a restart between the durable commit and its wakeup is recovered at startup", async () => {
    const context = await fixture({ active: 1 });
    const [featureId] = context.active;
    const provider = new Provider();
    const time = new ManualTime(0);
    // The record was committed as dispatching by a process that then died:
    // no wakeup, no explicit advance. Startup discovery alone must finish it.
    const service = keyedService(context.storage, provider, time);
    await service.init();
    await settleKeyedWork(time, [service]);
    expect(provider.sends).toHaveLength(1);
    provider.reply(context.sessions.get(featureId!)!);
    await advanceKeyedWork(time, [service], 2_000);
    expect(await planningState(context.storage, featureId!)).toEqual({
      status: "confirming",
      planning: undefined,
    });
    // Rehydration by another client after completion reads the same state.
    const reader = new FeaturePlanningService(context.storage, async <T>() => undefined as T, {
      autoAdvance: false,
    });
    expect(await reader.snapshot("project-1")).toEqual([]);
    expect((await context.storage.getFeaturePlan(featureId!))?.title).toBe("Bulk export");
  });

  test("startup returns while a pass is stuck, and the stuck key never delays another", async () => {
    const context = await fixture({ active: 2 });
    const [stuck, other] = context.active;
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyedService(context.storage, provider, time);
    await service.init();
    await settleKeyedWork(time, [service]);
    expect(provider.sends).toHaveLength(2);
    // The first exchange's provider read hangs indefinitely.
    provider.gatedSession = context.sessions.get(stuck!)!;
    provider.gate = deferred();
    provider.reply(context.sessions.get(other!)!);
    await advanceKeyedWork(time, [service], 3_000, 250, { allowInFlight: 1 });
    expect((await planningState(context.storage, other!)).planning).toBeUndefined();
    expect((await planningState(context.storage, stuck!)).planning?.phase).toBe("running");
    provider.gate.resolve();
    provider.gate = null;
  });

  test("cancellation during a slow provider read settles once and nothing is applied", async () => {
    const context = await fixture({ active: 1 });
    const [featureId] = context.active;
    const sessionId = context.sessions.get(featureId!)!;
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyedService(context.storage, provider, time);
    await service.init();
    await settleKeyedWork(time, [service]);
    provider.gatedSession = sessionId;
    provider.gate = deferred();
    await advanceKeyedWork(time, [service], 1_000, 250, { allowInFlight: 1 });
    // The reply lands while the read that would observe it is still blocked.
    provider.reply(sessionId);
    const cancelled = service.cancel(featureId!);
    provider.gate.resolve();
    provider.gate = null;
    await cancelled;
    await advanceKeyedWork(time, [service], 3_000);
    const state = await planningState(context.storage, featureId!);
    expect(state.planning).toBeUndefined();
    // Cancelling does not apply the late reply's state to the plan.
    expect(state.status).not.toBe("confirming");
    expect(provider.aborted).toContain(sessionId);
    expect(provider.sends).toHaveLength(1);
    expect(service.schedulingStatus()?.keys).toBe(0);
  });

  test("an environment wake advances a waiting exchange before the fallback cadence", async () => {
    const context = await fixture({ active: 1 });
    const [featureId] = context.active;
    await context.storage.updateEnvironment("env-1", { status: "stopped" });
    const provider = new Provider();
    const time = new ManualTime(0);
    const starts: string[] = [];
    const service = new FeaturePlanningService(
      context.storage,
      async <T>(command: string) => {
        starts.push(command);
        return undefined as T;
      },
      {
        keyedScheduling: true,
        // A long fallback cadence isolates the wakeup's effect.
        pollIntervalMs: 60_000,
        provider: async () => provider as unknown as BuildPipelineProvider,
        schedulerClock: { now: time.now, timers: time.timerFactory },
      },
    );
    cleanups.unshift(() => service.shutdown());
    await service.init();
    await settleKeyedWork(time, [service]);
    expect(starts).toEqual(["start_environment_background"]);
    expect(provider.sends).toHaveLength(0);
    await context.storage.updateEnvironment("env-1", { status: "running" });
    service.wakeEnvironment("env-1", "environment-change");
    await settleKeyedWork(time, [service]);
    expect(provider.sends).toHaveLength(1);
    expect(service.schedulingStatus()?.wakes["environment-change"]).toBe(1);
    void featureId;
  });

  test("a corrupt record and a failed enumeration never stall unrelated work", async () => {
    const context = await fixture({ active: 1 });
    const [featureId] = context.active;
    const broken = await context.storage.createFeaturePlan("project-1");
    const plans = await context.storage.listAllFeaturePlans();
    const raw = plans.map((plan) =>
      plan.id === broken.id ? { ...plan, planning: { phase: "running", garbage: true } } : plan,
    );
    await fs.writeFile(
      path.join(context.dataDir, "feature-plans.json"),
      `${JSON.stringify(raw, null, 2)}\n`,
    );
    const discovered = await discoverFeaturePlanning(context.storage);
    expect(discovered.entries.map((entry) => entry.key)).toEqual([featureId!]);

    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyedService(context.storage, provider, time, { discoveryIntervalMs: 5_000 });
    await service.init();
    await settleKeyedWork(time, [service]);
    expect(provider.sends).toHaveLength(1);
    // Storage enumeration starts failing; the known exchange still progresses.
    const original = context.storage.listAllFeaturePlans.bind(context.storage);
    context.storage.listAllFeaturePlans = async () => {
      throw new Error("enumeration failed");
    };
    provider.reply(context.sessions.get(featureId!)!);
    await advanceKeyedWork(time, [service], 12_000, 1_000);
    context.storage.listAllFeaturePlans = original;
    expect(service.schedulingStatus()?.failedDiscoveries).toBeGreaterThan(0);
    expect((await planningState(context.storage, featureId!)).planning).toBeUndefined();
  });

  test("a missed wakeup converges within the safety interval", async () => {
    const context = await fixture({});
    const provider = new Provider();
    const time = new ManualTime(0);
    const service = keyedService(context.storage, provider, time, {
      discoveryIntervalMs: 30_000,
    });
    await service.init();
    await settleKeyedWork(time, [service]);
    // Another process starts an exchange in the shared data directory.
    const plan = await context.storage.createFeaturePlan("project-1");
    await context.storage.updateFeaturePlan(plan.id, {
      codexEnvironmentId: "env-1",
      codexSessionId: "session-late",
    });
    const timestamp = new Date().toISOString();
    await context.storage.startFeaturePlanning({
      version: FEATURE_PLANNING_RECORD_VERSION,
      operationId: "late",
      featureId: plan.id,
      projectId: "project-1",
      kind: "feature",
      userMessage: "late",
      environmentId: "env-1",
      phase: "dispatching",
      startedAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    });
    await advanceKeyedWork(time, [service], 29_000, 1_000);
    expect(provider.sends).toHaveLength(0);
    await advanceKeyedWork(time, [service], 1_000, 1_000);
    expect(provider.sends).toHaveLength(1);
    expect(service.schedulingStatus()?.recoveredByDiscovery).toBe(1);
  });
});

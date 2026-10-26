import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FeaturePlanningService } from "../src/core/feature-planning.js";
import { recurringWorkMetrics } from "../src/core/recurring-work-metrics.js";
import { StorageService } from "../src/core/storage.js";
import {
  DEFAULT_SCENARIOS,
  compareBaselines,
  runBaseline,
  runScenario,
  type BaselinePhases,
} from "../scripts/recurring-baseline-harness.js";
import {
  DEFAULT_NATIVE_FIXTURE,
  runNativeObservationBaseline,
} from "../scripts/recurring-baseline-native.js";
import { runWorkflowBaseline } from "../scripts/recurring-baseline-workflows.js";

const SHORT: BaselinePhases = { startupMs: 30_000, idleMs: 6 * 60_000, clientRefreshMs: 5_000 };
const environment = { commit: "test", platform: "test", arch: "test", runtime: "test" };

describe("recurring-work baseline harness", () => {
  test("is deterministic and content-free", async () => {
    const scenarios = DEFAULT_SCENARIOS.filter((entry) =>
      ["env1-local-c1", "env10-mixed-c2-pr-wf200"].includes(entry.id),
    );
    const first = await runBaseline({
      scenarios,
      phases: SHORT,
      environment,
      nativeObservation: false,
      workflows: false,
    });
    const second = await runBaseline({
      scenarios,
      phases: SHORT,
      environment,
      nativeObservation: false,
      workflows: false,
    });
    expect(second).toEqual(first);
    expect(compareBaselines(first, second)).toEqual([]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("/fixture");
    expect(serialized).not.toContain("env-0");
    expect(serialized).not.toContain("container-0");
    expect(serialized).not.toContain("example.invalid");
  });

  test("backend-owned work does not multiply with clients; client reads do", async () => {
    const base = DEFAULT_SCENARIOS.find((entry) => entry.id === "env10-mixed-c0-pr-wf200")!;
    const none = await runScenario(base, SHORT);
    const two = await runScenario({ ...base, id: "two", clients: 2 }, SHORT);
    for (const kind of ["diff-scan", "pr-detection", "tmux-poll"] as const) {
      expect(two.idle[kind]?.started).toBe(none.idle[kind]?.started);
    }
    expect(none.idle["file-list-read"]).toBeUndefined();
    // Each client polls every 5 s; the 3 s shared cache rarely serves them.
    expect(two.idle["file-list-read"]?.requested).toBe(2 * (SHORT.idleMs / 5_000));
    // The local fetch TTL means repeated scans rarely fetch.
    expect(two.idle["git-fetch-local"]?.cacheHits ?? 0).toBeGreaterThan(
      two.idle["git-fetch-local"]?.started ?? 0,
    );
  });

  test("a confirmed worktree signal leaves a quiet container only its safety scan", async () => {
    const base = DEFAULT_SCENARIOS.find((entry) => entry.id === "env1-container-c1")!;
    const timers = await runScenario({ ...base, id: "timers", claudeStateSignal: true }, SHORT);
    const signals = await runScenario(
      { ...base, id: "signals", claudeStateSignal: true, worktreeSignal: true },
      SHORT,
    );
    const minutes = SHORT.idleMs / 60_000;
    // 15 s background scans plus a status exec per panel read past 3 s.
    expect(timers.idle["diff-scan"]?.started).toBeGreaterThan(4 * minutes);
    // One 60 s safety scan a minute, and the panel reads are all served.
    expect(signals.idle["diff-scan"]?.started).toBe(minutes);
    expect(signals.idle["file-tree-read"]?.started ?? 0).toBeLessThanOrEqual(minutes);
    expect(signals.idle["tmux-poll"]?.started).toBe(timers.idle["tmux-poll"]?.started);
  });

  test("comparison reports every differing counter", async () => {
    const input = DEFAULT_SCENARIOS[0]!;
    const baseline = await runBaseline({
      scenarios: [input],
      phases: SHORT,
      environment,
      nativeObservation: false,
      workflows: false,
    });
    const candidate = structuredClone(baseline);
    candidate.scenarios[0]!.idle["diff-scan"]!.started = 999;
    expect(compareBaselines(baseline, candidate)).toEqual([
      {
        scenario: input.id,
        phase: "idle",
        kind: "diff-scan",
        field: "started",
        baseline: baseline.scenarios[0]!.idle["diff-scan"]!.started!,
        candidate: 999,
      },
    ]);
  });
});

describe("driven native observation baseline (step 07)", () => {
  const fixture = {
    ...DEFAULT_NATIVE_FIXTURE,
    windowMs: 4 * 60_000,
    externalStartAtMs: 60_000,
    externalStartWithEventAtMs: 150_000,
  };

  test("is deterministic, content-free, and sharing drops reads without losing edges", async () => {
    const first = await runNativeObservationBaseline(fixture);
    const second = await runNativeObservationBaseline(fixture);
    expect(second).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("env-0");
    expect(serialized).not.toContain("provider-");
    expect(serialized).not.toContain("synthetic queued prompt");

    const { rollback, shared } = first.modes;
    expect(shared.sweeps).toBe(rollback.sweeps);
    // Busy queues no longer pay tab-facing (liveness-touching) status reads.
    expect(rollback.statusReads).toBeGreaterThan(0);
    expect(shared.statusReads).toBe(0);
    // Only qualified (OpenCode) idle groups back off; the rest read every sweep.
    expect(shared.observationReads).toBeLessThan(rollback.observationReads);
    expect(shared.retainedGroupPasses).toBeGreaterThan(0);
    expect(rollback.retainedGroupPasses).toBe(0);
    // Every externally started turn is still seen, within the 4 s budget,
    // whether or not its provider event arrived, and ends once.
    for (const counts of [rollback, shared]) {
      expect(counts.externalStartDiscoveryMs).not.toBeNull();
      expect(counts.externalStartDiscoveryMs!).toBeLessThanOrEqual(4_000);
      expect(counts.externalStartWithEventDiscoveryMs!).toBeLessThanOrEqual(2_000);
      expect(counts.externalEndDiscoveryMs!).toBeLessThanOrEqual(4_000);
    }
    expect(shared.turnEndEdges).toBe(rollback.turnEndEdges);
    // Four runs over a real on-disk store take about a second on an idle
    // host, but aggregate load has stretched them past five (flake 0177).
  }, 30_000);
});

// Storage reads plus stats each workflow attempt may cost, from the current
// supervisors (whole-store ticks list the store and read each active record;
// looped review reads a record's row four times and claims it once per pass;
// a multi-review pass reads its record ten times, under either driver).
// Raise one only for a reviewed reason.
const STORAGE_PER_ATTEMPT = {
  rollback: { "feature-planning": 3, "build-pipeline": 4, "looped-review": 12, "multi-review": 10 },
  keyed: { "feature-planning": 1, "build-pipeline": 2, "looped-review": 5, "multi-review": 10 },
} as const;
const DOMAINS = ["feature-planning", "build-pipeline", "looped-review", "multi-review"] as const;

describe("driven workflow supervision baseline (step 08)", () => {
  test.each([0, 30])(
    "a cold feature-planning pass fetches one plan row with %s historical plans",
    async (history) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "ork-planning-bytes-"));
      const storage = new StorageService(directory);
      const writer = new StorageService(directory);
      const activity = mock(async () => "working" as const);
      const service = new FeaturePlanningService(storage, async <T>() => undefined as T, {
        keyedScheduling: true,
        autoAdvance: false,
        provider: async () => ({
          agent: "codex",
          createSession: async () => "session-1",
          send: async () => {},
          status: async () => "running",
          activity,
          messages: async () => [],
          structured: async () => null,
          abort: async () => {},
        }),
      });
      try {
        await storage.init();
        for (let index = 0; index < history; index += 1)
          await storage.kanban.createFeaturePlan("project-1");
        const plan = await storage.kanban.createFeaturePlan("project-1");
        const timestamp = new Date().toISOString();
        await storage.kanban.startFeaturePlanning({
          version: 1,
          operationId: "operation-1",
          featureId: plan.id,
          projectId: "project-1",
          kind: "feature",
          userMessage: "synthetic",
          environmentId: "env-planning",
          phase: "running",
          providerSessionId: "session-1",
          startedAt: timestamp,
          dispatchedAt: timestamp,
          updatedAt: timestamp,
          backendRevision: 0,
        });
        await service.init();
        await writer.init();
        // A foreign write makes the plan cache stale before each pass. Otherwise
        // a whole-store regression could fetch zero bytes from a warm cache.
        for (let pass = 0; pass < 2; pass += 1) {
          const updated = await writer.kanban.updateFeaturePlan(plan.id, {
            title: `fixture-${pass}`,
          });
          recurringWorkMetrics.reset();
          await recurringWorkMetrics.observe("feature-planning-tick", () =>
            service.advanceNow(plan.id),
          );
          const counts = recurringWorkMetrics.snapshot().kinds["feature-planning-tick"]!;
          const storageBytes = counts.bytes;
          expect(counts.workUnits["storage-read"]).toBe(1);
          expect(storageBytes).toBeGreaterThan(0);
          expect(storageBytes).toBe(JSON.stringify(updated).length);
        }
        expect(activity).toHaveBeenCalledTimes(2);
      } finally {
        await service.shutdown();
        writer.close();
        storage.close();
        recurringWorkMetrics.reset();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("is deterministic, content-free, and keyed selection no longer scales with history", async () => {
    const fixture = { completedPerStore: 30, activePerStore: 2, windowMs: 90_000 };
    const first = await runWorkflowBaseline(fixture);
    const second = await runWorkflowBaseline(fixture);
    expect(second).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("env-");
    expect(serialized).not.toContain("synthetic");
    const { rollback, keyed } = first.modes;
    const records = fixture.completedPerStore + fixture.activePerStore;
    for (const domain of ["build-pipeline", "looped-review"] as const) {
      // The whole-store tick enumerates every record every tick…
      expect(rollback[domain].recordsScanned).toBeGreaterThanOrEqual(
        (fixture.windowMs / 1_500) * records,
      );
    }
    // …multi review's due scheduler at start and every 15 s…
    expect(rollback["multi-review"].recordsScanned).toBe((1 + fixture.windowMs / 15_000) * records);
    for (const domain of ["build-pipeline", "looped-review", "multi-review"] as const) {
      // …and the keyed driver only at start and every 30 s.
      expect(keyed[domain].recordsScanned).toBe(4 * records);
    }
    for (const domain of ["feature-planning", "build-pipeline", "looped-review"] as const) {
      // Active work is supervised at the same cadence in both modes.
      expect(
        Math.abs(keyed[domain].providerReads - rollback[domain].providerReads),
      ).toBeLessThanOrEqual(fixture.activePerStore * 2);
    }
    // Both multi-review drivers observe running reviewers every 3 s plus the
    // same stable jitter, and every pass reads each reviewer.
    expect(keyed["multi-review"].providerReads).toBeGreaterThan(0);
    expect(keyed["multi-review"].providerReads).toBe(rollback["multi-review"].providerReads);
    expect(keyed["multi-review"].providerReads % 2).toBe(0);
    // Every attempt reads storage, and none reads more than its budget, cache
    // or not: one extra read per attempt breaks a budget.
    for (const mode of ["rollback", "keyed"] as const) {
      for (const domain of DOMAINS) {
        const counts = first.modes[mode][domain];
        const storage = counts.storageReads + counts.storageStats;
        expect(storage).toBeGreaterThanOrEqual(counts.attempts);
        expect(storage).toBeLessThanOrEqual(STORAGE_PER_ATTEMPT[mode][domain] * counts.attempts);
      }
    }
    // A feature-planning pass reads its plan's row once; a warm row cache
    // serves it and it still counts. A whole-store tick also lists the store
    // first.
    expect(keyed["feature-planning"].storageReads).toBe(keyed["feature-planning"].attempts);
    // The driven fixture's plan cache is warm. Cold passes above assert the
    // one-row byte cost independently of the amount of stored history.
    expect(keyed["feature-planning"].storageBytes).toBe(0);
    expect(rollback["feature-planning"].storageReads).toBe(
      rollback["feature-planning"].attempts * (1 + fixture.activePerStore),
    );
    // Build pipelines reuse their decoded control records between writes.
    expect(keyed["build-pipeline"].storageStats).toBeGreaterThan(
      keyed["build-pipeline"].storageReads,
    );
    // Two complete runs over a real on-disk store: seconds of I/O even when
    // idle, so the default five-second budget fails under aggregate load.
  }, 60_000);
});

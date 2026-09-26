import { describe, expect, test } from "bun:test";
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
  });
});

describe("driven workflow supervision baseline (step 08)", () => {
  test("is deterministic, content-free, and keyed selection no longer scales with history", async () => {
    const fixture = { completedPerStore: 30, activePerStore: 2, windowMs: 90_000 };
    const first = await runWorkflowBaseline(fixture);
    const second = await runWorkflowBaseline(fixture);
    expect(second).toEqual(first);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("env-");
    expect(serialized).not.toContain("synthetic");
    const { rollback, keyed } = first.modes;
    for (const domain of ["build-pipeline", "looped-review"] as const) {
      // The whole-store tick enumerates every record every tick…
      expect(rollback[domain].recordsScanned).toBeGreaterThanOrEqual(
        (fixture.windowMs / 1_500) * (fixture.completedPerStore + fixture.activePerStore),
      );
      // …the keyed driver only at start and every 30 s.
      expect(keyed[domain].recordsScanned).toBe(
        4 * (fixture.completedPerStore + fixture.activePerStore),
      );
    }
    for (const domain of ["feature-planning", "build-pipeline", "looped-review"] as const) {
      // Active work is supervised at the same cadence in both modes.
      expect(
        Math.abs(keyed[domain].providerReads - rollback[domain].providerReads),
      ).toBeLessThanOrEqual(fixture.activePerStore * 2);
    }
  });
});

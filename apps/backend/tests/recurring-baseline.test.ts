import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SCENARIOS,
  compareBaselines,
  runBaseline,
  runScenario,
  type BaselinePhases,
} from "../scripts/recurring-baseline-harness.js";

const SHORT: BaselinePhases = { startupMs: 30_000, idleMs: 6 * 60_000, clientRefreshMs: 5_000 };
const environment = { commit: "test", platform: "test", arch: "test", runtime: "test" };

describe("recurring-work baseline harness", () => {
  test("is deterministic and content-free", async () => {
    const scenarios = DEFAULT_SCENARIOS.filter((entry) =>
      ["env1-local-c1", "env10-mixed-c2-pr-wf200"].includes(entry.id),
    );
    const first = await runBaseline({ scenarios, phases: SHORT, environment });
    const second = await runBaseline({ scenarios, phases: SHORT, environment });
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
    const baseline = await runBaseline({ scenarios: [input], phases: SHORT, environment });
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

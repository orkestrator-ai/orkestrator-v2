import { describe, expect, test } from "bun:test";
import { graphRunHeaderSummary } from "./graph-run-summary";
import { FIXTURE_AT, runOf } from "./graph-run.test-fixtures";

const START = Date.parse(FIXTURE_AT);

function withLimits(limits: { maxTokens?: number; maxWallClockMs?: number }, mock = false) {
  const run = runOf("multi-review", { usage: { agentSessions: 2, tokens: 2_500 }, mock });
  return { ...run, plan: { ...run.plan, limits: { ...run.plan.limits, ...limits } } };
}

describe("graphRunHeaderSummary", () => {
  test("shows nodes, elapsed time and tokens without limits", () => {
    expect(
      graphRunHeaderSummary(withLimits({}), { reached: 2, total: 5, now: START + 90_000 }),
    ).toBe("2 of 5 nodes · 1m 30s · 2.5k tokens");
  });

  test("shows usage against the token and wall-clock limits", () => {
    expect(
      graphRunHeaderSummary(withLimits({ maxTokens: 50_000, maxWallClockMs: 3_600_000 }), {
        reached: 2,
        total: 5,
        now: START + 90_000,
      }),
    ).toBe("2 of 5 nodes · 1m 30s of 1h 0m 0s · 2.5k of 50k tokens");
  });

  test("a mock run shows no token limit (it is never metered)", () => {
    const run = withLimits({ maxTokens: 50_000 }, true);
    expect(
      graphRunHeaderSummary(
        { ...run, usage: { agentSessions: 0, tokens: 0 } },
        { reached: 0, total: 5, now: START },
      ),
    ).toBe("0 of 5 nodes · 0s");
  });
});

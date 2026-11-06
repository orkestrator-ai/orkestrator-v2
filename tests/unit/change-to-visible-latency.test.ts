import { describe, expect, test } from "bun:test";
import { assertLatencyBudgets, latencySummary } from "../../e2e/agent-testing/latency-budget";

const rows = [
  ["local badge (watched)", 2_400],
  ["local Changes row", 6_000],
  ["local All files entry", 6_000],
  ["container badge", 20_000],
  ["container Changes row", 6_000],
  ["container All files entry", 6_000],
  ["container All files after Refresh", 1_000],
] as const;

describe("change-to-visible qualification budgets", () => {
  for (const [label, budgetMs] of rows) {
    test(`${label} enforces p95, including its boundary`, () => {
      const entry = { label, budgetMs, samples: Array<number>(19).fill(budgetMs) };
      entry.samples.push(budgetMs + 1);
      expect(() => assertLatencyBudgets([entry])).not.toThrow();
      expect(latencySummary(entry).p95Ms).toBe(budgetMs);
      entry.samples[0] = budgetMs + 1;
      expect(() => assertLatencyBudgets([entry])).toThrow(
        `${label}: p95 ${budgetMs + 1} ms exceeds ${budgetMs} ms`,
      );
    });
  }

  test("the known Changes-refresh exception is visible and cannot exempt other rows", () => {
    const exception = {
      label: "container Changes after Refresh",
      budgetMs: 1_000,
      samples: Array<number>(15).fill(2_230),
    };
    expect(latencySummary(exception)).toMatchObject({
      p95Ms: 2_230,
      budgetMs: 1_000,
      withinBudget: false,
      budgetException: expect.stringContaining("7201"),
    });
    expect(() => assertLatencyBudgets([exception])).not.toThrow();
    const other = { ...exception, label: "container All files after Refresh" };
    expect(latencySummary(other).budgetException).toBeNull();
    expect(() => assertLatencyBudgets([exception, other])).toThrow(other.label);
  });

  test("empty or invalid samples cannot pass qualification, even for the exception", () => {
    for (const samples of [[], [NaN], [Infinity], [-1]]) {
      expect(() =>
        assertLatencyBudgets([
          { label: "container Changes after Refresh", budgetMs: 1_000, samples },
        ]),
      ).toThrow("no valid latency sample set");
    }
  });
});

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

  test("scan-wait qualification cannot pass without independent timing evidence", () => {
    for (const samples of [Array<number>(15).fill(5_000), [425, 1_304], [500]]) {
      const entry = {
        label: "container Changes after Refresh",
        budgetMs: 1_000,
        scanAllowance: true,
        samples,
      };
      expect(latencySummary(entry)).toMatchObject({
        scanAllowanceMs: null,
        effectiveBudgetMs: 1_000,
        qualificationVerified: false,
        withinBudget: null,
      });
      expect(() => assertLatencyBudgets([entry])).toThrow("scan-wait qualification unverified");
    }
  });

  test("uniformly slow refreshes without overlap fail the base budget", () => {
    expect(() =>
      assertLatencyBudgets([
        { label: "refresh", budgetMs: 1_000, samples: Array<number>(15).fill(5_000) },
      ]),
    ).toThrow("exceeds 1000 ms");
  });

  test("the allowance is per series, so no other row inherits it by label or default", () => {
    const samples = [...Array<number>(14).fill(425), 1_304];
    const allFiles = { label: "container All files after Refresh", budgetMs: 1_000, samples };
    expect(latencySummary(allFiles)).toMatchObject({
      scanAllowanceMs: null,
      effectiveBudgetMs: 1_000,
      withinBudget: false,
    });
    expect(() => assertLatencyBudgets([allFiles])).toThrow(allFiles.label);
    // The Changes label alone, without the allowance, is held to 1 s.
    const unmarked = { ...allFiles, label: "container Changes after Refresh" };
    expect(() => assertLatencyBudgets([unmarked])).toThrow("exceeds 1000 ms");
  });

  test("empty or invalid samples cannot pass qualification, even with the allowance", () => {
    for (const samples of [[], [NaN], [Infinity], [-1]]) {
      expect(() =>
        assertLatencyBudgets([
          {
            label: "container Changes after Refresh",
            budgetMs: 1_000,
            scanAllowance: true,
            samples,
          },
        ]),
      ).toThrow("no valid latency sample set");
    }
  });
});

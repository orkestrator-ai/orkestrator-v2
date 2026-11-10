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

  test("the Changes refresh may take one scan longer, estimated by its median (7201)", () => {
    // Shaped like the second macOS run of 0048 task 2 (p50 425 ms; 14 refreshes
    // of 317 to 635 ms and one of 1,304 ms); the values between the recorded
    // endpoints and median are illustrative.
    const samples = [317, 340, 362, 380, 401, 410, 425, 425, 440, 470, 512, 560, 600, 635, 1_304];
    const changes = {
      label: "container Changes after Refresh",
      budgetMs: 1_000,
      scanAllowance: true,
      samples,
    };
    expect(latencySummary(changes)).toMatchObject({
      p50Ms: 425,
      p95Ms: 1_304,
      budgetMs: 1_000,
      scanAllowanceMs: 425,
      effectiveBudgetMs: 1_425,
      withinBudget: true,
    });
    expect(() => assertLatencyBudgets([changes])).not.toThrow();

    // More than one scan behind is still a failure.
    const slower = { ...changes, samples: [...samples.slice(0, -1), 1_426] };
    expect(() => assertLatencyBudgets([slower])).toThrow(
      "container Changes after Refresh: p95 1426 ms exceeds 1425 ms (1000 ms plus one scan)",
    );
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

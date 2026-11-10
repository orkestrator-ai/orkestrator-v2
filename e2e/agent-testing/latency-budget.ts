/**
 * A latency series against its p95 budget in docs/architecture/recurring-work.md
 * ("Latency budgets").
 *
 * `scanAllowance` identifies a conditional scan-wait budget that remains
 * unverified until the caller measures scan overlap and duration independently.
 * Refresh latency itself must never increase its own acceptance threshold.
 */
export type LatencySeries = {
  label: string;
  budgetMs?: number;
  scanAllowance?: boolean;
  samples: number[];
};

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

export function latencySummary(series: LatencySeries) {
  const p50Ms = percentile(series.samples, 0.5);
  const p95Ms = percentile(series.samples, 0.95);
  const scanAllowanceMs = null;
  const effectiveBudgetMs = series.budgetMs ?? null;
  return {
    label: series.label,
    count: series.samples.length,
    p50Ms,
    p95Ms,
    maxMs: Math.max(...series.samples),
    budgetMs: series.budgetMs ?? null,
    scanAllowanceMs,
    effectiveBudgetMs,
    qualificationVerified: !series.scanAllowance,
    withinBudget:
      series.scanAllowance || effectiveBudgetMs === null ? null : p95Ms <= effectiveBudgetMs,
    samplesMs: series.samples,
  };
}

/** Fail qualification on any p95 overrun of a row's (effective) budget. */
export function assertLatencyBudgets(series: readonly LatencySeries[]): void {
  const failures: string[] = [];
  for (const entry of series) {
    if (entry.budgetMs === undefined) continue;
    if (!entry.samples.length || entry.samples.some((ms) => !Number.isFinite(ms) || ms < 0)) {
      failures.push(`${entry.label}: no valid latency sample set`);
      continue;
    }
    const result = latencySummary(entry);
    if (!result.qualificationVerified) {
      failures.push(
        `${entry.label}: scan-wait qualification unverified; independent scan overlap and duration required`,
      );
      continue;
    }
    if (!result.withinBudget) {
      failures.push(
        `${entry.label}: p95 ${result.p95Ms} ms exceeds ${result.effectiveBudgetMs} ms`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

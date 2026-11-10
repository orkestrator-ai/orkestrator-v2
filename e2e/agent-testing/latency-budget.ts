/**
 * A latency series against its p95 budget in docs/architecture/recurring-work.md
 * ("Latency budgets").
 *
 * `scanAllowance` marks a row whose budget is "≤ budgetMs, or one scan longer
 * when a scan is already running" (to-do 7201): an explicit refresh that lands
 * while a scan runs waits for that scan and then a fresh one, because the
 * running scan may predate the click. One scan is estimated by the series' own
 * median: most refreshes do not land behind a running scan, so a typical
 * refresh costs one scan plus rendering, which is never less than the scan
 * alone. The allowance is set per series by the spec, never by label here.
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
  const scanAllowanceMs = series.budgetMs !== undefined && series.scanAllowance ? p50Ms : null;
  const effectiveBudgetMs =
    series.budgetMs === undefined ? null : series.budgetMs + (scanAllowanceMs ?? 0);
  return {
    label: series.label,
    count: series.samples.length,
    p50Ms,
    p95Ms,
    maxMs: Math.max(...series.samples),
    budgetMs: series.budgetMs ?? null,
    scanAllowanceMs,
    effectiveBudgetMs,
    withinBudget: effectiveBudgetMs === null ? null : p95Ms <= effectiveBudgetMs,
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
    if (!result.withinBudget) {
      const allowance =
        result.scanAllowanceMs === null ? "" : ` (${entry.budgetMs} ms plus one scan)`;
      failures.push(
        `${entry.label}: p95 ${result.p95Ms} ms exceeds ${result.effectiveBudgetMs} ms${allowance}`,
      );
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

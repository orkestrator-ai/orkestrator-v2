export type LatencySeries = { label: string; budgetMs?: number; samples: number[] };

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(fraction * sorted.length) - 1]!;
}

export function latencySummary(series: LatencySeries) {
  const p95Ms = percentile(series.samples, 0.95);
  return {
    label: series.label,
    count: series.samples.length,
    p50Ms: percentile(series.samples, 0.5),
    p95Ms,
    maxMs: Math.max(...series.samples),
    budgetMs: series.budgetMs ?? null,
    withinBudget: series.budgetMs === undefined ? null : p95Ms <= series.budgetMs,
    // This is an outstanding qualification gap, not an accepted larger budget.
    // Keep its measured overrun visible while enforcing every other row.
    budgetException:
      series.label === "container Changes after Refresh"
        ? "7201: explicit refresh may wait for an in-flight scan; budget decision still open"
        : null,
    samplesMs: series.samples,
  };
}

/** Fail qualification on p95 overruns, preserving the single documented exception. */
export function assertLatencyBudgets(series: readonly LatencySeries[]): void {
  const failures: string[] = [];
  for (const entry of series) {
    if (entry.budgetMs === undefined) continue;
    if (!entry.samples.length || entry.samples.some((ms) => !Number.isFinite(ms) || ms < 0)) {
      failures.push(`${entry.label}: no valid latency sample set`);
      continue;
    }
    const result = latencySummary(entry);
    if (!result.withinBudget && !result.budgetException) {
      failures.push(`${entry.label}: p95 ${result.p95Ms} ms exceeds ${entry.budgetMs} ms`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

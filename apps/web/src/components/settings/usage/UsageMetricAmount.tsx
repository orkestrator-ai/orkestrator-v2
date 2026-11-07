import type { UsageTotals } from "@/lib/backend";
import { CostAmount } from "@/components/usage/CostAmount";
import { formatMetric, metricValue, type UsageMetric } from "./usage-format";

/**
 * A bucket's value in the metric on screen. Spend says whether it is an
 * estimate (see `CostAmount`), from the bucket's own combined `costSource`;
 * tokens are plain counts.
 */
export function UsageMetricAmount({
  totals,
  metric,
  value = metricValue(totals, metric),
}: {
  totals: UsageTotals;
  metric: UsageMetric;
  /** Overrides the bucket's own value, for a sum drawn from the same bucket. */
  value?: number;
}) {
  if (metric !== "cost") return <>{formatMetric(value, metric)}</>;
  return <CostAmount amount={formatMetric(value, metric)} source={totals.costSource} />;
}

import { useMemo, useState } from "react";
import { UNKNOWN_USAGE_MODEL_ID } from "@orkestrator/protocol/usage-history";
import type { UsageDayPoint, UsageModelSummary } from "@/lib/backend";
import { AgentPlatformIcon } from "@/components/icons/AgentIcons";
import { SegmentedSelector } from "@/components/ui/segmented-selector";
import { cn } from "@/lib/utils";
import {
  PLATFORM_BAR_CLASS,
  formatCost,
  formatDayLabel,
  formatShare,
  formatTokens,
  metricValue,
  type UsageMetric,
} from "./usage-format";

/**
 * The ranked breakdown under the chart, by model or by day.
 *
 * Both axes are the same rows of the same report, so the table never asks the
 * backend for anything: switching between them is a re-sort, not a reload.
 * A model whose provider reports no price shows `Unpriced` rather than `$0.00`
 * — the app keeps no price table of its own, and a zero there would read as
 * free.
 */

type BreakdownAxis = "model" | "day";

export interface UsageBreakdownTableProps {
  models: readonly UsageModelSummary[];
  days: readonly UsageDayPoint[];
  metric: UsageMetric;
}

export function UsageBreakdownTable({ models, days, metric }: UsageBreakdownTableProps) {
  const [axis, setAxis] = useState<BreakdownAxis>("model");

  const rows = useMemo(() => {
    if (axis === "model") {
      return models
        .map((entry) => ({
          key: `${entry.platform}:${entry.modelId}`,
          label: entry.modelId === UNKNOWN_USAGE_MODEL_ID ? "Unnamed model" : entry.modelId,
          platform: entry.platform,
          totals: entry.totals,
        }))
        .sort(
          (left, right) => metricValue(right.totals, metric) - metricValue(left.totals, metric),
        );
    }
    return days
      .filter((point) => point.totals.totalTokens > 0 || point.totals.costUsd > 0)
      .map((point) => ({
        key: point.day,
        label: formatDayLabel(point.day, { year: true }),
        platform: undefined,
        totals: point.totals,
      }))
      .sort((left, right) => metricValue(right.totals, metric) - metricValue(left.totals, metric));
  }, [axis, days, metric, models]);

  const whole = rows.reduce((sum, row) => sum + metricValue(row.totals, metric), 0);
  const largest = Math.max(...rows.map((row) => metricValue(row.totals, metric)), 1);

  return (
    <section aria-label="Usage breakdown" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">Breakdown</h3>
        <SegmentedSelector
          ariaLabel="Break usage down by"
          value={axis}
          onValueChange={setAxis}
          options={[
            { value: "model", label: "Model" },
            { value: "day", label: "Day" },
          ]}
        />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
          Nothing recorded in this range yet.
        </p>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-muted-foreground/80">
              <th scope="col" className="w-8 py-1.5 text-left font-medium">
                #
              </th>
              <th scope="col" className="py-1.5 text-left font-medium">
                {axis === "model" ? "Model" : "Day"}
              </th>
              <th scope="col" className="w-24 py-1.5 text-right font-medium">
                Cost
              </th>
              <th scope="col" className="w-20 py-1.5 text-right font-medium">
                Share
              </th>
              <th scope="col" className="w-24 py-1.5 text-right font-medium">
                Tokens
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.key} className="border-t border-border/40">
                <td className="py-2 text-muted-foreground tabular-nums">{index + 1}</td>
                <td className="min-w-0 py-2">
                  <div className="flex items-center gap-2">
                    {row.platform ? (
                      <AgentPlatformIcon
                        platform={row.platform}
                        accent
                        className="h-3.5 w-3.5 shrink-0"
                      />
                    ) : null}
                    <span className="truncate text-foreground" title={row.label}>
                      {row.label}
                    </span>
                  </div>
                  <div className="mt-1 h-0.5 w-full overflow-hidden rounded-full bg-muted/40">
                    <div
                      className={cn(
                        "h-full",
                        row.platform ? PLATFORM_BAR_CLASS[row.platform] : "bg-foreground/50",
                      )}
                      style={{
                        width: `${(metricValue(row.totals, metric) / largest) * 100}%`,
                      }}
                    />
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums text-foreground">
                  {row.totals.costUsd > 0 ? (
                    formatCost(row.totals.costUsd)
                  ) : (
                    <span className="text-muted-foreground">Unpriced</span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground">
                  {formatShare(metricValue(row.totals, metric), whole)}
                </td>
                <td className="py-2 text-right tabular-nums text-foreground">
                  {formatTokens(row.totals.totalTokens)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

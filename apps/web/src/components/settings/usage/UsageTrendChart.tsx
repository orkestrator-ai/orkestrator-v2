import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { AGENT_PLATFORM_LABELS } from "@orkestrator/protocol/agent-platforms";
import type { UsageDayPoint } from "@/lib/backend";
import { AgentPlatformIcon, PLATFORM_ICON_CLASS } from "@/components/icons/AgentIcons";
import { smoothAreaPath, smoothLinePath } from "./usage-chart-path";
import { formatDayLabel, formatMetric, metricValue, type UsageMetric } from "./usage-format";

/**
 * The full-width daily chart: one smoothed line per platform, each reading
 * that platform's own daily total rather than a stacked edge — the line a
 * reader traces is the number the legend and the breakdown table show.
 * Lines are drawn heaviest first so a thin series sits on top of a thick one.
 *
 * The SVG is drawn in a unit box and stretched by the browser
 * (`preserveAspectRatio="none"`), so the card can be any width without this
 * component measuring anything — which also keeps it rendering under a test
 * DOM that reports no layout. Nothing inside the SVG is text: gridline and
 * axis labels are HTML on top of it, where stretching cannot distort them.
 *
 * Pointer hover and the arrow keys select the same day, so the readout is
 * reachable without a mouse; the breakdown table below the chart carries the
 * identical numbers as rows for anyone reading it as data.
 */

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 200;
const GRID_LINES = 4;

export interface UsageTrendChartProps {
  days: readonly UsageDayPoint[];
  /** Heaviest first; later lines are drawn over earlier ones. */
  platforms: readonly AgentPlatform[];
  metric: UsageMetric;
}

/**
 * The smallest round number at or above `value`, for the top gridline. The
 * ladder is fine enough that a peak just past a power of ten does not double
 * the scale and squash the whole chart into its lower half.
 */
export function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8]) {
    const candidate = step * magnitude;
    if (candidate >= value) return candidate;
  }
  return 10 * magnitude;
}

export function UsageTrendChart({ days, platforms, metric }: UsageTrendChartProps) {
  const labelId = useId();
  const [selected, setSelected] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);

  const { byDay, dayTotals, max } = useMemo(() => {
    const perDay = days.map((point) => {
      const values = new Map<AgentPlatform, number>();
      for (const entry of point.platforms) {
        values.set(entry.platform, metricValue(entry.totals, metric));
      }
      return values;
    });
    const totals = perDay.map((values) => [...values.values()].reduce((sum, v) => sum + v, 0));
    // The lines overlay rather than stack, so the scale is the busiest single
    // platform-day, not the busiest day.
    const busiest = perDay.reduce((highest, values) => Math.max(highest, ...values.values()), 0);
    return { byDay: perDay, dayTotals: totals, max: niceCeiling(busiest) };
  }, [days, metric]);

  const y = useCallback((value: number) => VIEW_HEIGHT - (value / max) * VIEW_HEIGHT, [max]);

  // A single day has no line to draw between points, so it is widened into a
  // flat slab across the plot rather than collapsing to an invisible column.
  const columns = useMemo(() => {
    if (days.length === 0) return [] as Array<{ x: number; day: number }>;
    if (days.length === 1) {
      return [
        { x: 0, day: 0 },
        { x: VIEW_WIDTH, day: 0 },
      ];
    }
    return days.map((_, index) => ({ x: (index / (days.length - 1)) * VIEW_WIDTH, day: index }));
  }, [days]);

  const bands = useMemo(
    () =>
      platforms.map((platform) => {
        const points = columns.map((column) => ({
          x: column.x,
          y: y(byDay[column.day]?.get(platform) ?? 0),
        }));
        const used = columns.some((column) => (byDay[column.day]?.get(platform) ?? 0) > 0);
        return {
          platform,
          area: smoothAreaPath(points, VIEW_HEIGHT),
          line: smoothLinePath(points),
          used,
        };
      }),
    [byDay, columns, platforms, y],
  );

  const clamp = useCallback(
    (index: number) => Math.min(Math.max(index, 0), Math.max(days.length - 1, 0)),
    [days.length],
  );

  const pointerDay = useCallback(
    (clientX: number): number | null => {
      const bounds = plotRef.current?.getBoundingClientRect();
      if (!bounds || bounds.width <= 0 || days.length === 0) return null;
      const ratio = (clientX - bounds.left) / bounds.width;
      return clamp(Math.round(ratio * Math.max(days.length - 1, 0)));
    },
    [clamp, days.length],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (days.length === 0) return;
    const current = selected ?? days.length - 1;
    if (event.key === "ArrowLeft") setSelected(clamp(current - 1));
    else if (event.key === "ArrowRight") setSelected(clamp(current + 1));
    else if (event.key === "Home") setSelected(0);
    else if (event.key === "End") setSelected(days.length - 1);
    else if (event.key === "Escape") setSelected(null);
    else return;
    event.preventDefault();
  };

  const active = selected === null ? null : days[selected];
  const activeTotal = selected === null ? 0 : (dayTotals[selected] ?? 0);
  const gridValues = Array.from(
    { length: GRID_LINES },
    (_, index) => (max / GRID_LINES) * (index + 1),
  );
  const empty = dayTotals.every((total) => total === 0);
  // Tokens the provider priced at nothing are usage, not absence. Saying
  // nothing was recorded would contradict the breakdown table and the
  // platform list, which both label the same rows `Unpriced`.
  const unpricedOnly =
    empty && metric === "cost" && days.some((point) => point.totals.totalTokens > 0);

  return (
    <div className="relative">
      {/* The scale labels own a gutter of their own: drawn over the plot they
          sat on top of the bands, which is exactly where the values are. */}
      <div className="relative h-[200px] w-full">
        <div className="pointer-events-none absolute inset-y-0 left-0 w-12" aria-hidden="true">
          {gridValues.map((value) => (
            <span
              key={value}
              style={{ top: `${(1 - value / max) * 100}%` }}
              className="absolute right-1.5 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground/70"
            >
              {formatMetric(value, metric)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          role="group"
          tabIndex={0}
          aria-labelledby={labelId}
          onKeyDown={onKeyDown}
          onMouseMove={(event) => setSelected(pointerDay(event.clientX))}
          onMouseLeave={() => setSelected(null)}
          className="absolute inset-y-0 left-12 right-0 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span id={labelId} className="sr-only">
            {`Daily ${metric === "cost" ? "spend" : "processed tokens"} by platform. Arrow keys read one day.`}
          </span>
          <svg
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            className="h-full w-full"
            aria-hidden="true"
          >
            {gridValues.map((value) => (
              <line
                key={value}
                x1={0}
                x2={VIEW_WIDTH}
                y1={y(value)}
                y2={y(value)}
                className="stroke-border/60"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {bands.map((band) =>
              band.used ? (
                <g key={band.platform} className={PLATFORM_ICON_CLASS[band.platform]}>
                  {/* The bands overlap, so each one is faint enough to read
                      the lines through; the line is what carries the value. */}
                  <path d={band.area} fill="currentColor" fillOpacity={0.12} />
                  <path
                    d={band.line}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ) : null,
            )}
            {selected !== null && columns.length > 2 ? (
              <line
                x1={columns[selected]?.x ?? 0}
                x2={columns[selected]?.x ?? 0}
                y1={0}
                y2={VIEW_HEIGHT}
                className="stroke-foreground/40"
                strokeWidth={1}
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
          </svg>
          {empty ? (
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              {unpricedOnly ? "No priced spend in this range." : "No usage recorded in this range."}
            </p>
          ) : null}
        </div>
      </div>

      <div className="ml-12 mt-1 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>{days.length > 0 ? formatDayLabel(days[0]!.day) : ""}</span>
        <span>{days.length > 1 ? formatDayLabel(days[days.length - 1]!.day) : ""}</span>
      </div>

      <div aria-live="polite" className="sr-only">
        {active
          ? `${formatDayLabel(active.day, { year: true })}: ${formatMetric(activeTotal, metric)}`
          : ""}
      </div>

      {active ? (
        <div
          className="pointer-events-none absolute right-0 top-0 min-w-44 rounded-lg border border-border/70 bg-popover/95 p-2.5 text-xs shadow-lg"
          data-testid="usage-chart-readout"
        >
          <p className="font-medium text-foreground">
            {formatDayLabel(active.day, { year: true })}
          </p>
          <ul className="mt-1.5 space-y-1">
            {active.platforms.length === 0 ? (
              <li className="text-muted-foreground">No usage</li>
            ) : (
              active.platforms.map((entry) => (
                <li key={entry.platform} className="flex items-center gap-2">
                  <AgentPlatformIcon platform={entry.platform} accent className="h-3 w-3" />
                  <span className="flex-1 text-muted-foreground">
                    {AGENT_PLATFORM_LABELS[entry.platform]}
                  </span>
                  <span className="tabular-nums text-foreground">
                    {formatMetric(metricValue(entry.totals, metric), metric)}
                  </span>
                </li>
              ))
            )}
          </ul>
          {active.platforms.length > 1 ? (
            <p className="mt-1.5 flex items-center justify-between border-t border-border/60 pt-1.5 text-muted-foreground">
              <span>Total</span>
              <span className="tabular-nums text-foreground">
                {formatMetric(activeTotal, metric)}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

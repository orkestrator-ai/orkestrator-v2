import {
  memo,
  useCallback,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ChartScene } from "@orkestrator/protocol/chart-scene";
import {
  CHART_DASH_PATTERNS,
  CHART_MARKERS,
  chartSlotColor,
  type ChartTheme,
} from "@orkestrator/protocol/chart-svg";
import type { ChartInspectItem } from "@/lib/chat/artifact-chart-export";

/**
 * React SVG rendering of a deterministic chart scene. Geometry comes from
 * `buildChartScene`; this file only draws it. Colour is never the only
 * distinction: every palette slot also has a fill pattern (bars, slices) or a
 * dash pattern and marker shape (lines, points).
 *
 * The SVG is one keyboard stop. Arrow keys move a visible focused marker
 * through the marks in source order and announce the exact value; the data
 * view carries the same values as a table, so nobody tabs through thousands of
 * circles.
 */

const PATTERN_PATHS: readonly (string | null)[] = [
  null,
  "M0,6 L6,0",
  "M0,3 L6,3",
  "dots",
  "M0,6 L6,0 M0,0 L6,6",
  "M3,0 L3,6",
];

export function chartPatternId(uid: string, slot: number): string {
  return `${uid}-pattern-${slot % PATTERN_PATHS.length}`;
}

function PatternDefs({ uid, theme }: { uid: string; theme: ChartTheme }) {
  const ink = theme === "dark" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.7)";
  return (
    <defs>
      {PATTERN_PATHS.map((path, index) =>
        path === null ? null : (
          <pattern
            key={index}
            id={chartPatternId(uid, index)}
            width={6}
            height={6}
            patternUnits="userSpaceOnUse"
          >
            {path === "dots" ? (
              <circle cx={3} cy={3} r={1.2} fill={ink} />
            ) : (
              <path d={path} stroke={ink} strokeWidth={1.2} fill="none" />
            )}
          </pattern>
        ),
      )}
    </defs>
  );
}

function patternFill(uid: string, slot: number): string | null {
  return PATTERN_PATHS[slot % PATTERN_PATHS.length] === null
    ? null
    : `url(#${chartPatternId(uid, slot)})`;
}

export function ChartMarker({
  slot,
  x,
  y,
  r,
  color,
  hollowFill,
}: {
  slot: number;
  x: number;
  y: number;
  r: number;
  color: string;
  hollowFill?: string;
}) {
  const marker = CHART_MARKERS[slot % CHART_MARKERS.length]!;
  switch (marker) {
    case "square":
      return <rect x={x - r} y={y - r} width={r * 2} height={r * 2} fill={color} />;
    case "triangle":
      return <polygon points={`${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}`} fill={color} />;
    case "diamond":
      return (
        <polygon points={`${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}`} fill={color} />
      );
    case "cross":
      return (
        <path
          d={`M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`}
          stroke={color}
          strokeWidth={2}
        />
      );
    case "ring":
      return (
        <circle cx={x} cy={y} r={r} fill={hollowFill ?? "none"} stroke={color} strokeWidth={2} />
      );
    default:
      return <circle cx={x} cy={y} r={r} fill={color} />;
  }
}

/** Small legend swatch showing colour plus the non-colour distinction for a slot. */
export function ChartSwatch({
  slot,
  kind,
  theme,
  uid,
}: {
  slot: number;
  kind: ChartScene["kind"];
  theme: ChartTheme;
  uid: string;
}) {
  const color = chartSlotColor(slot, theme);
  const usesArea = kind === "bar" || kind === "donut";
  return (
    <svg width={22} height={12} viewBox="0 0 22 12" aria-hidden="true" className="shrink-0">
      {usesArea ? (
        <>
          <rect x={1} y={1} width={20} height={10} rx={2} fill={color} />
          {patternFill(uid, slot) ? (
            <rect x={1} y={1} width={20} height={10} rx={2} fill={patternFill(uid, slot)!} />
          ) : null}
        </>
      ) : (
        <>
          {kind !== "scatter" ? (
            <line
              x1={1}
              x2={21}
              y1={6}
              y2={6}
              stroke={color}
              strokeWidth={2}
              strokeDasharray={CHART_DASH_PATTERNS[slot % CHART_DASH_PATTERNS.length] || undefined}
            />
          ) : null}
          <ChartMarker slot={slot} x={11} y={6} r={3.5} color={color} />
        </>
      )}
    </svg>
  );
}

function truncateLabel(label: string, maxChars: number): string {
  const limit = Math.max(3, Math.floor(maxChars));
  return label.length > limit ? `${label.slice(0, limit - 1)}…` : label;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface NativeChartSvgProps {
  scene: ChartScene;
  theme: ChartTheme;
  uid: string;
  items: readonly ChartInspectItem[];
  focusedKey: string | null;
  onFocusItem: (key: string | null) => void;
  titleId: string;
  descriptionId: string;
}

export const NativeChartSvg = memo(function NativeChartSvg({
  scene,
  theme,
  uid,
  items,
  focusedKey,
  onFocusItem,
  titleId,
  descriptionId,
}: NativeChartSvgProps) {
  const focused = useMemo(
    () => (focusedKey === null ? null : (items.find((item) => item.key === focusedKey) ?? null)),
    [focusedKey, items],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<SVGSVGElement>) => {
      if (items.length === 0) return;
      const index = focused ? items.indexOf(focused) : -1;
      let next: number | null = null;
      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          next = index < 0 ? 0 : Math.min(items.length - 1, index + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          next = index < 0 ? 0 : Math.max(0, index - 1);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = items.length - 1;
          break;
        case "Escape":
          if (focused) {
            event.preventDefault();
            onFocusItem(null);
          }
          return;
        default:
          return;
      }
      event.preventDefault();
      onFocusItem(items[next]!.key);
    },
    [focused, items, onFocusItem],
  );

  const onMouseMove = useCallback(
    (event: MouseEvent<SVGSVGElement>) => {
      if (scene.kind !== "line" && scene.kind !== "area" && scene.kind !== "scatter") return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const x = ((event.clientX - rect.left) / rect.width) * scene.width;
      const y = ((event.clientY - rect.top) / rect.height) * scene.height;
      let best: ChartInspectItem | null = null;
      let bestDistance = 24 * 24;
      for (const item of items) {
        const distance = (item.px - x) ** 2 + (item.py - y) ** 2;
        if (distance < bestDistance) {
          best = item;
          bestDistance = distance;
        }
      }
      if (best && best.key !== focusedKey) onFocusItem(best.key);
    },
    [focusedKey, items, onFocusItem, scene],
  );

  const marks = useMemo(
    () => renderMarks(scene, theme, uid, onFocusItem),
    [onFocusItem, scene, theme, uid],
  );

  return (
    <svg
      viewBox={`0 0 ${scene.width} ${scene.height}`}
      width="100%"
      role="img"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseMove={onMouseMove}
      onMouseLeave={() => onFocusItem(null)}
      onBlur={() => onFocusItem(null)}
      data-chart-kind={scene.kind}
      className="block h-auto max-h-[70vh] w-full rounded outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      style={{ aspectRatio: `${scene.width} / ${scene.height}` }}
    >
      <PatternDefs uid={uid} theme={theme} />
      {scene.kind !== "donut" ? <CartesianAxes scene={scene} /> : null}
      {marks}
      {focused ? <FocusMarker item={focused} scene={scene} /> : null}
    </svg>
  );
});

function CartesianAxes({ scene }: { scene: Exclude<ChartScene, { kind: "donut" }> }) {
  const { plot } = scene;
  const bottom = plot.y + plot.height;
  const xLabel = scene.xAxis.unit
    ? `${scene.xAxis.label} (${scene.xAxis.unit})`
    : scene.xAxis.label;
  const yLabel = scene.yAxis.unit
    ? `${scene.yAxis.label} (${scene.yAxis.unit})`
    : scene.yAxis.label;
  const band = scene.kind === "bar" ? plot.width / Math.max(1, scene.categories.length) : 0;
  return (
    <g data-part="axes" aria-hidden="true" className="text-[11px]">
      {scene.yAxis.ticks.map((tick) => (
        <g key={`y-${tick.value}`}>
          <line
            x1={plot.x}
            x2={plot.x + plot.width}
            y1={round(tick.position)}
            y2={round(tick.position)}
            className="stroke-border"
          />
          <text
            x={plot.x - 6}
            y={round(tick.position) + 4}
            textAnchor="end"
            className="fill-muted-foreground"
          >
            {tick.label}
          </text>
        </g>
      ))}
      {scene.kind === "bar"
        ? scene.categories.map((category) => (
            <text
              key={category.id}
              x={round(category.center)}
              y={bottom + 16}
              textAnchor="middle"
              className="fill-muted-foreground"
            >
              <title>{category.label}</title>
              {truncateLabel(category.label, band / 6.5)}
            </text>
          ))
        : scene.xAxis.ticks.map((tick) => (
            <g key={`x-${tick.value}`}>
              <line
                x1={round(tick.position)}
                x2={round(tick.position)}
                y1={plot.y}
                y2={bottom}
                className="stroke-border"
              />
              <text
                x={round(tick.position)}
                y={bottom + 16}
                textAnchor="middle"
                className="fill-muted-foreground"
              >
                {tick.label}
              </text>
            </g>
          ))}
      <text
        x={plot.x + plot.width / 2}
        y={scene.height - 8}
        textAnchor="middle"
        className="fill-foreground"
      >
        <title>{xLabel}</title>
        {truncateLabel(xLabel, plot.width / 6.5)}
      </text>
      <text
        x={14}
        y={plot.y + plot.height / 2}
        textAnchor="middle"
        transform={`rotate(-90 14 ${plot.y + plot.height / 2})`}
        className="fill-foreground"
      >
        <title>{yLabel}</title>
        {truncateLabel(yLabel, plot.height / 6.5)}
      </text>
    </g>
  );
}

function renderMarks(
  scene: ChartScene,
  theme: ChartTheme,
  uid: string,
  onFocusItem: (key: string | null) => void,
): ReactNode {
  switch (scene.kind) {
    case "bar":
      return (
        <g data-part="marks">
          {scene.bars.map((bar) => {
            const key = `${bar.seriesId}\u0000${bar.categoryId}`;
            const color = chartSlotColor(bar.slot, theme);
            const width = Math.max(1, bar.width - 2);
            if (bar.missing) {
              // Missing is visibly distinct from zero: a dashed open marker at the baseline.
              return (
                <rect
                  key={key}
                  data-chart-mark="bar"
                  data-series={bar.seriesId}
                  data-category={bar.categoryId}
                  data-missing="true"
                  x={round(bar.x + 1)}
                  y={round(bar.y - 6)}
                  width={round(width)}
                  height={6}
                  fill="none"
                  stroke={color}
                  strokeDasharray="2 2"
                  onMouseEnter={() => onFocusItem(key)}
                >
                  <title>missing</title>
                </rect>
              );
            }
            const fill = patternFill(uid, bar.slot);
            return (
              <g key={key} onMouseEnter={() => onFocusItem(key)}>
                <rect
                  data-chart-mark="bar"
                  data-series={bar.seriesId}
                  data-category={bar.categoryId}
                  data-value={String(bar.value)}
                  data-missing="false"
                  x={round(bar.x + 1)}
                  y={round(bar.y)}
                  width={round(width)}
                  height={round(Math.max(0, bar.height))}
                  fill={color}
                />
                {fill && bar.height > 0 ? (
                  <rect
                    x={round(bar.x + 1)}
                    y={round(bar.y)}
                    width={round(width)}
                    height={round(bar.height)}
                    fill={fill}
                    pointerEvents="none"
                  />
                ) : null}
              </g>
            );
          })}
          <line
            data-chart-baseline="true"
            x1={scene.plot.x}
            x2={scene.plot.x + scene.plot.width}
            y1={round(scene.baselineY)}
            y2={round(scene.baselineY)}
            className="stroke-foreground"
            strokeWidth={1.5}
          />
        </g>
      );
    case "line":
    case "area":
    case "scatter": {
      const radius = scene.kind === "scatter" ? 4 : 2.5;
      return (
        <g data-part="marks">
          {scene.areas.map((area, index) => (
            <polygon
              key={`area-${index}`}
              data-chart-mark="area"
              points={area.points.map((point) => `${round(point.px)},${round(point.py)}`).join(" ")}
              fill={chartSlotColor(area.slot, theme)}
              fillOpacity={0.25}
            />
          ))}
          {scene.segments.map((segment, index) => (
            <path
              key={`segment-${index}`}
              data-chart-mark="segment"
              data-series={segment.seriesId}
              d={segment.points
                .map(
                  (point, pointIndex) =>
                    `${pointIndex === 0 ? "M" : "L"}${round(point.px)} ${round(point.py)}`,
                )
                .join("")}
              fill="none"
              stroke={chartSlotColor(segment.slot, theme)}
              strokeWidth={2}
              strokeDasharray={
                CHART_DASH_PATTERNS[segment.slot % CHART_DASH_PATTERNS.length] || undefined
              }
            />
          ))}
          {scene.points.map((point) => {
            const key = `${point.seriesId}\u0000${point.index}`;
            return (
              <g
                key={key}
                data-chart-mark="point"
                data-series={point.seriesId}
                data-x={String(point.x)}
                data-y={String(point.y)}
                onMouseEnter={() => onFocusItem(key)}
              >
                <ChartMarker
                  slot={point.slot}
                  x={round(point.px)}
                  y={round(point.py)}
                  r={radius}
                  color={chartSlotColor(point.slot, theme)}
                />
              </g>
            );
          })}
          {scene.baselineY !== null ? (
            <line
              data-chart-baseline="true"
              x1={scene.plot.x}
              x2={scene.plot.x + scene.plot.width}
              y1={round(scene.baselineY)}
              y2={round(scene.baselineY)}
              className="stroke-foreground"
            />
          ) : null}
        </g>
      );
    }
    case "donut":
      return (
        <g data-part="marks">
          {scene.empty ? (
            <>
              <circle
                cx={scene.center.x}
                cy={scene.center.y}
                r={(scene.outerRadius + scene.innerRadius) / 2}
                fill="none"
                className="stroke-border"
                strokeWidth={scene.outerRadius - scene.innerRadius}
              />
              <text
                x={scene.center.x}
                y={scene.center.y + 4}
                textAnchor="middle"
                className="fill-muted-foreground text-[12px]"
              >
                No positive values
              </text>
            </>
          ) : (
            <>
              {scene.arcs.map((arc) =>
                arc.path ? (
                  <g key={arc.id} onMouseEnter={() => onFocusItem(arc.id)}>
                    <path
                      data-chart-mark="arc"
                      data-slice={arc.id}
                      data-full-ring={arc.fullRing ? "true" : "false"}
                      d={arc.path}
                      fill={chartSlotColor(arc.slot, theme)}
                      fillRule="evenodd"
                      className="stroke-background"
                      strokeWidth={1}
                    />
                    {patternFill(uid, arc.slot) ? (
                      <path
                        d={arc.path}
                        fill={patternFill(uid, arc.slot)!}
                        fillRule="evenodd"
                        pointerEvents="none"
                      />
                    ) : null}
                  </g>
                ) : null,
              )}
              <text
                x={scene.center.x}
                y={scene.center.y + 4}
                textAnchor="middle"
                className="fill-foreground text-[13px]"
              >
                {`Total ${scene.total}`}
              </text>
            </>
          )}
        </g>
      );
  }
}

function FocusMarker({ item, scene }: { item: ChartInspectItem; scene: ChartScene }) {
  return (
    <g data-chart-focus={item.key} pointerEvents="none">
      {scene.kind !== "donut" ? (
        <line
          x1={round(item.px)}
          x2={round(item.px)}
          y1={scene.plot.y}
          y2={scene.plot.y + scene.plot.height}
          className="stroke-foreground/50"
          strokeDasharray="3 3"
        />
      ) : null}
      <circle
        cx={round(item.px)}
        cy={round(item.py)}
        r={7}
        fill="none"
        className="stroke-foreground"
        strokeWidth={2}
      />
    </g>
  );
}

/**
 * Deterministic chart layout for ChartSpecV1.
 *
 * `buildChartScene` turns a validated spec into a plain scene model: plot
 * bounds, domains, ticks, per-series geometry, legend entries, an accessible
 * summary and the rows of the equivalent data view. The renderer draws that
 * model with React; the backend serializes the same model to a self-contained
 * SVG for validation and export. Nothing here touches the DOM, evaluates
 * options or reads application state.
 */
import type {
  AreaChartSpecV1,
  BarChartSpecV1,
  ChartSpecV1,
  DonutChartSpecV1,
  LineChartSpecV1,
  ScatterChartSpecV1,
} from "./chart-spec.js";
import { toCsv, type CsvMode, type TabularCell } from "./tabular-export.js";

export const CHART_RENDERER_VERSION = "native-chart:v1";

export interface ChartSceneOptions {
  width?: number;
  height?: number;
  /** View-only selection; never changes stored data or default exports. */
  hiddenSeriesIds?: ReadonlySet<string>;
}

export interface ChartTick {
  value: number;
  position: number;
  label: string;
}

export interface ChartAxisScene {
  label: string;
  unit?: string;
  kind: "category" | "number" | "utc-time";
  domain: [number, number];
  ticks: ChartTick[];
}

export interface ChartLegendEntry {
  id: string;
  label: string;
  /** Palette slot by stable source order; identical across view toggles. */
  slot: number;
  hidden: boolean;
}

export interface BarRect {
  seriesId: string;
  categoryId: string;
  value: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
  slot: number;
  missing: boolean;
}

export interface ScenePoint {
  seriesId: string;
  index: number;
  x: number;
  y: number;
  px: number;
  py: number;
  slot: number;
}

export interface ScenePathSegment {
  seriesId: string;
  slot: number;
  points: Array<{ px: number; py: number }>;
}

export interface DonutArc {
  id: string;
  label: string;
  value: number;
  /** Derived percentage of the positive total; zero entries report 0. */
  percent: number;
  startAngle: number;
  endAngle: number;
  slot: number;
  fullRing: boolean;
  path: string;
}

export interface ChartDataTable {
  header: string[];
  rows: TabularCell[][];
  note?: string;
}

interface SceneBase {
  rendererVersion: typeof CHART_RENDERER_VERSION;
  width: number;
  height: number;
  title: string;
  description: string;
  summary: string;
  legend: ChartLegendEntry[];
  plot: { x: number; y: number; width: number; height: number };
}

export type ChartScene =
  | (SceneBase & {
      kind: "bar";
      xAxis: ChartAxisScene;
      yAxis: ChartAxisScene;
      categories: Array<{ id: string; label: string; center: number }>;
      bars: BarRect[];
      baselineY: number;
    })
  | (SceneBase & {
      kind: "line" | "area" | "scatter";
      xAxis: ChartAxisScene;
      yAxis: ChartAxisScene;
      segments: ScenePathSegment[];
      /** Closed polygons for area fills, one per nonnull run. */
      areas: ScenePathSegment[];
      points: ScenePoint[];
      baselineY: number | null;
    })
  | (SceneBase & {
      kind: "donut";
      center: { x: number; y: number };
      outerRadius: number;
      innerRadius: number;
      arcs: DonutArc[];
      total: number;
      empty: boolean;
    });

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 360;
const MARGIN = { top: 40, right: 16, bottom: 56, left: 64 };

export class ChartGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChartGeometryError";
  }
}

function finite(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new ChartGeometryError(`Non-finite ${what}`);
  return value;
}

/** Map a value from a normalized domain to pixels: p0 + (v - d0) / (d1 - d0) * (p1 - p0). */
export function scaleLinear(
  value: number,
  domain: readonly [number, number],
  range: readonly [number, number],
): number {
  const [d0, d1] = domain;
  const [p0, p1] = range;
  const span = finite(d1 - d0, "domain span");
  if (span === 0) throw new ChartGeometryError("Degenerate domain");
  const ratio = finite((value - d0) / span, "scale ratio");
  return finite(p0 + ratio * (p1 - p0), "scaled position");
}

/** 1/2/5 × 10^n step closest to range/target, always positive and finite. */
export function niceStep(range: number, targetTicks = 5): number {
  const raw = Math.abs(range) / Math.max(1, targetTicks);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const magnitude = 10 ** exponent;
  const fraction = raw / magnitude;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * Normalize a raw [min, max] into a nonzero domain aligned to tick steps.
 * `includeZero` is required for bars and areas; a constant domain expands by
 * a magnitude-based pad with a positive minimum.
 */
export function normalizeDomain(
  min: number,
  max: number,
  options: { includeZero: boolean; pad: boolean },
): { domain: [number, number]; step: number } {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (options.includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) {
    const pad = Math.max(Math.abs(lo) * 0.1, 1);
    lo -= options.includeZero && lo === 0 ? 0 : pad;
    hi += pad;
  } else if (options.pad) {
    const pad = (hi - lo) * 0.05;
    lo -= options.includeZero && lo === 0 ? 0 : pad;
    hi += options.includeZero && hi === 0 ? 0 : pad;
  }
  const step = niceStep(hi - lo);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hi / step) * step;
  return {
    domain: [
      finite(niceLo === niceHi ? niceLo - step : niceLo, "domain"),
      finite(niceHi, "domain"),
    ],
    step,
  };
}

function decimalsFor(step: number): number {
  if (step >= 1) return 0;
  return Math.min(12, Math.ceil(-Math.log10(step) - 1e-9));
}

/** Compact tick label; exact values stay available in the tooltip and data view. */
export function formatTickNumber(value: number, step: number): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size && step >= size / 100) {
      const scaled = value / size;
      const decimals = Math.max(0, Math.min(2, decimalsFor(step / size)));
      return `${trimZeros(scaled.toFixed(decimals))}${suffix}`;
    }
  }
  const text = value.toFixed(decimalsFor(step));
  return text === "-0" ? "0" : text;
}

function trimZeros(text: string): string {
  return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}

/** Exact value text used in tooltips and the data view. */
export function formatExactValue(value: number | null, unit?: string): string {
  if (value === null) return "missing";
  const text = String(value);
  return unit ? `${text} ${unit}` : text;
}

function numericTicks(
  domain: [number, number],
  step: number,
  range: [number, number],
): ChartTick[] {
  const ticks: ChartTick[] = [];
  const first = Math.ceil(domain[0] / step - 1e-9);
  const last = Math.floor(domain[1] / step + 1e-9);
  for (let i = first; i <= last && ticks.length < 25; i++) {
    const value = Number((i * step).toPrecision(12));
    ticks.push({
      value,
      position: scaleLinear(value, domain, range),
      label: formatTickNumber(value, step),
    });
  }
  return ticks;
}

const TIME_STEPS_MS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 10_800_000,
  21_600_000, 43_200_000, 86_400_000, 172_800_000, 604_800_000, 2_592_000_000, 7_776_000_000,
  31_536_000_000,
];

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatUtc(ms: number, step = 86_400_000): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  const day = `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
  if (step >= 86_400_000) return day;
  const time = `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
  return step >= 60_000 ? `${day} ${time}` : `${day} ${time}:${pad2(date.getUTCSeconds())}`;
}

function timeDomain(
  min: number,
  max: number,
  range: [number, number],
): { domain: [number, number]; ticks: ChartTick[] } {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 86_400_000;
  }
  if (lo === hi) {
    lo -= 43_200_000;
    hi += 43_200_000;
  }
  const target = (hi - lo) / 5;
  const step = TIME_STEPS_MS.find((candidate) => candidate >= target) ?? niceStep(hi - lo);
  const domain: [number, number] = [lo, hi];
  const ticks: ChartTick[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi && ticks.length < 12; t += step) {
    ticks.push({
      value: t,
      position: scaleLinear(t, domain, range),
      label: `${formatUtc(t, step)}`,
    });
  }
  return { domain, ticks };
}

function plotBounds(width: number, height: number) {
  return {
    x: MARGIN.left,
    y: MARGIN.top,
    width: Math.max(1, width - MARGIN.left - MARGIN.right),
    height: Math.max(1, height - MARGIN.top - MARGIN.bottom),
  };
}

function legendFor(
  items: ReadonlyArray<{ id: string; label: string }>,
  hidden: ReadonlySet<string>,
): ChartLegendEntry[] {
  return items.map((item, index) => ({
    id: item.id,
    label: item.label,
    slot: index,
    hidden: hidden.has(item.id),
  }));
}

function buildBarScene(
  spec: BarChartSpecV1,
  width: number,
  height: number,
  hidden: ReadonlySet<string>,
): ChartScene {
  const plot = plotBounds(width, height);
  const visible = spec.series.filter((series) => !hidden.has(series.id));
  const values = visible.flatMap((series) =>
    series.points.map((point) => point.value).filter((value): value is number => value !== null),
  );
  const { domain, step } = normalizeDomain(
    values.length ? Math.min(...values) : 0,
    values.length ? Math.max(...values) : 0,
    { includeZero: true, pad: false },
  );
  const yRange: [number, number] = [plot.y + plot.height, plot.y];
  const baselineY = scaleLinear(0, domain, yRange);
  const categoryCount = Math.max(1, spec.categories.length);
  const band = plot.width / categoryCount;
  const groupWidth = band * 0.8;
  const slotOf = new Map(spec.series.map((series, index) => [series.id, index]));
  const barWidth = groupWidth / Math.max(1, visible.length);
  const categories = spec.categories.map((category, index) => ({
    id: category.id,
    label: category.label,
    center: plot.x + band * index + band / 2,
  }));
  const bars: BarRect[] = [];
  spec.categories.forEach((category, categoryIndex) => {
    const groupStart = plot.x + band * categoryIndex + (band - groupWidth) / 2;
    visible.forEach((series, visibleIndex) => {
      const point = series.points.find((candidate) => candidate.categoryId === category.id);
      const value = point?.value ?? null;
      const x = groupStart + barWidth * visibleIndex;
      const slot = slotOf.get(series.id) ?? 0;
      if (value === null) {
        bars.push({
          seriesId: series.id,
          categoryId: category.id,
          value: null,
          x,
          y: baselineY,
          width: barWidth,
          height: 0,
          slot,
          missing: true,
        });
        return;
      }
      const valueY = scaleLinear(value, domain, yRange);
      bars.push({
        seriesId: series.id,
        categoryId: category.id,
        value,
        x,
        y: Math.min(valueY, baselineY),
        width: barWidth,
        height: Math.abs(baselineY - valueY),
        slot,
        missing: false,
      });
    });
  });
  const missing = bars.filter((bar) => bar.missing).length;
  return {
    kind: "bar",
    rendererVersion: CHART_RENDERER_VERSION,
    width,
    height,
    title: spec.title,
    description: spec.description,
    summary: `Bar chart with ${spec.categories.length} categories and ${spec.series.length} series${missing ? `; ${missing} missing values shown as gaps` : ""}. Y axis: ${spec.yAxis.label}${spec.yAxis.unit ? ` (${spec.yAxis.unit})` : ""}.`,
    legend: legendFor(spec.series, hidden),
    plot,
    xAxis: { label: spec.xAxis.label, kind: "category", domain: [0, categoryCount], ticks: [] },
    yAxis: {
      label: spec.yAxis.label,
      unit: spec.yAxis.unit,
      kind: "number",
      domain,
      ticks: numericTicks(domain, step, yRange),
    },
    categories,
    bars,
    baselineY,
  };
}

type XYSpec = LineChartSpecV1 | AreaChartSpecV1 | ScatterChartSpecV1;

function buildXYScene(
  spec: XYSpec,
  width: number,
  height: number,
  hidden: ReadonlySet<string>,
): ChartScene {
  const plot = plotBounds(width, height);
  const visible = spec.series.filter((series) => !hidden.has(series.id));
  const xs: number[] = [];
  const ys: number[] = [];
  for (const series of visible) {
    for (const point of series.points) {
      xs.push(point.x);
      if (point.y !== null) ys.push(point.y);
    }
  }
  const xRange: [number, number] = [plot.x, plot.x + plot.width];
  const yRange: [number, number] = [plot.y + plot.height, plot.y];
  const xMin = xs.length ? Math.min(...xs) : 0;
  const xMax = xs.length ? Math.max(...xs) : 1;
  let xAxis: ChartAxisScene;
  if (spec.xAxis.kind === "utc-time") {
    const time = timeDomain(xMin, xMax, xRange);
    xAxis = {
      label: spec.xAxis.label,
      unit: "UTC",
      kind: "utc-time",
      domain: time.domain,
      ticks: time.ticks,
    };
  } else {
    const { domain, step } = normalizeDomain(xMin, xMax, {
      includeZero: false,
      pad: spec.kind === "scatter",
    });
    xAxis = {
      label: spec.xAxis.label,
      unit: spec.xAxis.unit,
      kind: "number",
      domain,
      ticks: numericTicks(domain, step, xRange),
    };
  }
  const { domain: yDomain, step: yStep } = normalizeDomain(
    ys.length ? Math.min(...ys) : 0,
    ys.length ? Math.max(...ys) : 0,
    { includeZero: spec.kind === "area", pad: spec.kind !== "area" },
  );
  const yAxis: ChartAxisScene = {
    label: spec.yAxis.label,
    unit: spec.yAxis.unit,
    kind: "number",
    domain: yDomain,
    ticks: numericTicks(yDomain, yStep, yRange),
  };
  const slotOf = new Map(spec.series.map((series, index) => [series.id, index]));
  const segments: ScenePathSegment[] = [];
  const areas: ScenePathSegment[] = [];
  const points: ScenePoint[] = [];
  const baselineY = spec.kind === "area" ? scaleLinear(0, yDomain, yRange) : null;
  for (const series of visible) {
    const slot = slotOf.get(series.id) ?? 0;
    let current: Array<{ px: number; py: number }> = [];
    const flush = () => {
      if (current.length === 0) return;
      if (spec.kind !== "scatter") segments.push({ seriesId: series.id, slot, points: current });
      if (spec.kind === "area" && baselineY !== null) {
        const first = current[0]!;
        const last = current[current.length - 1]!;
        areas.push({
          seriesId: series.id,
          slot,
          points: [...current, { px: last.px, py: baselineY }, { px: first.px, py: baselineY }],
        });
      }
      current = [];
    };
    series.points.forEach((point, index) => {
      if (point.y === null) {
        // A null closes the run: it never becomes zero or an interpolated span.
        flush();
        return;
      }
      const px = scaleLinear(point.x, xAxis.domain, xRange);
      const py = scaleLinear(point.y, yDomain, yRange);
      points.push({ seriesId: series.id, index, x: point.x, y: point.y, px, py, slot });
      current.push({ px, py });
    });
    flush();
  }
  const nulls = spec.series.reduce(
    (count, series) => count + series.points.filter((point) => point.y === null).length,
    0,
  );
  const totalPoints = spec.series.reduce((count, series) => count + series.points.length, 0);
  const kindLabel = spec.kind === "line" ? "Line" : spec.kind === "area" ? "Area" : "Scatter";
  return {
    kind: spec.kind,
    rendererVersion: CHART_RENDERER_VERSION,
    width,
    height,
    title: spec.title,
    description: spec.description,
    summary: `${kindLabel} chart with ${spec.series.length} series and ${totalPoints} points${nulls ? `; ${nulls} gaps` : ""}. X axis: ${spec.xAxis.label}${spec.xAxis.kind === "utc-time" ? " (UTC)" : ""}. Y axis: ${spec.yAxis.label}${spec.yAxis.unit ? ` (${spec.yAxis.unit})` : ""}.`,
    legend: legendFor(spec.series, hidden),
    plot,
    xAxis,
    yAxis,
    segments,
    areas,
    points,
    baselineY,
  };
}

/** Kahan-compensated sum of nonnegative finite values. */
export function stableSum(values: readonly number[]): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const y = value - compensation;
    const t = sum + y;
    compensation = t - sum - y;
    sum = t;
  }
  return sum;
}

function polar(cx: number, cy: number, radius: number, angle: number) {
  return { x: cx + radius * Math.sin(angle), y: cy - radius * Math.cos(angle) };
}

function round(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function arcPath(
  cx: number,
  cy: number,
  outer: number,
  inner: number,
  start: number,
  end: number,
): string {
  const largeArc = end - start > Math.PI ? 1 : 0;
  const o0 = polar(cx, cy, outer, start);
  const o1 = polar(cx, cy, outer, end);
  const i1 = polar(cx, cy, inner, end);
  const i0 = polar(cx, cy, inner, start);
  return [
    `M${round(o0.x)} ${round(o0.y)}`,
    `A${round(outer)} ${round(outer)} 0 ${largeArc} 1 ${round(o1.x)} ${round(o1.y)}`,
    `L${round(i1.x)} ${round(i1.y)}`,
    `A${round(inner)} ${round(inner)} 0 ${largeArc} 0 ${round(i0.x)} ${round(i0.y)}`,
    "Z",
  ].join(" ");
}

/** Full ring as two half arcs so a single positive slice never collapses. */
function ringPath(cx: number, cy: number, outer: number, inner: number): string {
  return [
    `M${round(cx)} ${round(cy - outer)}`,
    `A${round(outer)} ${round(outer)} 0 1 1 ${round(cx)} ${round(cy + outer)}`,
    `A${round(outer)} ${round(outer)} 0 1 1 ${round(cx)} ${round(cy - outer)}`,
    `M${round(cx)} ${round(cy - inner)}`,
    `A${round(inner)} ${round(inner)} 0 1 0 ${round(cx)} ${round(cy + inner)}`,
    `A${round(inner)} ${round(inner)} 0 1 0 ${round(cx)} ${round(cy - inner)}`,
    "Z",
  ].join(" ");
}

function buildDonutScene(
  spec: DonutChartSpecV1,
  width: number,
  height: number,
  hidden: ReadonlySet<string>,
): ChartScene {
  const plot = { x: 16, y: 40, width: width - 32, height: height - 56 };
  const center = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
  const outerRadius = Math.max(8, Math.min(plot.width, plot.height) / 2 - 8);
  const innerRadius = outerRadius * 0.6;
  const visible = spec.slices.filter((slice) => !hidden.has(slice.id));
  const total = stableSum(visible.map((slice) => slice.value));
  const positive = visible.filter((slice) => slice.value > 0);
  const slotOf = new Map(spec.slices.map((slice, index) => [slice.id, index]));
  const arcs: DonutArc[] = [];
  let angle = 0;
  for (const slice of visible) {
    const slot = slotOf.get(slice.id) ?? 0;
    if (total <= 0 || slice.value <= 0) {
      arcs.push({
        id: slice.id,
        label: slice.label,
        value: slice.value,
        percent: 0,
        startAngle: angle,
        endAngle: angle,
        slot,
        fullRing: false,
        path: "",
      });
      continue;
    }
    const fraction = slice.value / total;
    const percent = fraction * 100;
    if (positive.length === 1) {
      arcs.push({
        id: slice.id,
        label: slice.label,
        value: slice.value,
        percent: 100,
        startAngle: 0,
        endAngle: Math.PI * 2,
        slot,
        fullRing: true,
        path: ringPath(center.x, center.y, outerRadius, innerRadius),
      });
      continue;
    }
    const end = angle + fraction * Math.PI * 2;
    arcs.push({
      id: slice.id,
      label: slice.label,
      value: slice.value,
      percent,
      startAngle: angle,
      endAngle: end,
      slot,
      fullRing: false,
      path: arcPath(center.x, center.y, outerRadius, innerRadius, angle, end),
    });
    angle = end;
  }
  const empty = total <= 0;
  return {
    kind: "donut",
    rendererVersion: CHART_RENDERER_VERSION,
    width,
    height,
    title: spec.title,
    description: spec.description,
    summary: empty
      ? `Donut chart with ${spec.slices.length} entries and no positive values.`
      : `Donut chart with ${spec.slices.length} entries totalling ${total}${spec.unit ? ` ${spec.unit}` : ""}.`,
    legend: legendFor(spec.slices, hidden),
    plot,
    center,
    outerRadius,
    innerRadius,
    arcs,
    total,
    empty,
  };
}

export function buildChartScene(spec: ChartSpecV1, options: ChartSceneOptions = {}): ChartScene {
  const width = Math.max(240, Math.min(4096, Math.round(options.width ?? DEFAULT_WIDTH)));
  const height = Math.max(160, Math.min(4096, Math.round(options.height ?? DEFAULT_HEIGHT)));
  const hidden = options.hiddenSeriesIds ?? new Set<string>();
  switch (spec.kind) {
    case "bar":
      return buildBarScene(spec, width, height, hidden);
    case "line":
    case "area":
    case "scatter":
      return buildXYScene(spec, width, height, hidden);
    case "donut":
      return buildDonutScene(spec, width, height, hidden);
  }
}

/** Data view rows; also the CSV schema. Missing values stay empty cells. */
export function chartDataTable(
  spec: ChartSpecV1,
  options: { hiddenSeriesIds?: ReadonlySet<string> } = {},
): ChartDataTable {
  const hidden = options.hiddenSeriesIds ?? new Set<string>();
  switch (spec.kind) {
    case "bar": {
      const labels = new Map(spec.categories.map((category) => [category.id, category.label]));
      const rows: TabularCell[][] = [];
      for (const series of spec.series) {
        if (hidden.has(series.id)) continue;
        for (const category of spec.categories) {
          const point = series.points.find((candidate) => candidate.categoryId === category.id);
          rows.push([
            category.id,
            labels.get(category.id) ?? "",
            series.id,
            series.label,
            point?.value ?? null,
          ]);
        }
      }
      return {
        header: ["category_id", "category_label", "series_id", "series_label", "value"],
        rows,
        note: "Empty value cells are missing observations, not zero.",
      };
    }
    case "line":
    case "area":
    case "scatter": {
      const utc = spec.xAxis.kind === "utc-time";
      const rows: TabularCell[][] = [];
      for (const series of spec.series) {
        if (hidden.has(series.id)) continue;
        for (const point of series.points) {
          const row: TabularCell[] = [series.id, series.label, point.x];
          if (utc) row.push(new Date(point.x).toISOString());
          row.push(point.y);
          rows.push(row);
        }
      }
      return {
        header: utc
          ? ["series_id", "series_label", "x_epoch_ms", "x_utc", "y"]
          : ["series_id", "series_label", "x", "y"],
        rows,
        note: spec.kind === "scatter" ? undefined : "Empty y cells are gaps, not zero.",
      };
    }
    case "donut":
      return {
        header: ["id", "label", "value"],
        rows: spec.slices
          .filter((slice) => !hidden.has(slice.id))
          .map((slice) => [slice.id, slice.label, slice.value]),
      };
  }
}

export function chartToCsv(
  spec: ChartSpecV1,
  options: { hiddenSeriesIds?: ReadonlySet<string>; mode?: CsvMode } = {},
): string {
  const table = chartDataTable(spec, options);
  return toCsv(table.header, table.rows, options.mode ?? "exact");
}

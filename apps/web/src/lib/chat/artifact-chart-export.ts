import type { ChartSpecV1 } from "@orkestrator/protocol/chart-spec";
import {
  buildChartScene,
  chartToCsv,
  formatExactValue,
  formatUtc,
  type ChartScene,
} from "@orkestrator/protocol/chart-scene";
import { chartSceneToSvg, type ChartTheme } from "@orkestrator/protocol/chart-svg";
import { CHART_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { sanitizeSvg } from "./svg-sanitize";

/**
 * Exports and inspection rows for native charts. The default exports always
 * carry the whole validated dataset; a filtered export is a separate,
 * explicitly named action. Nothing here reads view state implicitly.
 */

/** Full dataset CSV (default export). */
export function chartCsvExport(spec: ChartSpecV1): string {
  return chartToCsv(spec, { mode: "spreadsheet-safe" });
}

/** Explicitly filtered export: only the series the user left visible. */
export function chartVisibleCsvExport(
  spec: ChartSpecV1,
  hiddenSeriesIds: ReadonlySet<string>,
): string {
  return chartToCsv(spec, { mode: "spreadsheet-safe", hiddenSeriesIds });
}

/** The exact validated specification: the authored text when available. */
export function chartJsonExport(spec: ChartSpecV1, exactSource?: string): string {
  return exactSource ?? `${JSON.stringify(spec, null, 2)}\n`;
}

/** Bounds for the export sanitizer: a maximum-size chart is ~2 SVG elements per point. */
const CHART_SVG_EXPORT_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxElements: CHART_POLICY.maxCartesianPoints * 3 + 2_000,
};

/**
 * Self-contained SVG of the full dataset for the given theme, passed through
 * the shared SVG export policy before it is offered as an attachment.
 */
export function chartSvgExport(spec: ChartSpecV1, theme: ChartTheme): string {
  // The XML declaration is re-added after sanitizing; DOMPurify parses markup only.
  const raw = chartSceneToSvg(buildChartScene(spec), theme).replace(/^<\?xml[^>]*\?>\s*/, "");
  const clean = sanitizeSvg(raw, CHART_SVG_EXPORT_LIMITS).svg;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${clean}`;
}

export interface ChartInspectItem {
  key: string;
  seriesId: string;
  seriesLabel: string;
  /** Category label, x value or slice label. */
  label: string;
  valueText: string;
  px: number;
  py: number;
  slot: number;
  shape: "bar" | "point" | "arc";
  missing: boolean;
}

export function formatChartX(spec: ChartSpecV1, x: number): string {
  if (spec.kind === "line" || spec.kind === "area") {
    if (spec.xAxis.kind === "utc-time") return `${formatUtc(x, 1_000)} UTC`;
  }
  if (spec.kind === "line" || spec.kind === "area" || spec.kind === "scatter") {
    return spec.xAxis.unit ? `${x} ${spec.xAxis.unit}` : String(x);
  }
  return String(x);
}

/** Inspectable marks in source order, for hover, keyboard focus and the focused marker. */
export function chartInspectItems(spec: ChartSpecV1, scene: ChartScene): ChartInspectItem[] {
  switch (scene.kind) {
    case "bar": {
      if (spec.kind !== "bar") return [];
      const categories = new Map(spec.categories.map((category) => [category.id, category.label]));
      const series = new Map(spec.series.map((entry) => [entry.id, entry.label]));
      return scene.bars.map((bar) => ({
        key: `${bar.seriesId}\u0000${bar.categoryId}`,
        seriesId: bar.seriesId,
        seriesLabel: series.get(bar.seriesId) ?? bar.seriesId,
        label: categories.get(bar.categoryId) ?? bar.categoryId,
        valueText: formatExactValue(bar.value, spec.yAxis.unit),
        px: bar.x + bar.width / 2,
        py: bar.missing ? scene.baselineY : bar.y,
        slot: bar.slot,
        shape: "bar",
        missing: bar.missing,
      }));
    }
    case "line":
    case "area":
    case "scatter": {
      if (spec.kind !== "line" && spec.kind !== "area" && spec.kind !== "scatter") return [];
      const series = new Map(spec.series.map((entry) => [entry.id, entry.label]));
      return scene.points.map((point) => ({
        key: `${point.seriesId}\u0000${point.index}`,
        seriesId: point.seriesId,
        seriesLabel: series.get(point.seriesId) ?? point.seriesId,
        label: formatChartX(spec, point.x),
        valueText: formatExactValue(point.y, spec.yAxis.unit),
        px: point.px,
        py: point.py,
        slot: point.slot,
        shape: "point",
        missing: false,
      }));
    }
    case "donut": {
      if (spec.kind !== "donut") return [];
      const radius = (scene.outerRadius + scene.innerRadius) / 2;
      return scene.arcs
        .filter((arc) => arc.path)
        .map((arc) => {
          const angle = arc.fullRing ? 0 : (arc.startAngle + arc.endAngle) / 2;
          return {
            key: arc.id,
            seriesId: arc.id,
            seriesLabel: arc.label,
            label: spec.valueLabel,
            valueText: `${formatExactValue(arc.value, spec.unit)} (${arc.percent.toFixed(1)}%)`,
            px: scene.center.x + radius * Math.sin(angle),
            py: scene.center.y - radius * Math.cos(angle),
            slot: arc.slot,
            shape: "arc" as const,
            missing: false,
          };
        });
    }
  }
}

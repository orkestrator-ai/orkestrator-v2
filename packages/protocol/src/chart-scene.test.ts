import { describe, expect, test } from "bun:test";
import {
  buildChartScene,
  chartDataTable,
  chartToCsv,
  niceStep,
  normalizeDomain,
  scaleLinear,
  stableSum,
} from "./chart-scene";
import { chartSceneToSvg } from "./chart-svg";
import type { ChartSpecV1 } from "./chart-spec";
import { REPRESENTATIVE_BAR_CHART } from "./testing/rich-content-fixtures";

describe("scales and ticks", () => {
  test("maps with p0 + (v - d0) / (d1 - d0) * (p1 - p0)", () => {
    expect(scaleLinear(5, [0, 10], [100, 0])).toBe(50);
    expect(scaleLinear(0, [-10, 10], [0, 200])).toBe(100);
    expect(() => scaleLinear(1, [3, 3], [0, 1])).toThrow("Degenerate domain");
  });

  test("uses 1/2/5 steps", () => {
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(0.7, 5)).toBe(0.2);
    expect(niceStep(37, 5)).toBe(10);
  });

  test("bars and areas include zero; constants get a nonzero domain", () => {
    expect(normalizeDomain(5, 9, { includeZero: true, pad: false }).domain[0]).toBe(0);
    const constant = normalizeDomain(7, 7, { includeZero: false, pad: true }).domain;
    expect(constant[1]).toBeGreaterThan(constant[0]);
    const zeroConstant = normalizeDomain(0, 0, { includeZero: true, pad: false }).domain;
    expect(zeroConstant[1]).toBeGreaterThan(zeroConstant[0]);
    const negative = normalizeDomain(-4, -1, { includeZero: true, pad: false }).domain;
    expect(negative[1]).toBe(0);
    expect(negative[0]).toBeLessThanOrEqual(-4);
  });

  test("stable sum handles many small values", () => {
    expect(stableSum(Array.from({ length: 10 }, () => 0.1))).toBeCloseTo(1, 12);
  });
});

describe("representative bar chart geometry", () => {
  const scene = buildChartScene(REPRESENTATIVE_BAR_CHART, { width: 640, height: 360 });
  if (scene.kind !== "bar") throw new Error("expected bar scene");
  const bar = (series: string, category: string) =>
    scene.bars.find(
      (candidate) => candidate.seriesId === series && candidate.categoryId === category,
    )!;

  test("six category/series positions with one visibly missing value", () => {
    expect(scene.bars).toHaveLength(6);
    expect(scene.bars.filter((candidate) => candidate.missing)).toHaveLength(1);
    expect(bar("b", "browser").missing).toBe(true);
    expect(bar("b", "browser").value).toBeNull();
  });

  test("44 is taller than 40 and heights match the scale exactly", () => {
    expect(bar("b", "unit").height).toBeGreaterThan(bar("a", "unit").height);
    const [d0, d1] = scene.yAxis.domain;
    const plotHeight = scene.plot.height;
    expect(bar("a", "unit").height).toBeCloseTo((40 / (d1 - d0)) * plotHeight, 9);
    expect(bar("a", "integration").height).toBeCloseTo(bar("b", "integration").height, 9);
  });

  test("zero baseline sits at the bottom of a nonnegative domain", () => {
    expect(scene.yAxis.domain[0]).toBe(0);
    expect(scene.baselineY).toBeCloseTo(scene.plot.y + scene.plot.height, 9);
  });

  test("legend keeps source order and stable slots; toggling only changes the view", () => {
    expect(scene.legend.map((entry) => [entry.label, entry.slot])).toEqual([
      ["Run A", 0],
      ["Run B", 1],
    ]);
    const hidden = buildChartScene(REPRESENTATIVE_BAR_CHART, { hiddenSeriesIds: new Set(["a"]) });
    if (hidden.kind !== "bar") throw new Error("expected bar scene");
    expect(hidden.bars.every((candidate) => candidate.seriesId === "b")).toBe(true);
    expect(hidden.legend.find((entry) => entry.id === "b")?.slot).toBe(1);
    expect(REPRESENTATIVE_BAR_CHART.series).toHaveLength(2);
  });

  test("data view and CSV keep exact values, order and empty missing cells", () => {
    const table = chartDataTable(REPRESENTATIVE_BAR_CHART);
    expect(table.rows.map((row) => row[4])).toEqual([40, 12, 8, 44, 12, null]);
    const csv = chartToCsv(REPRESENTATIVE_BAR_CHART);
    expect(csv.split("\r\n")[6]).toBe("browser,Browser,b,Run B,");
    expect(csv).not.toContain("null");
  });

  test("SVG export is self-contained and readable in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = chartSceneToSvg(scene, theme);
      expect(svg).toContain("<title>Illustrative test outcomes</title>");
      expect(svg).toContain('viewBox="0 0 640 360"');
      expect(svg).not.toMatch(/href|<script|url\(|@import|https?:\/\/(?!www\.w3\.org)/);
    }
  });
});

describe("line, area, scatter and donut geometry", () => {
  test("a null closes the line segment instead of becoming zero", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "line",
      title: "t",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 0, y: 1 },
            { x: 1, y: 2 },
            { x: 2, y: null },
            { x: 3, y: 3 },
          ],
        },
      ],
    };
    const scene = buildChartScene(spec);
    if (scene.kind !== "line") throw new Error("expected line");
    expect(scene.segments.map((segment) => segment.points.length)).toEqual([2, 1]);
    expect(scene.points).toHaveLength(3);
  });

  test("area closes each nonnull run down to the zero baseline", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "area",
      title: "t",
      description: "",
      xAxis: { kind: "utc-time", label: "time" },
      yAxis: { label: "y" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 0, y: 5 },
            { x: 3_600_000, y: 10 },
            { x: 7_200_000, y: null },
            { x: 10_800_000, y: 4 },
          ],
        },
      ],
    };
    const scene = buildChartScene(spec);
    if (scene.kind !== "area") throw new Error("expected area");
    expect(scene.areas).toHaveLength(2);
    expect(scene.yAxis.domain[0]).toBe(0);
    for (const area of scene.areas) {
      expect(area.points.at(-1)!.py).toBeCloseTo(scene.baselineY!, 9);
    }
    expect(scene.xAxis.ticks.every((tick) => /^\d{4}-\d{2}-\d{2}/.test(tick.label))).toBe(true);
    expect(chartDataTable(spec).header).toContain("x_utc");
  });

  test("scatter keeps coincident points", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "scatter",
      title: "t",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 1, y: 1 },
            { x: 1, y: 1 },
          ],
        },
      ],
    };
    const scene = buildChartScene(spec);
    if (scene.kind !== "scatter") throw new Error("expected scatter");
    expect(scene.points).toHaveLength(2);
    expect(chartDataTable(spec).rows).toHaveLength(2);
  });

  test("donut: empty, all-zero and single-slice cases", () => {
    const base = {
      schemaVersion: 1 as const,
      kind: "donut" as const,
      title: "t",
      description: "",
      valueLabel: "v",
    };
    const empty = buildChartScene({ ...base, slices: [] });
    if (empty.kind !== "donut") throw new Error("expected donut");
    expect(empty.empty).toBe(true);
    const zeros = buildChartScene({ ...base, slices: [{ id: "a", label: "A", value: 0 }] });
    if (zeros.kind !== "donut") throw new Error("expected donut");
    expect(zeros.empty).toBe(true);
    expect(zeros.arcs[0]!.percent).toBe(0);
    const single = buildChartScene({
      ...base,
      slices: [
        { id: "a", label: "A", value: 3 },
        { id: "z", label: "Z", value: 0 },
      ],
    });
    if (single.kind !== "donut") throw new Error("expected donut");
    expect(single.arcs[0]!.fullRing).toBe(true);
    expect(single.arcs[0]!.percent).toBe(100);
    expect(single.arcs[1]!.path).toBe("");
    const split = buildChartScene({
      ...base,
      slices: [
        { id: "a", label: "A", value: 1 },
        { id: "b", label: "B", value: 3 },
      ],
    });
    if (split.kind !== "donut") throw new Error("expected donut");
    expect(split.arcs.map((arc) => arc.percent)).toEqual([25, 75]);
    expect(split.arcs[1]!.endAngle).toBeCloseTo(Math.PI * 2, 9);
  });

  test("negative bar values extend below a visible zero baseline", () => {
    const spec: ChartSpecV1 = {
      ...REPRESENTATIVE_BAR_CHART,
      series: [
        {
          id: "a",
          label: "A",
          points: [
            { categoryId: "unit", value: -5 },
            { categoryId: "integration", value: 5 },
            { categoryId: "browser", value: 0 },
          ],
        },
      ],
    };
    const scene = buildChartScene(spec);
    if (scene.kind !== "bar") throw new Error("expected bar");
    const negative = scene.bars[0]!;
    expect(negative.y).toBeCloseTo(scene.baselineY, 9);
    expect(negative.height).toBeGreaterThan(0);
    const zero = scene.bars[2]!;
    expect(zero.missing).toBe(false);
    expect(zero.height).toBe(0);
  });
});

test("SVG escapes hostile labels and large-magnitude axes have finite geometry", () => {
  const chart = {
    ...REPRESENTATIVE_BAR_CHART,
    title: '<script>"&',
    categories: REPRESENTATIVE_BAR_CHART.categories.map((c) => ({
      ...c,
      label: '<img onerror="bad()">&',
    })),
    series: REPRESENTATIVE_BAR_CHART.series.map((s) => ({
      ...s,
      points: s.points.map((p) => ({ ...p, value: p.value === null ? null : p.value * 1e100 })),
    })),
  };
  const svg = chartSceneToSvg(buildChartScene(chart), "light");
  expect(svg).not.toMatch(/NaN|Infinity|<script|<img/);
  expect(svg).toContain("&lt;img");
  expect(chartToCsv(chart, { mode: "exact" })).toContain("<img");
});

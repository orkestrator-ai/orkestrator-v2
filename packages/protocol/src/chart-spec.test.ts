import { describe, expect, test } from "bun:test";
import { parseChartSpec, validateChartSpec } from "./chart-spec";
import { REPRESENTATIVE_BAR_CHART } from "./testing/rich-content-fixtures";
import { CHART_POLICY } from "./rich-content-policy";

function errorsOf(value: unknown) {
  const result = validateChartSpec(value);
  return result.ok ? [] : result.errors;
}

describe("ChartSpecV1 validation", () => {
  test("accepts the representative fixture", () => {
    expect(validateChartSpec(REPRESENTATIVE_BAR_CHART).ok).toBe(true);
  });

  test("rejects unknown executable or configuration fields with a stable path", () => {
    const errors = errorsOf({ ...REPRESENTATIVE_BAR_CHART, formatter: "x => x" });
    expect(errors).toContainEqual(
      expect.objectContaining({ path: "formatter", code: "unknown_field" }),
    );
    const colourErrors = errorsOf({
      ...REPRESENTATIVE_BAR_CHART,
      series: [
        { ...REPRESENTATIVE_BAR_CHART.series[0], color: "red" },
        REPRESENTATIVE_BAR_CHART.series[1],
      ],
    });
    expect(colourErrors).toContainEqual(
      expect.objectContaining({ path: "series[0].color", code: "unknown_field" }),
    );
  });

  test("rejects unknown schema versions and kinds", () => {
    expect(errorsOf({ ...REPRESENTATIVE_BAR_CHART, schemaVersion: 2 })[0]?.code).toBe(
      "unsupported_version",
    );
    expect(errorsOf({ ...REPRESENTATIVE_BAR_CHART, kind: "pie3d" })[0]?.path).toBe("kind");
  });

  test("requires exactly one point per category with explicit null for gaps", () => {
    const missing = structuredClone(REPRESENTATIVE_BAR_CHART);
    missing.series[1]!.points.pop();
    expect(errorsOf(missing)).toContainEqual(
      expect.objectContaining({ path: "series[1].points", code: "missing_point" }),
    );
    const duplicate = structuredClone(REPRESENTATIVE_BAR_CHART);
    duplicate.series[0]!.points[1] = { categoryId: "unit", value: 1 };
    const codes = errorsOf(duplicate).map((error) => error.code);
    expect(codes).toContain("duplicate_point");
    const dangling = structuredClone(REPRESENTATIVE_BAR_CHART);
    dangling.series[0]!.points[0] = { categoryId: "nope", value: 1 };
    expect(errorsOf(dangling).map((error) => error.code)).toContain("dangling_category");
  });

  test("rejects NaN, infinities, coerced strings and oversized magnitudes", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "40", 1e16]) {
      const spec = structuredClone(REPRESENTATIVE_BAR_CHART) as unknown as {
        series: Array<{ points: Array<{ value: unknown }> }>;
      };
      spec.series[0]!.points[0]!.value = bad;
      expect(errorsOf(spec).length).toBeGreaterThan(0);
    }
  });

  test("rejects duplicate ids and too many series", () => {
    const dup = structuredClone(REPRESENTATIVE_BAR_CHART);
    dup.series[1]!.id = "a";
    expect(errorsOf(dup).map((error) => error.code)).toContain("duplicate_id");
    const many = structuredClone(REPRESENTATIVE_BAR_CHART);
    many.series = Array.from({ length: CHART_POLICY.maxSeries + 1 }, (_, index) => ({
      ...REPRESENTATIVE_BAR_CHART.series[0]!,
      id: `s${index}`,
    }));
    expect(errorsOf(many).map((error) => error.code)).toContain("too_many");
  });

  test("line x values must be strictly increasing and UTC values safe integers", () => {
    const line = {
      schemaVersion: 1,
      kind: "line",
      title: "t",
      description: "",
      xAxis: { kind: "utc-time", label: "Time" },
      yAxis: { label: "v" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 2, y: 1 },
            { x: 2, y: null },
          ],
        },
      ],
    };
    expect(errorsOf(line).map((error) => error.code)).toContain("not_increasing");
    line.series[0]!.points = [{ x: 1.5, y: 1 }];
    expect(errorsOf(line).map((error) => error.code)).toContain("not_integer");
    line.series[0]!.points = [
      { x: 0, y: 1 },
      { x: 86_400_000, y: null },
    ];
    expect(errorsOf(line)).toEqual([]);
  });

  test("area allows one nonnegative series; donut rejects negative slices", () => {
    const area = {
      schemaVersion: 1,
      kind: "area",
      title: "t",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [{ id: "s", label: "S", points: [{ x: 1, y: -1 }] }],
    };
    expect(errorsOf(area).map((error) => error.code)).toContain("negative");
    const donut = {
      schemaVersion: 1,
      kind: "donut",
      title: "t",
      description: "",
      valueLabel: "v",
      slices: [{ id: "a", label: "A", value: -1 }],
    };
    expect(errorsOf(donut).length).toBeGreaterThan(0);
  });

  test("enforces the total Cartesian point budget at and above the limit", () => {
    const points = (count: number) => Array.from({ length: count }, (_, x) => ({ x, y: x }));
    const atLimit = {
      schemaVersion: 1,
      kind: "scatter",
      title: "t",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [{ id: "s", label: "S", points: points(CHART_POLICY.maxCartesianPoints) }],
    };
    expect(errorsOf(atLimit)).toEqual([]);
    const over = {
      ...atLimit,
      series: [{ id: "s", label: "S", points: points(CHART_POLICY.maxCartesianPoints + 1) }],
    };
    expect(errorsOf(over).length).toBeGreaterThan(0);
  });

  test("parses JSON text strictly: duplicate keys, trailing content and oversize payloads fail", () => {
    expect(parseChartSpec(JSON.stringify(REPRESENTATIVE_BAR_CHART)).ok).toBe(true);
    const duplicate = parseChartSpec('{"schemaVersion":1,"kind":"bar","kind":"line"}');
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.errors[0]?.message).toContain("Duplicate object key");
    expect(parseChartSpec(`${JSON.stringify(REPRESENTATIVE_BAR_CHART)} x`).ok).toBe(false);
    const huge = parseChartSpec(
      `{"schemaVersion":1,"pad":"${"x".repeat(CHART_POLICY.maxPayloadBytes)}"}`,
    );
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.errors[0]?.code).toBe("too_large");
  });

  test("rejects excessive nesting before walking fields", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 40; i++) nested = [nested];
    expect(errorsOf({ ...REPRESENTATIVE_BAR_CHART, categories: nested })[0]?.code).toBe("too_deep");
  });
});

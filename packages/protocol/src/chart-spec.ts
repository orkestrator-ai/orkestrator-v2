/**
 * ChartSpecV1: a narrow, declarative chart description rendered by trusted
 * application code.
 *
 * Five chart kinds, no executable expressions, no authored colours, SVG,
 * CSS, URLs or library options. The same validator runs in the backend before
 * publication and in the renderer before drawing, so a spec one accepts the
 * other accepts too. Diagnostics carry stable field paths.
 */
import { parseStrictJson } from "./canonical-json.js";
import {
  FieldErrorCollector,
  checkArray,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  checkString,
  joinPath,
  jsonDepthExceeds,
  type FieldValidation,
} from "./field-validation.js";
import { CHART_POLICY, utf8ByteLength } from "./rich-content-policy.js";

export const CHART_SCHEMA_VERSION = 1;
export const CHART_KINDS = ["bar", "line", "area", "scatter", "donut"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export interface ChartValueAxis {
  label: string;
  unit?: string;
}

export interface ChartCommonFields {
  schemaVersion: 1;
  title: string;
  description: string;
  sourceNotes?: string[];
}

export interface BarChartSpecV1 extends ChartCommonFields {
  kind: "bar";
  xAxis: { kind: "category"; label: string };
  yAxis: ChartValueAxis;
  categories: Array<{ id: string; label: string }>;
  series: Array<{
    id: string;
    label: string;
    points: Array<{ categoryId: string; value: number | null }>;
  }>;
}

export interface ContinuousXAxis {
  kind: "number" | "utc-time";
  label: string;
  unit?: string;
}

export interface LineChartSpecV1 extends ChartCommonFields {
  kind: "line";
  xAxis: ContinuousXAxis;
  yAxis: ChartValueAxis;
  series: Array<{ id: string; label: string; points: Array<{ x: number; y: number | null }> }>;
}

export interface AreaChartSpecV1 extends ChartCommonFields {
  kind: "area";
  xAxis: ContinuousXAxis;
  yAxis: ChartValueAxis;
  series: Array<{ id: string; label: string; points: Array<{ x: number; y: number | null }> }>;
}

export interface ScatterChartSpecV1 extends ChartCommonFields {
  kind: "scatter";
  xAxis: { kind: "number"; label: string; unit?: string };
  yAxis: ChartValueAxis;
  series: Array<{ id: string; label: string; points: Array<{ x: number; y: number }> }>;
}

export interface DonutChartSpecV1 extends ChartCommonFields {
  kind: "donut";
  valueLabel: string;
  unit?: string;
  slices: Array<{ id: string; label: string; value: number }>;
}

export type ChartSpecV1 =
  BarChartSpecV1 | LineChartSpecV1 | AreaChartSpecV1 | ScatterChartSpecV1 | DonutChartSpecV1;

const ID_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const TEXT_PATTERN = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const COMMON_FIELDS = ["schemaVersion", "kind", "title", "description", "sourceNotes"] as const;

function checkText(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  max: number,
  options: { optional?: boolean; min?: number } = {},
): value is string {
  return checkString(value, path, errors, {
    max,
    min: options.min ?? 0,
    pattern: TEXT_PATTERN,
    optional: options.optional,
  });
}

function checkId(value: unknown, path: string, errors: FieldErrorCollector): value is string {
  return checkString(value, path, errors, {
    min: 1,
    max: CHART_POLICY.maxIdCharacters,
    pattern: ID_PATTERN,
  });
}

function checkValueAxis(value: unknown, path: string, errors: FieldErrorCollector): void {
  if (!checkObject(value, path, ["label", "unit"], errors)) return;
  checkText(value.label, joinPath(path, "label"), errors, CHART_POLICY.maxLabelCharacters);
  checkText(value.unit, joinPath(path, "unit"), errors, CHART_POLICY.maxUnitCharacters, {
    optional: true,
  });
}

function checkChartValue(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  allowNull: boolean,
): boolean {
  if (value === null && allowNull) return true;
  return checkFiniteNumber(value, path, errors, { maxAbs: CHART_POLICY.maxAbsoluteValue });
}

function checkUniqueIds(items: unknown[], path: string, errors: FieldErrorCollector): Set<string> {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (typeof item !== "object" || item === null) return;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string") return;
    if (seen.has(id))
      errors.add(joinPath(joinPath(path, index), "id"), "duplicate_id", "Duplicate id");
    seen.add(id);
  });
  return seen;
}

function checkCommon(spec: Record<string, unknown>, errors: FieldErrorCollector): void {
  checkText(spec.title, "title", errors, CHART_POLICY.maxTitleCharacters, { min: 1 });
  checkText(spec.description, "description", errors, CHART_POLICY.maxDescriptionCharacters);
  if (spec.sourceNotes !== undefined) {
    if (checkArray(spec.sourceNotes, "sourceNotes", errors, { max: CHART_POLICY.maxSourceNotes })) {
      spec.sourceNotes.forEach((note, index) =>
        checkText(
          note,
          joinPath("sourceNotes", index),
          errors,
          CHART_POLICY.maxSourceNoteCharacters,
        ),
      );
    }
  }
}

function checkContinuousXAxis(
  value: unknown,
  errors: FieldErrorCollector,
  kinds: readonly ("number" | "utc-time")[],
): "number" | "utc-time" | null {
  if (!checkObject(value, "xAxis", ["kind", "label", "unit"], errors)) return null;
  checkText(value.label, "xAxis.label", errors, CHART_POLICY.maxLabelCharacters);
  checkText(value.unit, "xAxis.unit", errors, CHART_POLICY.maxUnitCharacters, { optional: true });
  return checkEnum(value.kind, "xAxis.kind", errors, kinds) ? value.kind : null;
}

/** Maximum Date-representable epoch milliseconds (ECMAScript time value range). */
const MAX_DATE_MS = 8.64e15;

function checkXValue(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  axisKind: "number" | "utc-time" | null,
): value is number {
  if (axisKind === "utc-time") {
    if (!checkFiniteNumber(value, path, errors, { integer: true })) return false;
    if (Math.abs(value) > MAX_DATE_MS || Math.abs(value) > CHART_POLICY.maxAbsoluteValue) {
      errors.add(path, "out_of_range", "UTC milliseconds are outside the representable date range");
      return false;
    }
    return true;
  }
  return checkFiniteNumber(value, path, errors, { maxAbs: CHART_POLICY.maxAbsoluteValue });
}

function validateBar(spec: Record<string, unknown>, errors: FieldErrorCollector): void {
  if (checkObject(spec.xAxis, "xAxis", ["kind", "label"], errors)) {
    checkEnum(spec.xAxis.kind, "xAxis.kind", errors, ["category"] as const);
    checkText(spec.xAxis.label, "xAxis.label", errors, CHART_POLICY.maxLabelCharacters);
  }
  checkValueAxis(spec.yAxis, "yAxis", errors);
  let categoryIds = new Set<string>();
  if (checkArray(spec.categories, "categories", errors, { max: CHART_POLICY.maxBarCategories })) {
    spec.categories.forEach((category, index) => {
      const path = joinPath("categories", index);
      if (!checkObject(category, path, ["id", "label"], errors)) return;
      checkId(category.id, joinPath(path, "id"), errors);
      checkText(category.label, joinPath(path, "label"), errors, CHART_POLICY.maxLabelCharacters);
    });
    categoryIds = checkUniqueIds(spec.categories, "categories", errors);
  }
  if (!checkArray(spec.series, "series", errors, { min: 1, max: CHART_POLICY.maxSeries })) return;
  checkUniqueIds(spec.series, "series", errors);
  let total = 0;
  spec.series.forEach((series, seriesIndex) => {
    const path = joinPath("series", seriesIndex);
    if (!checkObject(series, path, ["id", "label", "points"], errors)) return;
    checkId(series.id, joinPath(path, "id"), errors);
    checkText(series.label, joinPath(path, "label"), errors, CHART_POLICY.maxLabelCharacters);
    const pointsPath = joinPath(path, "points");
    if (!checkArray(series.points, pointsPath, errors, { max: CHART_POLICY.maxBarCategories })) {
      return;
    }
    total += series.points.length;
    const seen = new Set<string>();
    series.points.forEach((point, pointIndex) => {
      const pointPath = joinPath(pointsPath, pointIndex);
      if (!checkObject(point, pointPath, ["categoryId", "value"], errors)) return;
      const categoryPath = joinPath(pointPath, "categoryId");
      if (checkId(point.categoryId, categoryPath, errors)) {
        if (!categoryIds.has(point.categoryId)) {
          errors.add(categoryPath, "dangling_category", "Category id does not exist");
        } else if (seen.has(point.categoryId)) {
          errors.add(
            categoryPath,
            "duplicate_point",
            "Category already has a point in this series",
          );
        }
        seen.add(point.categoryId);
      }
      checkChartValue(point.value, joinPath(pointPath, "value"), errors, true);
    });
    for (const categoryId of categoryIds) {
      if (!seen.has(categoryId)) {
        errors.add(
          pointsPath,
          "missing_point",
          `Missing a point for category "${categoryId.slice(0, 64)}"; use an explicit null value`,
        );
      }
    }
  });
  if (total > CHART_POLICY.maxCartesianPoints) {
    errors.add("series", "too_many_points", `At most ${CHART_POLICY.maxCartesianPoints} points`);
  }
}

function validateXYSeries(
  spec: Record<string, unknown>,
  errors: FieldErrorCollector,
  options: {
    axisKind: "number" | "utc-time" | null;
    allowNullY: boolean;
    requireIncreasingX: boolean;
    maxSeries: number;
    nonnegativeY: boolean;
  },
): void {
  if (!checkArray(spec.series, "series", errors, { min: 1, max: options.maxSeries })) return;
  checkUniqueIds(spec.series, "series", errors);
  let total = 0;
  spec.series.forEach((series, seriesIndex) => {
    const path = joinPath("series", seriesIndex);
    if (!checkObject(series, path, ["id", "label", "points"], errors)) return;
    checkId(series.id, joinPath(path, "id"), errors);
    checkText(series.label, joinPath(path, "label"), errors, CHART_POLICY.maxLabelCharacters);
    const pointsPath = joinPath(path, "points");
    if (!checkArray(series.points, pointsPath, errors, { max: CHART_POLICY.maxCartesianPoints })) {
      return;
    }
    total += series.points.length;
    let previousX: number | null = null;
    series.points.forEach((point, pointIndex) => {
      const pointPath = joinPath(pointsPath, pointIndex);
      if (!checkObject(point, pointPath, ["x", "y"], errors)) return;
      const xPath = joinPath(pointPath, "x");
      if (checkXValue(point.x, xPath, errors, options.axisKind)) {
        if (options.requireIncreasingX && previousX !== null && point.x <= previousX) {
          errors.add(
            xPath,
            "not_increasing",
            "x values must be strictly increasing within a series",
          );
        }
        previousX = point.x;
      }
      const yPath = joinPath(pointPath, "y");
      if (checkChartValue(point.y, yPath, errors, options.allowNullY)) {
        if (options.nonnegativeY && typeof point.y === "number" && point.y < 0) {
          errors.add(yPath, "negative", "Area values must be nonnegative");
        }
      }
    });
  });
  if (total > CHART_POLICY.maxCartesianPoints) {
    errors.add("series", "too_many_points", `At most ${CHART_POLICY.maxCartesianPoints} points`);
  }
}

function validateDonut(spec: Record<string, unknown>, errors: FieldErrorCollector): void {
  checkText(spec.valueLabel, "valueLabel", errors, CHART_POLICY.maxLabelCharacters);
  checkText(spec.unit, "unit", errors, CHART_POLICY.maxUnitCharacters, { optional: true });
  if (!checkArray(spec.slices, "slices", errors, { max: CHART_POLICY.maxDonutSlices })) return;
  checkUniqueIds(spec.slices, "slices", errors);
  spec.slices.forEach((slice, index) => {
    const path = joinPath("slices", index);
    if (!checkObject(slice, path, ["id", "label", "value"], errors)) return;
    checkId(slice.id, joinPath(path, "id"), errors);
    checkText(slice.label, joinPath(path, "label"), errors, CHART_POLICY.maxLabelCharacters);
    checkFiniteNumber(slice.value, joinPath(path, "value"), errors, {
      min: 0,
      maxAbs: CHART_POLICY.maxAbsoluteValue,
    });
  });
}

/** Validate an already-decoded value as a ChartSpecV1. */
export function validateChartSpec(value: unknown): FieldValidation<ChartSpecV1> {
  const errors = new FieldErrorCollector();
  if (jsonDepthExceeds(value, CHART_POLICY.maxJsonDepth)) {
    errors.add("$", "too_deep", "Chart specification is nested too deeply");
    return errors.result(value as ChartSpecV1);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.add("$", "type", "Chart specification must be a JSON object");
    return errors.result(value as ChartSpecV1);
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== CHART_SCHEMA_VERSION) {
    errors.add("schemaVersion", "unsupported_version", "Only schemaVersion 1 is supported");
    return errors.result(value as ChartSpecV1);
  }
  if (!checkEnum(record.kind, "kind", errors, CHART_KINDS))
    return errors.result(value as ChartSpecV1);
  const kind = record.kind;
  const allowed: Record<ChartKind, readonly string[]> = {
    bar: [...COMMON_FIELDS, "xAxis", "yAxis", "categories", "series"],
    line: [...COMMON_FIELDS, "xAxis", "yAxis", "series"],
    area: [...COMMON_FIELDS, "xAxis", "yAxis", "series"],
    scatter: [...COMMON_FIELDS, "xAxis", "yAxis", "series"],
    donut: [...COMMON_FIELDS, "valueLabel", "unit", "slices"],
  };
  checkObject(record, "", allowed[kind], errors);
  checkCommon(record, errors);
  switch (kind) {
    case "bar":
      validateBar(record, errors);
      break;
    case "line":
    case "area": {
      const axisKind = checkContinuousXAxis(record.xAxis, errors, ["number", "utc-time"]);
      checkValueAxis(record.yAxis, "yAxis", errors);
      validateXYSeries(record, errors, {
        axisKind,
        allowNullY: true,
        requireIncreasingX: true,
        maxSeries: kind === "area" ? 1 : CHART_POLICY.maxSeries,
        nonnegativeY: kind === "area",
      });
      break;
    }
    case "scatter": {
      const axisKind = checkContinuousXAxis(record.xAxis, errors, ["number"]);
      checkValueAxis(record.yAxis, "yAxis", errors);
      validateXYSeries(record, errors, {
        axisKind,
        allowNullY: false,
        requireIncreasingX: false,
        maxSeries: CHART_POLICY.maxSeries,
        nonnegativeY: false,
      });
      break;
    }
    case "donut":
      validateDonut(record, errors);
      break;
  }
  return errors.result(value as ChartSpecV1);
}

/** Parse and validate chart JSON text (a `chart` fence body or tool payload). */
export function parseChartSpec(text: string): FieldValidation<ChartSpecV1> {
  if (utf8ByteLength(text) > CHART_POLICY.maxPayloadBytes) {
    const errors = new FieldErrorCollector();
    errors.add(
      "$",
      "too_large",
      `Chart specification exceeds ${CHART_POLICY.maxPayloadBytes} bytes of UTF-8 JSON`,
    );
    return errors.result(null as unknown as ChartSpecV1);
  }
  const parsed = parseStrictJson(text, CHART_POLICY.maxJsonDepth);
  if (!parsed.ok) {
    const errors = new FieldErrorCollector();
    errors.add(parsed.path, "invalid_json", `${parsed.message} at offset ${parsed.offset}`);
    return errors.result(null as unknown as ChartSpecV1);
  }
  return validateChartSpec(parsed.value);
}

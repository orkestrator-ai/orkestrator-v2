import { describe, expect, test } from "bun:test";
import { GRAPH_TEMPLATE_BOUNDS as B } from "./grammar";
import { isGraphPredicate, validateGraphPredicate } from "./predicates";

function errorsOf(value: unknown) {
  const result = validateGraphPredicate(value);
  return result.ok ? [] : result.errors;
}

describe("graph predicate shape", () => {
  test.each([
    [{ path: "report.issues", op: "nonEmpty" }],
    [{ path: "report.issues", op: "empty" }],
    [{ path: "report.summary", op: "exists" }],
    [{ path: "params.autoFix", op: "eq", value: true }],
    [{ path: "decision.choice", op: "neq", value: "ship" }],
    [{ path: "verdict.notes", op: "eq", value: null }],
    [{ path: "run.iteration", op: "gt", value: 1 }],
    [{ path: "score", op: "lte", value: 0.5 }],
    [{ path: "severity", op: "in", value: ["P0", "P1"] }],
    [{ path: "report.issues", op: "count", compare: "gte", value: 2 }],
    [{ all: [{ path: "a", op: "exists" }, { not: { path: "b", op: "empty" } }] }],
    [{ any: [{ path: "has-findings.findings", op: "exists" }] }],
  ])("accepts %j", (predicate) => {
    expect(errorsOf(predicate)).toEqual([]);
    expect(isGraphPredicate(predicate)).toBe(true);
  });

  test.each([
    ["a missing predicate", undefined, "$", "required"],
    ["an array", [], "$", "type"],
    ["no op", { path: "a" }, "$", "predicate"],
    ["an unknown op", { path: "a", op: "matches", value: ".*" }, "op", "enum"],
    ["eq without a value", { path: "a", op: "eq" }, "value", "required"],
    ["exists with a value", { path: "a", op: "exists", value: true }, "value", "unknown_field"],
    ["an object value", { path: "a", op: "eq", value: { b: 1 } }, "value", "type"],
    ["an ordering against a string", { path: "a", op: "lt", value: "b" }, "value", "type"],
    [
      "a non-finite number",
      { path: "a", op: "gt", value: Number.POSITIVE_INFINITY },
      "value",
      "not_finite",
    ],
    ["an empty in-list", { path: "a", op: "in", value: [] }, "value", "too_few"],
    ["in without a list", { path: "a", op: "in", value: "P0" }, "value", "type"],
    ["count without compare", { path: "a", op: "count", value: 1 }, "compare", "required"],
    [
      "count with an unknown compare",
      { path: "a", op: "count", compare: "between", value: 1 },
      "compare",
      "enum",
    ],
    [
      "a negative count",
      { path: "a", op: "count", compare: "gt", value: -1 },
      "value",
      "out_of_range",
    ],
    ["an empty all", { all: [] }, "all", "too_few"],
    [
      "all mixed with a leaf",
      { all: [{ path: "a", op: "exists" }], op: "exists" },
      "op",
      "unknown_field",
    ],
    ["not of a list", { not: [] }, "not", "type"],
    ["a bad path", { path: "a b", op: "exists" }, "path", "pattern"],
    ["no path", { op: "exists" }, "path", "required"],
  ])("rejects %s", (_name, predicate, path, code) => {
    expect(errorsOf(predicate)).toContainEqual(expect.objectContaining({ path, code }));
  });

  test("bounds depth", () => {
    let predicate: unknown = { path: "a", op: "exists" };
    for (let index = 0; index < B.maxPredicateDepth; index++) predicate = { not: predicate };
    expect(errorsOf(predicate)).toContainEqual(expect.objectContaining({ code: "too_deep" }));
  });

  test("bounds the node count", () => {
    const leaves = Array.from({ length: B.maxPredicateNodes }, () => ({ path: "a", op: "exists" }));
    expect(errorsOf({ any: leaves })).toContainEqual(
      // The first node over the budget: the combinator plus 63 leaves fit.
      expect.objectContaining({ path: `any[${B.maxPredicateNodes - 1}]`, code: "too_many" }),
    );
    expect(errorsOf({ any: leaves.slice(1) })).toEqual([]);
  });

  test("bounds in-lists and string literals", () => {
    const values = Array.from({ length: B.maxPredicateListValues + 1 }, (_, index) => index);
    expect(errorsOf({ path: "a", op: "in", value: values })).toContainEqual(
      expect.objectContaining({ path: "value", code: "too_many" }),
    );
    expect(
      errorsOf({ path: "a", op: "eq", value: "x".repeat(B.maxPredicateStringBytes + 1) }),
    ).toContainEqual(expect.objectContaining({ path: "value", code: "too_large" }));
    expect(errorsOf({ path: "a", op: "eq", value: "" })).toEqual([]);
  });
});

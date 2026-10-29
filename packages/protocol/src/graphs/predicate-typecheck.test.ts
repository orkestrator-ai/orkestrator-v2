import { describe, expect, test } from "bun:test";
import { FieldErrorCollector } from "../field-validation";
import { graphTemplateExamples } from "./examples";
import {
  GRAPH_PREDICATE_TYPE_CODES,
  type GraphPredicateScope,
  graphFilterPredicateScope,
  graphLoopPredicateScope,
  graphNodePredicateScope,
  typeCheckGraphPredicate,
  checkGraphPredicateTypes,
} from "./predicates";
import type { GraphParameter, GraphTemplateV1 } from "./template";
import { GraphTypeLibrary, type GraphValueType } from "./types";

const library = new GraphTypeLibrary();
const parameters: GraphParameter[] = [
  { key: "autoFix", type: "boolean", default: true },
  { key: "maxFindings", type: "integer", min: 0, max: 50 },
  { key: "threshold", type: "number" },
  { key: "mode", type: "enum", options: ["fast", "thorough"] },
  { key: "note", type: "string" },
];

const nodeScope = graphNodePredicateScope(
  [
    { name: "report", type: "review-report@1" },
    { name: "reports", type: "list<review-report@1>" },
    { name: "verdict", type: "verification-verdict@1" },
    { name: "judgement", type: "decision@1", choices: ["simplicity", "security"] },
    { name: "free", type: "decision@1" },
    { name: "mystery", type: "no-such-type@1" },
  ],
  parameters,
  library,
);

function errorsOf(predicate: unknown, scope: GraphPredicateScope = nodeScope) {
  const result = typeCheckGraphPredicate(predicate, scope);
  return result.ok ? [] : result.errors;
}

describe("predicate type checker", () => {
  test.each([
    {
      any: [
        { path: "report.issues", op: "nonEmpty" },
        { path: "report.testCoverageGaps", op: "nonEmpty" },
      ],
    },
    { path: "report.verdict.ready", op: "in", value: ["yes", "with-fixes"] },
    { path: "report.verdict.ready", op: "neq", value: "no" },
    { path: "report.issues", op: "count", compare: "gte", value: 3 },
    { path: "report.summaryOfChange", op: "empty" },
    { path: "reports", op: "count", compare: "gt", value: 0 },
    { path: "reports", op: "nonEmpty" },
    { path: "verdict.complete", op: "eq", value: true },
    { path: "verdict", op: "exists" },
    { path: "judgement.choice", op: "eq", value: "security" },
    { path: "free.choice", op: "eq", value: "anything" },
    { path: "params.autoFix", op: "eq", value: true },
    { path: "params.maxFindings", op: "lte", value: 2.5 },
    { path: "params.maxFindings", op: "in", value: [1, 2, 3] },
    { path: "params.threshold", op: "eq", value: 0.75 },
    { path: "params.mode", op: "eq", value: "fast" },
    { path: "params.note", op: "nonEmpty" },
    { path: "run.iteration", op: "gt", value: 1 },
    {
      not: {
        all: [
          { path: "run.iteration", op: "eq", value: 1 },
          { path: "params", op: "exists" },
        ],
      },
    },
    // An unresolved port type is reported at the port; its paths are not checked again.
    { path: "mystery.anything.at.all", op: "lt", value: 1 },
  ])("accepts %j", (predicate) => {
    expect(errorsOf(predicate)).toEqual([]);
  });

  test.each([
    ["an unknown root", { path: "plan.commands", op: "nonEmpty" }, "path", "unknown_root"],
    ["a missing field", { path: "report.findings", op: "nonEmpty" }, "path", "unknown_path"],
    [
      "a field of a string",
      { path: "report.summaryOfChange.length", op: "gt", value: 1 },
      "path",
      "unknown_path",
    ],
    [
      "an unknown parameter",
      { path: "params.autoPr", op: "eq", value: true },
      "path",
      "unknown_path",
    ],
    [
      "a run field other than iteration",
      { path: "run.attempt", op: "gt", value: 1 },
      "path",
      "unknown_path",
    ],
    [
      "a path into a list",
      { path: "report.issues.severity", op: "eq", value: "P0" },
      "path",
      "through_list",
    ],
    ["a path into a list port", { path: "reports.issues", op: "nonEmpty" }, "path", "through_list"],
    [
      "lt on a string",
      { path: "report.summaryOfChange", op: "lt", value: 3 },
      "op",
      "operator_type",
    ],
    ["gte on a boolean", { path: "verdict.complete", op: "gte", value: 1 }, "op", "operator_type"],
    ["nonEmpty on a number", { path: "params.threshold", op: "nonEmpty" }, "op", "operator_type"],
    ["empty on a boolean", { path: "params.autoFix", op: "empty" }, "op", "operator_type"],
    [
      "count on a string",
      { path: "report.summaryOfChange", op: "count", compare: "gt", value: 0 },
      "op",
      "operator_type",
    ],
    [
      "count on an object",
      { path: "report.verdict", op: "count", compare: "gt", value: 0 },
      "op",
      "operator_type",
    ],
    ["eq on a list", { path: "report.issues", op: "eq", value: 0 }, "op", "operator_type"],
    ["eq on an object", { path: "report.verdict", op: "eq", value: "yes" }, "op", "operator_type"],
    ["in on a list", { path: "reports", op: "in", value: ["a"] }, "op", "operator_type"],
    [
      "a string against a boolean",
      { path: "verdict.complete", op: "eq", value: "true" },
      "value",
      "value_type",
    ],
    [
      "a number against a string",
      { path: "params.note", op: "neq", value: 1 },
      "value",
      "value_type",
    ],
    [
      "a fraction against an integer",
      { path: "run.iteration", op: "eq", value: 1.5 },
      "value",
      "value_type",
    ],
    [
      "null against a non-null field",
      { path: "verdict.complete", op: "eq", value: null },
      "value",
      "value_type",
    ],
    [
      "an in-entry of the wrong type",
      { path: "params.mode", op: "in", value: ["fast", 2] },
      "value[1]",
      "value_type",
    ],
    [
      "a value outside an enum",
      { path: "report.verdict.ready", op: "eq", value: "maybe" },
      "value",
      "enum_value",
    ],
    [
      "a parameter option that does not exist",
      { path: "params.mode", op: "neq", value: "slow" },
      "value",
      "enum_value",
    ],
    [
      "a choice the producer does not offer",
      { path: "judgement.choice", op: "in", value: ["security", "speed"] },
      "value[1]",
      "enum_value",
    ],
    [
      "in with a non-list value (structural)",
      { path: "params.mode", op: "in", value: "fast" },
      "value",
      "type",
    ],
  ])("rejects %s", (_name, predicate, path, code) => {
    expect(errorsOf(predicate)).toContainEqual(expect.objectContaining({ path, code }));
  });

  test("reports nested diagnostics at their own paths", () => {
    expect(
      errorsOf({
        all: [
          { path: "report.issues", op: "nonEmpty" },
          {
            any: [
              { not: { path: "report.nope", op: "exists" } },
              { path: "params.autoFix", op: "lt", value: 1 },
            ],
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({ path: "all[1].any[0].not.path", code: "unknown_path" }),
      expect.objectContaining({ path: "all[1].any[1].op", code: "operator_type" }),
    ]);
  });

  test("adds to a caller's collector under a base path", () => {
    const errors = new FieldErrorCollector();
    checkGraphPredicateTypes({ path: "nope", op: "exists" }, nodeScope, "nodes[2].when", errors);
    expect(errors.errors).toEqual([
      expect.objectContaining({ path: "nodes[2].when.path", code: "unknown_root" }),
    ]);
  });

  test("allows null comparisons on nullable fields only", () => {
    const filter = graphFilterPredicateScope(listOf("finding@1"));
    expect(filter.ok).toBe(true);
    expect(errorsOf({ path: "line", op: "eq", value: null }, filter.scope)).toEqual([]);
    expect(errorsOf({ path: "line", op: "gt", value: 10 }, filter.scope)).toEqual([]);
    expect(errorsOf({ path: "reviewSourceIds", op: "neq", value: null }, filter.scope)).toEqual([]);
    expect(errorsOf({ path: "title", op: "eq", value: null }, filter.scope)).toContainEqual(
      expect.objectContaining({ code: "value_type" }),
    );
  });

  test("types filter paths against one list element", () => {
    const { scope } = graphFilterPredicateScope(listOf("finding@1"));
    expect(errorsOf({ path: "severity", op: "in", value: ["P0", "P1"] }, scope)).toEqual([]);
    expect(errorsOf({ path: "confidence", op: "gte", value: 80 }, scope)).toEqual([]);
    expect(errorsOf({ path: "severity", op: "in", value: ["P0", "P4"] }, scope)).toContainEqual(
      expect.objectContaining({ path: "value[1]", code: "enum_value" }),
    );
    // Element paths have no roots: `params` is a field name here.
    expect(errorsOf({ path: "params.autoFix", op: "exists" }, scope)).toContainEqual(
      expect.objectContaining({ path: "path", code: "unknown_path" }),
    );
    const single = graphFilterPredicateScope(listOf("finding@1").element);
    expect(single).toMatchObject({ ok: false, code: "requires_list" });
    expect(errorsOf({ path: "anything", op: "exists" }, single.scope)).toEqual([]);
  });

  test("loop scopes use <nodeId>.<port> roots", () => {
    const scope = graphLoopPredicateScope(
      [
        { node: "verify", port: "verdict", type: "verification-verdict@1" },
        { node: "verify", port: "code", type: "workspace@1" },
      ],
      parameters,
      library,
    );
    expect(errorsOf({ path: "verify.verdict.complete", op: "eq", value: true }, scope)).toEqual([]);
    expect(errorsOf({ path: "verify.verdict.acceptanceCriteria", op: "empty" }, scope)).toEqual([]);
    expect(errorsOf({ path: "verify.code.branch", op: "nonEmpty" }, scope)).toEqual([]);
    expect(errorsOf({ path: "verify.verdict.done", op: "eq", value: true }, scope)).toContainEqual(
      expect.objectContaining({ code: "unknown_path" }),
    );
    expect(errorsOf({ path: "verify.report", op: "exists" }, scope)).toContainEqual(
      expect.objectContaining({ code: "unknown_root" }),
    );
    expect(errorsOf({ path: "verdict.complete", op: "exists" }, scope)).toContainEqual(
      expect.objectContaining({ code: "unknown_root" }),
    );
  });

  test("reserved roots win over ports of the same name", () => {
    const scope = graphNodePredicateScope(
      [
        { name: "params", type: "text@1" },
        { name: "report", type: "review-report@1" },
      ],
      parameters,
      library,
    );
    expect(errorsOf({ path: "params.autoFix", op: "eq", value: true }, scope)).toContainEqual(
      expect.objectContaining({ path: "path", code: "shadowed_root" }),
    );
    expect(errorsOf({ path: "params.text", op: "exists" }, scope)).toContainEqual(
      expect.objectContaining({ code: "unknown_path" }),
    );
    expect(errorsOf({ path: "report.issues", op: "empty" }, scope)).toEqual([]);
  });

  test("every diagnostic code is documented", () => {
    expect(([...GRAPH_PREDICATE_TYPE_CODES] as string[]).sort()).toEqual(
      [
        "enum_value",
        "operator_type",
        "requires_list",
        "shadowed_root",
        "through_list",
        "unknown_path",
        "unknown_root",
        "value_type",
      ].sort(),
    );
  });
});

function listOf(ref: string): Extract<GraphValueType, { kind: "list" }> {
  const resolved = library.resolve(ref);
  if (!resolved.ok) throw new Error(`unresolved ${ref}`);
  return { kind: "list", element: resolved.type };
}

/** Every condition in the report §9 examples type-checks, scoped as 107 will. */
describe("predicates in the worked examples", () => {
  function scopesOf(template: GraphTemplateV1) {
    const library = new GraphTypeLibrary(template.types ?? []);
    const checks: { where: string; predicate: unknown; scope: GraphPredicateScope }[] = [];
    template.nodes.forEach((node, index) => {
      const scope = graphNodePredicateScope(node.inputs ?? [], template.parameters, library);
      if (node.when) checks.push({ where: `nodes[${index}].when`, predicate: node.when, scope });
      if (node.kind === "gate") {
        node.branches.forEach((branch, branchIndex) =>
          checks.push({
            where: `nodes[${index}].branches[${branchIndex}].when`,
            predicate: branch.when,
            scope,
          }),
        );
      }
    });
    template.loops?.forEach((loop, index) => {
      const outputs = template.nodes
        .filter((node) => loop.nodes.includes(node.id))
        .flatMap((node) =>
          "outputs" in node && node.outputs
            ? node.outputs.map((port) => ({ node: node.id, port: port.name, type: port.type }))
            : [],
        );
      checks.push({
        where: `loops[${index}].until`,
        predicate: loop.until,
        scope: graphLoopPredicateScope(outputs, template.parameters, library),
      });
    });
    return checks;
  }

  const cases = graphTemplateExamples().flatMap((example) =>
    scopesOf(example.template).map((check) => ({ key: example.key, ...check })),
  );

  test("the examples contain conditions in every position", () => {
    expect(cases.some((entry) => entry.where.includes("branches"))).toBe(true);
    expect(
      cases.some((entry) => entry.where.endsWith(".when") && !entry.where.includes("branches")),
    ).toBe(true);
    expect(cases.some((entry) => entry.where.endsWith(".until"))).toBe(true);
  });

  test.each(cases.map((entry) => [`${entry.key} ${entry.where}`, entry] as const))(
    "%s type-checks",
    (_name, entry) => {
      expect(errorsOf(entry.predicate, entry.scope)).toEqual([]);
      // Every root resolved, so the paths really were checked.
      if (entry.scope.kind === "roots") {
        expect(entry.scope.roots.filter((root) => root.schema === null)).toEqual([]);
      }
    },
  );
});

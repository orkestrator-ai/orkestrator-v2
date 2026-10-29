import { describe, expect, test } from "bun:test";
import type {
  CompiledGraphPlan,
  GraphPlanEdge,
  GraphPlanInputPort,
  GraphPlanValueType,
} from "@orkestrator/protocol/graphs/compile";
import type { ArtifactTypeDef } from "@orkestrator/protocol/graphs/artifact-type-def";
import type { GraphEdgeTransform } from "@orkestrator/protocol/graphs/template";
import { graphBuiltInType } from "@orkestrator/protocol/graphs/types";
import {
  GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS,
  applyGraphEdgeTransforms,
  graphEdgeNeedsDelivery,
  pickGraphValue,
  planGraphEdgeDelivery,
} from "./graph-edge-transforms.js";

const REPORT = graphBuiltInType("review-report@1")!.example as { issues: unknown[] };

const named = (ref: string): GraphPlanValueType => ({ kind: "named", ref });
const list = (element: GraphPlanValueType): GraphPlanValueType => ({ kind: "list", element });

function edge(
  transform: GraphEdgeTransform[],
  options: { source?: GraphPlanValueType; budgetCheck?: boolean } = {},
): GraphPlanEdge {
  return {
    id: "e1",
    from: { node: "review", port: "report" },
    to: { node: "fix", port: "findings" },
    transform,
    zip: false,
    iterations: "all",
    sourceType: options.source ?? list(named("review-report@1")),
    deliveredType: null,
    budgetCheck: options.budgetCheck ?? false,
    fanIn: true,
  };
}

function port(type: string, fanIn = false): GraphPlanInputPort {
  return {
    name: "findings",
    type,
    required: true,
    deliveredType: null,
    perBranch: false,
    fanIn,
    edges: ["e1"],
    carries: [],
  };
}

function plan(types: ArtifactTypeDef[] = []): CompiledGraphPlan {
  return { types } as unknown as CompiledGraphPlan;
}

describe("edge transforms on values (§5.7)", () => {
  test("pick keeps the named fields and their structure, leaves missing ones out", () => {
    const value = { a: 1, b: { c: 2, d: 3 }, e: null, f: "x" };
    expect(pickGraphValue(value, ["a", "b.c", "e.g", "missing"])).toEqual({
      a: 1,
      b: { c: 2 },
      e: null,
    });
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as unknown;
    const picked = pickGraphValue(hostile, ["__proto__.polluted", "a"]) as Record<string, unknown>;
    expect(Object.getPrototypeOf(picked)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(picked).sort()).toEqual(["__proto__", "a"]);
  });

  test("filter keeps elements the predicate definitely holds for; limit takes the first n", () => {
    const findings = [
      { severity: "P0", title: "a" },
      { severity: "P2", title: "b" },
      { title: "c" },
      { severity: "P1", title: "d" },
    ];
    const result = applyGraphEdgeTransforms(
      findings,
      [
        { op: "filter", where: { path: "severity", op: "in", value: ["P0", "P1"] } },
        { op: "limit", count: 1 },
      ],
      { list: true },
    );
    expect(result).toEqual({ ok: true, list: true, value: [{ severity: "P0", title: "a" }] });
    // A filter needs a list.
    expect(
      applyGraphEdgeTransforms({ a: 1 }, [{ op: "limit", count: 1 }], { list: false }),
    ).toMatchObject({ ok: false, code: "requires_list", index: 0 });
  });

  test("flatten concatenates a path of one value or of every element; null contributes nothing", () => {
    expect(
      applyGraphEdgeTransforms({ issues: [1, 2] }, [{ op: "flatten", path: "issues" }], {
        list: false,
      }),
    ).toEqual({ ok: true, list: true, value: [1, 2] });
    expect(
      applyGraphEdgeTransforms(
        [{ issues: [1] }, { issues: null }, {}, { issues: [2, 3] }],
        [{ op: "flatten", path: "issues" }],
        { list: true },
      ),
    ).toEqual({ ok: true, list: true, value: [1, 2, 3] });
  });

  test("adapt runs a built-in adapter on one value or each element", () => {
    const adapted = applyGraphEdgeTransforms(
      [REPORT, REPORT],
      [{ op: "adapt", adapter: "review-report-to-finding-list" }],
      { list: true },
    );
    expect(adapted).toEqual({ ok: true, list: true, value: [...REPORT.issues, ...REPORT.issues] });
    expect(
      applyGraphEdgeTransforms({ text: "hi" }, [{ op: "adapt", adapter: "text-to-markdown" }], {
        list: false,
      }),
    ).toEqual({ ok: true, list: false, value: { markdown: "hi" } });
    expect(
      applyGraphEdgeTransforms({}, [{ op: "adapt", adapter: "no-such" }], { list: false }),
    ).toMatchObject({ ok: false, code: "unknown_adapter" });
  });
});

describe("deliveries", () => {
  test("only edges with transforms or a budget check need values at delivery", () => {
    expect(graphEdgeNeedsDelivery(edge([]))).toBe(false);
    expect(graphEdgeNeedsDelivery(edge([], { budgetCheck: true }))).toBe(true);
    expect(graphEdgeNeedsDelivery(edge([{ op: "limit", count: 2 }]))).toBe(true);
  });

  test("filter and limit forward the source artifacts themselves", () => {
    const sources = [
      { id: "a", value: REPORT },
      { id: "b", value: { ...REPORT, issues: [] } },
      { id: "c", value: REPORT },
    ];
    const delivery = planGraphEdgeDelivery({
      plan: plan(),
      edge: edge([
        { op: "filter", where: { path: "issues", op: "nonEmpty" } },
        { op: "limit", count: 5 },
      ]),
      port: port("list<review-report@1>", true),
      sources,
    });
    expect(delivery).toEqual({ kind: "forward", ids: ["a", "c"] });
  });

  test("flatten makes new artifacts of the port's element type, with the sources as lineage", () => {
    const delivery = planGraphEdgeDelivery({
      plan: plan(),
      edge: edge([{ op: "flatten", path: "issues" }]),
      port: port("list<finding@1>", true),
      sources: [
        { id: "a", value: REPORT },
        { id: "b", value: REPORT },
      ],
    });
    expect(delivery).toEqual({
      kind: "store",
      type: "finding@1",
      values: [...REPORT.issues, ...REPORT.issues],
      inputs: ["a", "b"],
    });
  });

  test("an empty result forwards nothing; a list into a single port fails", () => {
    expect(
      planGraphEdgeDelivery({
        plan: plan(),
        edge: edge([{ op: "flatten", path: "issues" }]),
        port: port("list<finding@1>", true),
        sources: [{ id: "a", value: { ...REPORT, issues: [] } }],
      }),
    ).toEqual({ kind: "forward", ids: [] });
    expect(
      planGraphEdgeDelivery({
        plan: plan(),
        edge: edge([{ op: "flatten", path: "issues" }], { source: named("review-report@1") }),
        port: port("finding@1"),
        sources: [{ id: "a", value: REPORT }],
      }),
    ).toMatchObject({ kind: "failed", cause: "system-error" });
  });

  test("a runtime budget check fails a value over the target type's budgets", () => {
    const small: ArtifactTypeDef = {
      name: "note",
      version: 1,
      schema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      storage: "value",
      budgets: { maxBytes: 64, maxStringBytes: 16 },
    };
    const deliver = (text: string) =>
      planGraphEdgeDelivery({
        plan: plan([small]),
        edge: edge([], { source: named("big-note@1"), budgetCheck: true }),
        port: port("note@1"),
        sources: [{ id: "a", value: { text } }],
      });
    expect(deliver("short")).toEqual({ kind: "forward", ids: ["a"] });
    const over = deliver("x".repeat(40));
    expect(over).toMatchObject({ kind: "failed", cause: "budget-exceeded" });
    expect(over.kind === "failed" && over.message).toContain("too_large");
    expect(over.kind === "failed" && over.message).not.toContain("xxxx");
  });

  test("a delivery binds at most the per-port artifact bound", () => {
    const many = { ...REPORT, issues: Array.from({ length: 200 }, () => REPORT.issues[0]) };
    const delivery = planGraphEdgeDelivery({
      plan: plan(),
      edge: edge([{ op: "flatten", path: "issues" }]),
      port: port("list<finding@1>", true),
      sources: [
        { id: "a", value: many },
        { id: "b", value: many },
      ],
    });
    expect(delivery).toMatchObject({ kind: "failed", cause: "budget-exceeded" });
    expect(delivery.kind === "failed" && delivery.message).toContain(
      `at most ${GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS}`,
    );
    // A limit makes it fit.
    expect(
      planGraphEdgeDelivery({
        plan: plan(),
        edge: edge([
          { op: "flatten", path: "issues" },
          { op: "limit", count: 20 },
        ]),
        port: port("list<finding@1>", true),
        sources: [
          { id: "a", value: many },
          { id: "b", value: many },
        ],
      }),
    ).toMatchObject({ kind: "store", type: "finding@1" });
  });

  test("pick into a single port stores the projection as the port's type", () => {
    const delivery = planGraphEdgeDelivery({
      plan: plan(),
      edge: edge([{ op: "pick", fields: ["text"] }], { source: named("text@1") }),
      port: port("text@1"),
      sources: [{ id: "a", value: { text: "hello" } }],
    });
    expect(delivery).toEqual({
      kind: "store",
      type: "text@1",
      values: [{ text: "hello" }],
      inputs: ["a"],
    });
  });
});

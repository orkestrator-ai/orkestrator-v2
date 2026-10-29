import { describe, expect, test } from "bun:test";
import type { ArtifactTypeDef } from "./artifact-type-def";
import { graphTemplateExample } from "./examples";
import {
  applyGraphTypeAdapter,
  graphEdgeTransformResultType,
  graphEdgeTransformsResultType,
  graphTypeAdapter,
  graphTypeAdapters,
  graphTypeAssignability,
  isGraphSchemaSubtype,
  suggestGraphTypeAdapters,
} from "./type-assignability";
import {
  GraphTypeLibrary,
  graphBuiltInType,
  graphValueTypeLabel,
  validateGraphArtifactValue,
  type GraphValueType,
} from "./types";

// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

function object(properties: Record<string, Draft>): Draft {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function custom(name: string, schema: Draft, budgets: Draft = { maxBytes: 4096 }): ArtifactTypeDef {
  return { name, version: 1, schema, storage: "value", budgets };
}

const NOTE = custom("note", object({ text: { type: "string" } }), {
  maxBytes: 4096,
  maxStringBytes: 1024,
});
const RICH_NOTE = custom(
  "rich-note",
  object({ text: { type: "string" }, level: { type: "integer", minimum: 1, maximum: 3 } }),
  { maxBytes: 2048, maxStringBytes: 512 },
);
const LOOSE_NOTE = custom(
  "loose-note",
  object({ text: { type: "string" }, level: { type: "number" } }),
  { maxBytes: 8192 },
);

const library = new GraphTypeLibrary([
  NOTE,
  RICH_NOTE,
  LOOSE_NOTE,
  ...graphTemplateExample("failure-diagnosis").types!,
]);

function type(ref: string): GraphValueType {
  const result = library.resolve(ref);
  if (!result.ok) throw new Error(result.message);
  return result.type;
}

function assign(from: string, to: string) {
  return graphTypeAssignability(type(from), type(to));
}

describe("assignability", () => {
  test("the same name and major always fit", () => {
    expect(assign("review-report@1", "review-report@1")).toEqual({ ok: true, via: "identical" });
    expect(assign("list<finding@1>", "list<finding@1>")).toEqual({ ok: true, via: "identical" });
  });

  test("lists fit lists of a fitting element, never single values", () => {
    expect(assign("list<review-report@1>", "review-report@1")).toMatchObject({
      ok: false,
      code: "cardinality",
    });
    expect(assign("review-report@1", "list<review-report@1>")).toMatchObject({
      ok: false,
      code: "cardinality",
    });
    expect(assign("list<list<finding@1>>", "list<finding@1>")).toMatchObject({
      ok: false,
      code: "cardinality",
    });
  });

  test("built-in types with domain checks are nominal", () => {
    expect(assign("review-report@1", "finding@1")).toMatchObject({
      ok: false,
      code: "nominal_target",
    });
    expect(assign("note@1", "decision@1")).toMatchObject({ ok: false, code: "nominal_target" });
  });

  test("a structural subtype fits a target without domain checks", () => {
    // rich-note's integer level in 1..3 fits loose-note's number level, and
    // its budgets fit inside loose-note's.
    expect(assign("rich-note@1", "loose-note@1")).toEqual({
      ok: true,
      via: "structural",
      budgetCheck: false,
    });
    // text@1 has no domain validator: a custom type with the same field fits.
    expect(assign("note@1", "text@1")).toEqual({ ok: true, via: "structural", budgetCheck: false });
  });

  test("budgets that do not provably fit are checked as the value crosses the edge", () => {
    expect(assign("text@1", "note@1")).toEqual({ ok: true, via: "structural", budgetCheck: true });
  });

  test("extra fields, missing fields and wider values do not fit", () => {
    // Subset objects forbid unknown fields: extra fields need a pick.
    expect(assign("rich-note@1", "note@1")).toMatchObject({
      ok: false,
      code: "schema_mismatch",
      path: "$.level",
    });
    expect(assign("note@1", "rich-note@1")).toMatchObject({
      ok: false,
      code: "schema_mismatch",
      path: "$.level",
    });
    // A number level is wider than an integer in 1..3.
    expect(assign("loose-note@1", "rich-note@1")).toMatchObject({
      ok: false,
      code: "schema_mismatch",
      path: "$.level",
    });
  });

  test("storage classes must match", () => {
    const refs = new GraphTypeLibrary([
      { ...custom("pointer", object({ id: { type: "string" } })), storage: "reference" },
      custom("plain", object({ id: { type: "string" } })),
    ]);
    const from = refs.resolve("pointer@1");
    const to = refs.resolve("plain@1");
    expect(from.ok && to.ok && graphTypeAssignability(from.type, to.type)).toMatchObject({
      ok: false,
      code: "storage_mismatch",
    });
  });

  test("a different major version never fits", () => {
    const versions = new GraphTypeLibrary([NOTE, { ...NOTE, version: 2 }]);
    const v1 = versions.resolve("note@1");
    const v2 = versions.resolve("note@2");
    expect(v1.ok && v2.ok && graphTypeAssignability(v1.type, v2.type)).toMatchObject({
      ok: false,
      code: "version_mismatch",
    });
  });
});

describe("schema subtypes", () => {
  test("nullable, literals, ranges and unions", () => {
    const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
    expect(isGraphSchemaSubtype({ type: "string" }, nullableString).ok).toBe(true);
    expect(isGraphSchemaSubtype(nullableString, { type: "string" }).ok).toBe(false);
    expect(
      isGraphSchemaSubtype({ type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] })
        .ok,
    ).toBe(true);
    expect(
      isGraphSchemaSubtype({ type: "string", enum: ["c"] }, { type: "string", enum: ["a", "b"] })
        .ok,
    ).toBe(false);
    expect(isGraphSchemaSubtype({ type: "string" }, { type: "string", enum: ["a"] }).ok).toBe(
      false,
    );
    expect(isGraphSchemaSubtype({ type: "integer" }, { type: "number" }).ok).toBe(true);
    expect(isGraphSchemaSubtype({ type: "number" }, { type: "integer" }).ok).toBe(false);
    expect(isGraphSchemaSubtype({ type: "integer" }, { type: "integer", minimum: 0 }).ok).toBe(
      false,
    );
    expect(
      isGraphSchemaSubtype({ type: "integer", minimum: 1 }, { type: "integer", minimum: 0 }).ok,
    ).toBe(true);
    expect(
      isGraphSchemaSubtype(
        { type: "array", items: { type: "integer" } },
        { type: "array", items: { type: "number" } },
      ).ok,
    ).toBe(true);
  });
});

describe("edge transforms", () => {
  const result = (from: string, transform: Draft) =>
    graphEdgeTransformResultType(type(from), transform, library);
  const label = (from: string, transform: Draft) => {
    const outcome = result(from, transform);
    return outcome.ok ? graphValueTypeLabel(outcome.type) : outcome.code;
  };

  test("filter and limit keep a list's type and need a list", () => {
    expect(label("list<finding@1>", { op: "limit", count: 5 })).toBe("list<finding@1>");
    expect(
      label("list<finding@1>", {
        op: "filter",
        where: { path: "severity", op: "eq", value: "P0" },
      }),
    ).toBe("list<finding@1>");
    expect(label("finding@1", { op: "limit", count: 5 })).toBe("requires_list");
  });

  test("pick projects one value or each element", () => {
    const picked = result("review-report@1", { op: "pick", fields: ["issues", "verdict.ready"] });
    expect(picked.ok).toBe(true);
    if (!picked.ok || picked.type.kind !== "shape") throw new Error("expected a shape");
    expect(Object.keys(picked.type.schema.properties as object)).toEqual(["issues", "verdict"]);
    expect((picked.type.schema.properties as Draft).verdict).toEqual(
      object({
        ready: (graphBuiltInType("review-report@1")!.schema.properties as Draft).verdict.properties
          .ready,
      }),
    );
    expect(isGraphSchemaSubtype(picked.type.schema, picked.type.schema).ok).toBe(true);
    const listed = result("list<review-report@1>", { op: "pick", fields: ["issues"] });
    expect(listed.ok && listed.type.kind).toBe("list");
    expect(label("review-report@1", { op: "pick", fields: ["nope"] })).toBe("unknown_field");
    expect(label("review-report@1", { op: "pick", fields: ["issues.title"] })).toBe(
      "unknown_field",
    );
  });

  test("flatten names the item type of an items list", () => {
    expect(label("list<review-report@1>", { op: "flatten", path: "issues" })).toBe(
      "list<finding@1>",
    );
    expect(label("review-report@1", { op: "flatten", path: "issues" })).toBe("list<finding@1>");
    // Coverage gaps have no named type: the elements are a shape.
    const gaps = result("review-report@1", { op: "flatten", path: "testCoverageGaps" });
    expect(gaps.ok && gaps.type.kind === "list" && gaps.type.element.kind).toBe("shape");
    expect(label("review-report@1", { op: "flatten", path: "verdict" })).toBe("not_a_list");
    expect(label("review-report@1", { op: "flatten", path: "nope" })).toBe("unknown_field");
    expect(label("list<list<review-report@1>>", { op: "flatten", path: "issues" })).toBe(
      "too_deep",
    );
  });

  test("the §9.4 failures edge type-checks structurally", () => {
    const flattened = result("validation-results@1", { op: "flatten", path: "failures" });
    expect(flattened.ok).toBe(true);
    if (!flattened.ok) return;
    // The element inherits the results' byte budget, so the runtime checks it.
    expect(graphTypeAssignability(flattened.type, type("list<validation-failure@1>"))).toEqual({
      ok: true,
      via: "structural",
      budgetCheck: true,
    });
  });

  test("adapt runs a named adapter, lifted over a list", () => {
    const adapt = { op: "adapt", adapter: "review-report-to-finding-list" };
    expect(label("review-report@1", adapt)).toBe("list<finding@1>");
    expect(label("list<review-report@1>", adapt)).toBe("list<finding@1>");
    expect(label("list<ticket@1>", { op: "adapt", adapter: "ticket-to-markdown" })).toBe(
      "list<markdown@1>",
    );
    expect(label("finding@1", adapt)).toBe("adapter_mismatch");
    expect(label("review-report@1", { op: "adapt", adapter: "nope" })).toBe("unknown_adapter");
  });

  test("transforms chain, and a failure names its index", () => {
    const chained = graphEdgeTransformsResultType(
      type("list<review-report@1>"),
      [
        { op: "flatten", path: "issues" },
        { op: "filter", where: { path: "severity", op: "in", value: ["P0", "P1"] } },
        { op: "limit", count: 20 },
      ],
      library,
    );
    expect(chained.ok && graphValueTypeLabel(chained.type)).toBe("list<finding@1>");
    const failed = graphEdgeTransformsResultType(
      type("review-report@1"),
      [
        { op: "pick", fields: ["issues"] },
        { op: "limit", count: 1 },
      ],
      library,
    );
    expect(failed).toMatchObject({ ok: false, code: "requires_list", index: 1 });
  });
});

describe("adapters", () => {
  test("ids follow the grammar and every adapter turns its source example into a valid target", () => {
    for (const adapter of graphTypeAdapters()) {
      expect(adapter.id).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      const from = library.resolve(adapter.from);
      const to = library.resolve(adapter.to);
      expect(from.ok && to.ok).toBe(true);
      if (!from.ok || !to.ok || from.type.kind !== "named") continue;
      const output = applyGraphTypeAdapter(adapter, from.type.definition.example);
      const target = to.type.kind === "list" ? to.type.element : to.type;
      if (target.kind !== "named") throw new Error("adapters target named types");
      const values = to.type.kind === "list" ? (output as unknown[]) : [output];
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(validateGraphArtifactValue(target.definition, value)).toEqual([]);
      }
    }
  });

  test("list-producing adapters concatenate over a list", () => {
    const adapter = graphTypeAdapter("review-report-to-finding-list")!;
    const report = graphBuiltInType("review-report@1")!.example as Draft;
    expect(applyGraphTypeAdapter(adapter, [report, report], 1)).toEqual([
      ...report.issues,
      ...report.issues,
    ]);
    const markdown = graphTypeAdapter("ticket-to-markdown")!;
    const ticket = graphBuiltInType("ticket@1")!.example;
    expect((applyGraphTypeAdapter(markdown, [ticket], 1) as unknown[]).length).toBe(1);
  });

  test("the designer is offered adapters that make an edge fit", () => {
    expect(
      suggestGraphTypeAdapters(type("review-report@1"), type("list<finding@1>"), library).map(
        (adapter) => adapter.id,
      ),
    ).toEqual(["review-report-to-finding-list"]);
    expect(
      suggestGraphTypeAdapters(type("review-report@1"), type("markdown@1"), library).map(
        (adapter) => adapter.id,
      ),
    ).toEqual(["review-report-to-markdown"]);
    expect(suggestGraphTypeAdapters(type("workspace@1"), type("markdown@1"), library)).toEqual([]);
  });
});

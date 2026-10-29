import { describe, expect, test } from "bun:test";
import { graphTemplateExamples } from "./examples";
import { draftGraphSchemaFromExample } from "./schema-from-example";
import {
  GRAPH_SCHEMA_SUBSET_BOUNDS,
  validateGraphSchemaSubset,
  validateGraphSchemaValue,
} from "./schema-subset";
import { graphBuiltInTypes } from "./types";

// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

function draft(example: unknown) {
  const result = draftGraphSchemaFromExample(example);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function expectSelfConsistent(example: unknown): void {
  const { schema } = draft(example);
  const subset = validateGraphSchemaSubset(schema);
  expect(subset.ok ? [] : subset.errors).toEqual([]);
  expect(validateGraphSchemaValue(schema, example)).toEqual([]);
}

describe("schema from example", () => {
  test("drafts required fields, integers, nested objects and lists", () => {
    const { schema, notes } = draft({
      title: "Brief",
      score: 3,
      ratio: 0.5,
      done: false,
      owner: { name: "Ada", team: null },
      risks: ["scope", "time"],
      steps: [
        { order: 1, cost: 2 },
        { order: 2, cost: 2.5 },
      ],
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        title: { type: "string" },
        score: { type: "integer" },
        ratio: { type: "number" },
        done: { type: "boolean" },
        owner: {
          type: "object",
          properties: {
            name: { type: "string" },
            team: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["name", "team"],
          additionalProperties: false,
        },
        risks: { type: "array", items: { type: "string" } },
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: { order: { type: "integer" }, cost: { type: "number" } },
            required: ["order", "cost"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "score", "ratio", "done", "owner", "risks", "steps"],
      additionalProperties: false,
    });
    expect(notes).toEqual([
      { path: "$.owner.team", message: "Only null in the sample; guessed a nullable string" },
    ]);
  });

  test("a field null in some elements becomes nullable; mixed types become anyOf", () => {
    const { schema } = draft({
      rows: [
        { value: 1, label: null },
        { value: "two", label: "b" },
      ],
    });
    expect((schema as Draft).properties.rows.items.properties).toEqual({
      value: { anyOf: [{ type: "integer" }, { type: "string" }] },
      label: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
  });

  test("an empty list guesses string items and says so", () => {
    const { schema, notes } = draft({ tags: [] });
    expect((schema as Draft).properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(notes).toEqual([{ path: "$.tags[]", message: "No sample value; guessed string" }]);
  });

  test("every draft is inside the subset and accepts its own example", () => {
    const samples: unknown[] = [
      {},
      { a: [[1, 2], [3.5]] },
      { a: [null, { b: 1 }] },
      { a: [{ b: [] }, { b: ["x"] }] },
      { "with-hyphen": true, _under: "x" },
      ...graphBuiltInTypes().map((definition) => definition.example),
      ...graphTemplateExamples().flatMap((entry) =>
        (entry.template.types ?? []).flatMap((type) => (type.example ? [type.example] : [])),
      ),
    ];
    for (const sample of samples) expectSelfConsistent(sample);
  });

  test("rejects samples it cannot draft from", () => {
    const codes = (sample: unknown) => {
      const result = draftGraphSchemaFromExample(sample);
      return result.ok ? [] : result.errors.map((error) => [error.path, error.code]);
    };
    expect(codes("text")).toEqual([["$", "type"]]);
    expect(codes([{ a: 1 }])).toEqual([["$", "type"]]);
    expect(codes({ "has space": 1 })).toEqual([["$.has space", "pattern"]]);
    expect(codes({ rows: [{ a: 1 }, { b: 2 }] })).toEqual([["$.rows[]", "inconsistent_fields"]]);
    expect(codes({ n: Number.NaN })).toEqual([["$.n", "not_finite"]]);
    let deep: Draft = { leaf: 1 };
    for (let depth = 0; depth < GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth; depth++) {
      deep = { child: deep };
    }
    expect(codes(deep)[0]![1]).toBe("too_deep");
  });
});

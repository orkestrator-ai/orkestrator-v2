import { describe, expect, test } from "bun:test";
import { validateWorkflowJsonSchema } from "../workflow-json-schema";
import {
  GRAPH_SCHEMA_SOURCES_KEYWORD,
  GRAPH_SCHEMA_SUBSET_BOUNDS,
  GRAPH_SCHEMA_SUBSET_ERROR_CODES,
  type GraphSchemaSubsetErrorCode,
  graphProviderSchema,
  graphSchemaAtPath,
  validateGraphSchemaSubset,
  validateGraphSchemaValue,
} from "./schema-subset";

// Tests build schemas freely, including into shapes the types forbid.
// oxlint-disable-next-line typescript/no-explicit-any
type Draft = any;

/** A root object with the given properties, every one required. */
function root(properties: Record<string, Draft>): Draft {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

function errorsOf(schema: unknown): Array<[string, string]> {
  const result = validateGraphSchemaSubset(schema);
  return result.ok ? [] : result.errors.map((error) => [error.path, error.code]);
}

describe("schema subset: accepted", () => {
  test("objects, arrays, scalars, enums, bounds and nullable values", () => {
    const schema = root({
      title: { type: "string", description: "A title.", title: "Title" },
      count: { type: "integer", minimum: 0, maximum: 10 },
      ratio: { type: "number", minimum: 0.5 },
      done: { type: "boolean" },
      level: { type: "string", enum: ["low", "high"] },
      fixed: { type: "string", const: "v1" },
      notes: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional." },
      tags: { type: "array", items: { type: "string" } },
      nested: root({ value: { type: "number" } }),
      either: { anyOf: [{ type: "string" }, { type: "integer" }] },
      empty: root({}),
    });
    expect(errorsOf(schema)).toEqual([]);
  });

  test("records provenance fields, plain or nullable, with their paths", () => {
    const schema = root({
      cites: { type: "array", items: { type: "string" }, [GRAPH_SCHEMA_SOURCES_KEYWORD]: true },
      items: {
        type: "array",
        items: root({
          sourceIds: {
            anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
            [GRAPH_SCHEMA_SOURCES_KEYWORD]: true,
          },
        }),
      },
    });
    const result = validateGraphSchemaSubset(schema);
    expect(result.ok && result.value.sources).toEqual([
      { segments: ["cites"], path: "cites" },
      { segments: ["items", "[]", "sourceIds"], path: "items[].sourceIds" },
    ]);
  });
});

describe("schema subset: rejected constructs, with JSON paths", () => {
  const cases: Array<[string, Draft, Array<[string, string]>]> = [
    [
      "pattern",
      root({ id: { type: "string", pattern: "^a" } }),
      [["$.properties.id.pattern", "unsupported_keyword"]],
    ],
    [
      "$ref and $defs",
      { ...root({ id: { $ref: "#/$defs/id" } }), $defs: { id: { type: "string" } } },
      [
        ["$.$defs", "unsupported_keyword"],
        ["$.properties.id.$ref", "unsupported_keyword"],
        ["$.properties.id.type", "required"],
      ],
    ],
    [
      "oneOf",
      root({ id: { oneOf: [{ type: "string" }, { type: "null" }] } }),
      [
        ["$.properties.id.oneOf", "unsupported_keyword"],
        ["$.properties.id.type", "required"],
      ],
    ],
    [
      "allOf, not and format",
      root({ id: { type: "string", format: "uri", not: { const: "x" }, allOf: [] } }),
      [
        ["$.properties.id.format", "unsupported_keyword"],
        ["$.properties.id.not", "unsupported_keyword"],
        ["$.properties.id.allOf", "unsupported_keyword"],
      ],
    ],
    [
      "length and item bounds belong in budgets",
      root({
        name: { type: "string", minLength: 1, maxLength: 10 },
        list: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      }),
      [
        ["$.properties.name.minLength", "unsupported_keyword"],
        ["$.properties.name.maxLength", "unsupported_keyword"],
        ["$.properties.list.minItems", "unsupported_keyword"],
        ["$.properties.list.maxItems", "unsupported_keyword"],
      ],
    ],
    [
      "an unknown keyword",
      root({ id: { type: "string", widget: "text" } }),
      [["$.properties.id.widget", "unsupported_keyword"]],
    ],
    [
      "a type union",
      root({ id: { type: ["string", "null"] } }),
      [["$.properties.id.type", "type"]],
    ],
    ["an unknown type", root({ id: { type: "date" } }), [["$.properties.id.type", "enum"]]],
    [
      "an optional property",
      { ...root({ a: { type: "string" }, b: { type: "string" } }), required: ["a"] },
      [["$.properties.b", "not_required"]],
    ],
    [
      "required naming a missing property",
      { ...root({ a: { type: "string" } }), required: ["a", "b", "a"] },
      [
        ["$.required[1]", "unknown_property"],
        ["$.required[2]", "duplicate"],
      ],
    ],
    [
      "additional properties allowed",
      { ...root({ a: { type: "string" } }), additionalProperties: true },
      [["$.additionalProperties", "type"]],
    ],
    [
      "additional properties unstated",
      { type: "object", required: [], properties: {} },
      [["$.additionalProperties", "required"]],
    ],
    [
      "properties missing",
      { type: "object", required: [], additionalProperties: false },
      [["$.properties", "required"]],
    ],
    ["a non-object root", { type: "string" }, [["$.type", "not_applicable"]]],
    ["an anyOf root", { anyOf: [root({}), { type: "null" }] }, [["$.anyOf", "not_applicable"]]],
    [
      "nested anyOf",
      root({ a: { anyOf: [{ anyOf: [{ type: "string" }, { type: "null" }] }, { type: "null" }] } }),
      [["$.properties.a.anyOf[0].anyOf", "not_applicable"]],
    ],
    [
      "constraints beside anyOf",
      root({ a: { type: "string", anyOf: [{ type: "string" }, { type: "null" }] } }),
      [["$.properties.a.type", "not_applicable"]],
    ],
    [
      "a one-branch anyOf",
      root({ a: { anyOf: [{ type: "string" }] } }),
      [["$.properties.a.anyOf", "too_few"]],
    ],
    [
      "an array without items",
      root({ a: { type: "array" } }),
      [["$.properties.a.items", "required"]],
    ],
    [
      "tuple items",
      root({ a: { type: "array", items: [{ type: "string" }] } }),
      [["$.properties.a.items", "type"]],
    ],
    [
      "a keyword for another type",
      root({
        a: { type: "string", minimum: 1 },
        b: { type: "integer", items: { type: "string" } },
      }),
      [
        ["$.properties.a.minimum", "not_applicable"],
        ["$.properties.b.items", "not_applicable"],
      ],
    ],
    [
      "enum values of the wrong type, repeated, or empty",
      root({
        a: { type: "string", enum: ["x", 1, "x"] },
        b: { type: "integer", enum: [] },
        c: { type: "integer", enum: [1.5] },
      }),
      [
        ["$.properties.a.enum[1]", "type"],
        ["$.properties.a.enum[2]", "duplicate"],
        ["$.properties.b.enum", "empty"],
        ["$.properties.c.enum[0]", "type"],
      ],
    ],
    [
      "const with enum, or of the wrong type",
      root({
        a: { type: "string", const: "x", enum: ["x"] },
        b: { type: "boolean", const: "yes" },
      }),
      [
        ["$.properties.a.enum", "conflict"],
        ["$.properties.b.const", "type"],
      ],
    ],
    [
      "inverted or fractional integer bounds",
      root({ a: { type: "number", minimum: 2, maximum: 1 }, b: { type: "integer", maximum: 1.5 } }),
      [
        ["$.properties.a.minimum", "out_of_range"],
        ["$.properties.b.maximum", "not_integer"],
      ],
    ],
    [
      "property names outside the path grammar",
      root({ "has space": { type: "string" } }),
      [["$.properties.has space", "pattern"]],
    ],
    [
      "a description that is not text",
      root({ a: { type: "string", description: 3 } }),
      [["$.properties.a.description", "type"]],
    ],
    [
      "a provenance mark that is not true",
      root({
        a: { type: "array", items: { type: "string" }, [GRAPH_SCHEMA_SOURCES_KEYWORD]: "yes" },
      }),
      [[`$.properties.a.${GRAPH_SCHEMA_SOURCES_KEYWORD}`, "type"]],
    ],
    [
      "a provenance mark on a non-list",
      root({ a: { type: "string", [GRAPH_SCHEMA_SOURCES_KEYWORD]: true } }),
      [[`$.properties.a.${GRAPH_SCHEMA_SOURCES_KEYWORD}`, "not_applicable"]],
    ],
    [
      "a provenance mark on the root",
      { ...root({}), [GRAPH_SCHEMA_SOURCES_KEYWORD]: true },
      [[`$.${GRAPH_SCHEMA_SOURCES_KEYWORD}`, "not_applicable"]],
    ],
    ["a schema that is not an object", [], [["$", "type"]]],
  ];

  for (const [name, schema, expected] of cases) {
    test(name, () => {
      expect(errorsOf(schema)).toEqual(expected);
    });
  }

  test("objects nested too deep", () => {
    let schema: Draft = root({ leaf: { type: "string" } });
    for (let depth = 1; depth < GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth; depth++) {
      schema = root({ child: schema });
    }
    expect(errorsOf(schema)).toEqual([]);
    expect(errorsOf(root({ child: schema }))[0]![1]).toBe("too_deep");
  });

  test("too many properties per object and in total", () => {
    const wide: Record<string, Draft> = {};
    for (let index = 0; index <= GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject; index++) {
      wide[`p${index}`] = { type: "string" };
    }
    expect(errorsOf(root(wide))).toEqual([["$.properties", "too_many"]]);
    const many: Record<string, Draft> = {};
    for (let outer = 0; outer < 11; outer++) {
      const inner: Record<string, Draft> = {};
      for (let index = 0; index < 95; index++) inner[`p${index}`] = { type: "string" };
      many[`o${outer}`] = root(inner);
    }
    expect(errorsOf(root(many)).map(([, code]) => code)).toContain("too_many");
  });

  test("schemas over the byte bound", () => {
    const schema = root({ a: { type: "string", description: "x".repeat(4000) } });
    for (let index = 0; index < 20; index++) {
      schema.properties[`p${index}`] = { type: "string", description: "x".repeat(4000) };
      schema.required.push(`p${index}`);
    }
    expect(errorsOf(schema)).toEqual([["$", "too_large"]]);
  });
});

/**
 * One minimal schema per error code. `CODE_CASES` is typed by the code union,
 * so a new code without a case fails the typecheck; the last test fails at
 * run time when a case stops producing its code.
 */
describe("schema subset: one case per error code", () => {
  const nested = (depth: number): Draft => {
    let schema: Draft = { type: "string" };
    for (let index = 0; index < depth; index++) schema = root({ child: schema });
    return schema;
  };
  const CODE_CASES: Record<GraphSchemaSubsetErrorCode, () => Draft> = {
    type: () => root({ a: { type: ["string", "null"] } }),
    required: () => root({ a: { type: "array" } }),
    enum: () => root({ a: { type: "date" } }),
    unsupported_keyword: () => root({ a: { type: "string", pattern: "^a" } }),
    not_applicable: () => ({ type: "string" }),
    not_required: () => ({ ...root({ a: { type: "string" } }), required: [] }),
    unknown_property: () => ({ ...root({}), required: ["a"] }),
    pattern: () => root({ "a b": { type: "string" } }),
    duplicate: () => root({ a: { type: "string", enum: ["x", "x"] } }),
    conflict: () => root({ a: { type: "string", const: "x", enum: ["x"] } }),
    empty: () => root({ a: { type: "string", enum: [] } }),
    too_few: () => root({ a: { anyOf: [{ type: "string" }] } }),
    too_many: () =>
      root({
        a: {
          type: "integer",
          enum: Array.from({ length: GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumValues + 1 }, (_, i) => i),
        },
      }),
    too_large: () => root({ a: { type: "string", title: "x".repeat(201) } }),
    too_deep: () => nested(GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth + 1),
    not_integer: () => root({ a: { type: "integer", minimum: 0.5 } }),
    out_of_range: () => root({ a: { type: "number", minimum: 2, maximum: 1 } }),
    // A BigInt passes the depth walk but cannot be serialized.
    not_json: () => ({ ...root({}), description: 1n }),
  };

  for (const [code, schema] of Object.entries(CODE_CASES)) {
    test(code, () => {
      expect(errorsOf(schema()).map(([, found]) => found)).toContain(code);
    });
  }

  test("every code in the list has a case, and every case produces its code", () => {
    expect(Object.keys(CODE_CASES).sort()).toEqual([...GRAPH_SCHEMA_SUBSET_ERROR_CODES].sort());
    const missing = GRAPH_SCHEMA_SUBSET_ERROR_CODES.filter(
      (code) => !errorsOf(CODE_CASES[code]()).some(([, found]) => found === code),
    );
    expect(missing).toEqual([]);
  });
});

describe("provider schema", () => {
  test("strips the provenance mark and nothing else", () => {
    const schema = root({
      ids: { type: "array", items: { type: "string" }, [GRAPH_SCHEMA_SOURCES_KEYWORD]: true },
      // A property may be named like the annotation; it stays.
      [GRAPH_SCHEMA_SOURCES_KEYWORD]: { type: "string", description: "kept" },
    });
    const provider = graphProviderSchema(schema);
    expect(provider.properties).toEqual({
      ids: { type: "array", items: { type: "string" } },
      [GRAPH_SCHEMA_SOURCES_KEYWORD]: { type: "string", description: "kept" },
    });
    expect(JSON.stringify(provider)).not.toContain(`"${GRAPH_SCHEMA_SOURCES_KEYWORD}":true`);
    // The input is untouched.
    expect(schema.properties.ids[GRAPH_SCHEMA_SOURCES_KEYWORD]).toBe(true);
  });
});

describe("value validation", () => {
  const schema = root({
    name: { type: "string" },
    note: { anyOf: [{ type: "string" }, { type: "null" }] },
    count: { type: "integer", minimum: 0 },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
  });

  test("is the backend's workflow result validator", () => {
    for (const value of [
      { name: "x", note: null, count: 1, tags: ["a"] },
      { name: "x", note: 3, count: -1, tags: ["c"], extra: true },
      { name: "x" },
      "nope",
    ]) {
      expect(validateGraphSchemaValue(schema, value)).toEqual(
        validateWorkflowJsonSchema(schema, value),
      );
    }
    expect(validateGraphSchemaValue(schema, { name: "x", note: null, count: 1, tags: [] })).toEqual(
      [],
    );
    expect(
      validateGraphSchemaValue(schema, { name: "x", note: null, count: 1.5, tags: ["c"] }).map(
        (issue) => [issue.path, issue.code],
      ),
    ).toEqual([
      ["$.count", "invalid_type"],
      ["$.tags[0]", "invalid_enum"],
    ]);
  });
});

describe("field paths", () => {
  const schema = root({
    report: { anyOf: [root({ verdict: root({ ready: { type: "string" } }) }), { type: "null" }] },
    issues: { type: "array", items: root({ title: { type: "string" } }) },
  });

  test("follow objects and nullable wrappers, not arrays", () => {
    expect(graphSchemaAtPath(schema, "report.verdict.ready")).toEqual({
      schema: { type: "string" },
      nullable: true,
    });
    expect(graphSchemaAtPath(schema, "issues")?.schema.type).toBe("array");
    expect(graphSchemaAtPath(schema, "issues.title")).toBeNull();
    expect(graphSchemaAtPath(schema, "report.missing")).toBeNull();
    expect(graphSchemaAtPath(schema, "bad path")).toBeNull();
  });
});

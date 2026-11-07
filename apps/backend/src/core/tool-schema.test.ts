import { describe as group, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { Schema } from "effect";
import { toDesignFailure } from "./design/errors.js";
import { callToolInProcess } from "./mcp-in-process.js";
import {
  decodeResult,
  decodeSync,
  describe,
  int,
  jsonSchemaField,
  list,
  looseObject,
  num,
  record,
  refine,
  schemaErrorIssues,
  str,
  strictObject,
  toolInput,
  toolJsonSchema,
  withDefault,
} from "./tool-schema.js";

function issues(schema: Schema.Top, input: unknown) {
  const result = decodeResult(schema, input);
  return result.success ? [] : schemaErrorIssues(result.error);
}

group("str", () => {
  test("checks the trimmed length, decodes to the trimmed value and publishes the bounds", () => {
    const schema = str({ trim: true, min: 1, max: 5 });
    expect(decodeSync(schema, "  abc  ")).toBe("abc");
    expect(decodeResult(schema, "   ").success).toBe(false);
    // Zod's `.trim().max(5)` accepted padding around five characters.
    expect(decodeSync(schema, "  abcde  ")).toBe("abcde");
    expect(decodeResult(schema, "abcdef").success).toBe(false);
    expect(toolJsonSchema(strictObject({ a: schema })).properties).toEqual({
      a: { type: "string", minLength: 1, maxLength: 5 },
    });
  });

  test("patterns publish their source and fail with their own message", () => {
    const schema = str({ trim: true, lowercase: true, pattern: /^[0-9a-f]{4}$/i, message: "hex" });
    expect(decodeSync(schema, " ABCD ")).toBe("abcd");
    expect(issues(schema, "zz")).toEqual([{ path: [], message: "hex" }]);
    expect(toolJsonSchema(strictObject({ a: schema })).properties).toEqual({
      a: { type: "string", pattern: "^[0-9a-f]{4}$" },
    });
  });

  test("uuid publishes a format", () => {
    const schema = str({ uuid: true });
    expect(decodeResult(schema, "123e4567-e89b-12d3-a456-426614174000").success).toBe(true);
    expect(decodeResult(schema, "nope").success).toBe(false);
    expect(toolJsonSchema(strictObject({ a: schema })).properties).toMatchObject({
      a: { type: "string", format: "uuid" },
    });
  });
});

group("numbers and lists", () => {
  test("int and num bound their values; maxMessage replaces the max failure", () => {
    expect(decodeResult(int({ min: 1 }), 1.5).success).toBe(false);
    expect(decodeResult(num(), Number.POSITIVE_INFINITY).success).toBe(false);
    expect(decodeResult(num({ gt: 0 }), 0).success).toBe(false);
    expect(issues(int({ max: 3, maxMessage: "at most 3" }), 4)).toEqual([
      { path: [], message: "at most 3" },
    ]);
    expect(issues(list(Schema.String, { max: 1, maxMessage: "one" }), ["a", "b"])).toEqual([
      { path: [], message: "one" },
    ]);
    expect(toolJsonSchema(strictObject({ n: int({ min: 0, max: 9 }) })).properties).toEqual({
      n: { type: "integer", minimum: 0, maximum: 9 },
    });
  });
});

group("objects", () => {
  const schema = strictObject({
    strict: Schema.optionalKey(strictObject({ a: Schema.String })),
    open: Schema.optionalKey(Schema.Struct({ a: Schema.String })),
    loose: Schema.optionalKey(looseObject({ a: Schema.String })),
    union: Schema.optionalKey(
      Schema.Union([
        strictObject({ kind: Schema.Literal("a") }),
        Schema.Struct({ kind: Schema.Literal("b") }),
      ]),
    ),
  });

  test("a strict object refuses unknown keys, an open one drops them, a loose one keeps them", () => {
    expect(issues(schema, { extra: 1 })).toEqual([
      { path: ["extra"], message: "Expected no excess property" },
    ]);
    expect(issues(schema, { strict: { a: "x", b: 1 } })).toEqual([
      { path: ["strict", "b"], message: "Expected no excess property" },
    ]);
    expect(decodeSync(schema, { open: { a: "x", b: 1 } })).toEqual({ open: { a: "x" } });
    expect(decodeSync(schema, { loose: { a: "x", b: 1 } })).toEqual({ loose: { a: "x", b: 1 } });
  });

  test("a union takes a member that forgives the unknown keys", () => {
    expect(decodeSync(schema, { union: { kind: "b", extra: 1 } })).toEqual({
      union: { kind: "b" },
    });
    expect(decodeResult(schema, { union: { kind: "a", extra: 1 } }).success).toBe(false);
  });

  test("the JSON Schema closes strict objects only", () => {
    expect(toolJsonSchema(schema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        strict: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: false,
        },
        open: { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        loose: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
          additionalProperties: {},
        },
        union: {
          anyOf: [
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["a"] } },
              required: ["kind"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { kind: { type: "string", enum: ["b"] } },
              required: ["kind"],
            },
          ],
        },
      },
      additionalProperties: false,
    });
  });

  test("a record refuses a key its key schema refuses and publishes both schemas", () => {
    const styles = record(str({ min: 1, max: 4 }), Schema.NullOr(Schema.String));
    expect(decodeSync(styles, { a: null, b: "x" })).toEqual({ a: null, b: "x" });
    expect(decodeResult(styles, { "": "x" }).success).toBe(false);
    expect(toolJsonSchema(strictObject({ styles })).properties).toEqual({
      styles: {
        type: "object",
        propertyNames: { type: "string", minLength: 1, maxLength: 4 },
        additionalProperties: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });

  test("an empty strict object is published as a closed object", () => {
    expect(toolJsonSchema(strictObject({}))).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
    });
  });
});

group("defaults, descriptions and refinements", () => {
  test("withDefault fills a missing key and publishes the default", () => {
    const schema = strictObject({ limit: withDefault(int({ min: 1, max: 9 }), 5) });
    expect(decodeSync(schema, {})).toEqual({ limit: 5 });
    expect(toolJsonSchema(schema)).toMatchObject({
      properties: { limit: { type: "integer", default: 5 } },
    });
    expect(toolJsonSchema(schema)).not.toHaveProperty("required");
  });

  test("descriptions land on the property for every kind of field", () => {
    const schema = strictObject({
      trimmed: describe(str({ trim: true, min: 1 }), "trimmed"),
      optional: Schema.optionalKey(describe(Schema.String, "optional")),
      unknown: Schema.optionalKey(describe(Schema.Unknown, "unknown")),
      refined: describe(
        strictObject({ a: Schema.optionalKey(Schema.String) }).check(
          refine((value: { a?: string }) => value.a !== undefined, "Provide a"),
        ),
        "refined",
      ),
      defaulted: describe(withDefault(Schema.Boolean, false), "defaulted"),
      literal: describe(Schema.Literals(["x", "y"]), "literal"),
    });
    const properties = toolJsonSchema(schema).properties as Record<
      string,
      { description?: string }
    >;
    expect(
      Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, v.description])),
    ).toEqual({
      trimmed: "trimmed",
      optional: "optional",
      unknown: "unknown",
      refined: "refined",
      defaulted: "defaulted",
      literal: "literal",
    });
    expect(issues(schema, { trimmed: "x", refined: {}, literal: "x" })).toEqual([
      { path: ["refined"], message: "Provide a" },
    ]);
  });
});

group("jsonSchemaField", () => {
  test("is published verbatim and validated by it", () => {
    const json = {
      type: "object",
      properties: { q: { type: "integer" } },
      required: ["q"],
      additionalProperties: false,
    };
    const schema = strictObject({ result: jsonSchemaField(json) });
    expect(toolJsonSchema(schema).properties).toEqual({ result: json });
    expect(decodeSync(schema, { result: { q: 1 } })).toEqual({ result: { q: 1 } });
    expect(decodeResult(schema, { result: { q: "1" } }).success).toBe(false);
  });
});

group("toolInput", () => {
  const input = strictObject({
    id: str({ trim: true, min: 1, max: 10 }),
    limit: withDefault(int({ min: 1, max: 50 }), 20),
  });
  const factory = () => {
    const server = new McpServer({ name: "tool-schema-test", version: "1.0.0" });
    server.registerTool("echo", { inputSchema: toolInput(input) }, async (args) => {
      const id: string = args.id;
      const limit: number = args.limit;
      return { content: [{ type: "text", text: JSON.stringify({ id, limit }) }] };
    });
    return server;
  };

  test("the handler receives the decoded value", async () => {
    const result = await callToolInProcess(factory, "echo", { id: "  a  " });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ id: "a", limit: 20 });
  });

  test("a refused call names the field", async () => {
    const result = await callToolInProcess(factory, "echo", { id: "a", other: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "Invalid arguments for tool echo: other: Expected no excess property",
    );
  });

  test("the Standard Schema publishes the same JSON Schema for input and output", () => {
    const standard = toolInput(input)["~standard"];
    expect(standard.jsonSchema.input({ target: "draft-2020-12" })).toEqual(toolJsonSchema(input));
    expect(standard.validate({ id: "x" })).toEqual({ value: { id: "x", limit: 20 } });
  });
});

group("design failures", () => {
  test("a schema failure is invalid-input naming the fields", () => {
    const schema = strictObject({ frame: strictObject({ name: str({ min: 1 }) }) });
    let thrown: unknown;
    try {
      decodeSync(schema, { frame: { name: "" } });
    } catch (error) {
      thrown = error;
    }
    expect(Schema.isSchemaError(thrown)).toBe(true);
    expect(toDesignFailure(thrown)).toEqual({
      code: "invalid-input",
      message: "Invalid design input: frame.name",
      retry: "never",
      details: { fields: ["frame.name"] },
    });
  });
});

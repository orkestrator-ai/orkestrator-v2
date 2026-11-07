/**
 * Pins how Effect Schema's JSON Schema export behaves, because the contract
 * manifests (plan item 1006) digest it. A change in these expectations after
 * an `effect` upgrade means every manifest digest changes too.
 */
import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Sorts object keys and the set-valued `required` arrays, so a digest does not
 * depend on the order fields were declared in. Other arrays (`anyOf`, `enum`,
 * tuple `prefixItems`) keep their order: union order affects decoding.
 */
function canonical(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const sorted: { [key: string]: Json } = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key] as Json;
    sorted[key] = key === "required" && Array.isArray(entry) ? [...entry].sort() : canonical(entry);
  }
  return sorted;
}

function exported(schema: Schema.Top, options?: Schema.ToJsonSchemaOptions): string {
  return JSON.stringify(Schema.toJsonSchemaDocument(schema, options));
}

function canonicalExport(schema: Schema.Top): string {
  return JSON.stringify(canonical(Schema.toJsonSchemaDocument(schema) as unknown as Json));
}

function property(schema: { [key: string]: unknown }, key: string): unknown {
  return (schema.properties as Record<string, unknown> | undefined)?.[key];
}

const id = () => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

function deliverMailArgs() {
  return Schema.Struct({
    to: Schema.Struct({ nodeId: id(), mailbox: Schema.String.check(Schema.isMaxLength(256)) }),
    subject: Schema.String.check(Schema.isMaxLength(200)),
    steer: Schema.optionalKey(Schema.Boolean),
    priority: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9 })),
    weight: Schema.Finite,
    status: Schema.Literals(["queued", "delivered"]),
    cursor: Schema.NullOr(Schema.String),
  });
}

describe("Effect Schema JSON Schema export", () => {
  it("emits byte-identical JSON for the same schema and for an identically built one", () => {
    const schema = deliverMailArgs();
    const first = exported(schema);
    expect(exported(schema)).toBe(first);
    expect(exported(deliverMailArgs())).toBe(first);
  });

  it("emits the pinned draft 2020-12 document", () => {
    expect(exported(deliverMailArgs())).toBe(
      JSON.stringify({
        dialect: "draft-2020-12",
        schema: {
          type: "object",
          properties: {
            to: {
              type: "object",
              properties: {
                nodeId: { type: "string", minLength: 1, maxLength: 128 },
                mailbox: { type: "string", maxLength: 256 },
              },
              required: ["nodeId", "mailbox"],
              additionalProperties: true,
            },
            subject: { type: "string", maxLength: 200 },
            steer: { type: "boolean" },
            priority: { type: "integer", minimum: 0, maximum: 9 },
            weight: { type: "number" },
            status: { type: "string", enum: ["queued", "delivered"] },
            cursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
          required: ["to", "subject", "priority", "weight", "status", "cursor"],
          additionalProperties: true,
        },
        definitions: {},
      }),
    );
  });

  it("follows declaration order, which canonical key sorting removes", () => {
    const forward = Schema.Struct({
      a: id(),
      b: Schema.optionalKey(Schema.Boolean),
      c: Schema.Finite,
    });
    const reversed = Schema.Struct({
      c: Schema.Finite,
      b: Schema.optionalKey(Schema.Boolean),
      a: id(),
    });
    expect(exported(forward)).not.toBe(exported(reversed));
    expect(canonicalExport(forward)).toBe(canonicalExport(reversed));
  });

  it("shares one definition per reused identified schema, and suffixes distinct instances", () => {
    const Environment = Schema.Struct({ id: id() }).annotate({ identifier: "Environment" });
    const reused = Schema.toJsonSchemaDocument(
      Schema.Struct({ one: Environment, many: Schema.Array(Environment) }),
    );
    expect(Object.keys(reused.definitions)).toEqual(["Environment"]);
    expect(property(reused.schema, "one")).toEqual({ $ref: "#/$defs/Environment" });

    const copy = Schema.Struct({ id: id() }).annotate({ identifier: "Environment" });
    const duplicated = Schema.toJsonSchemaDocument(
      Schema.Struct({ one: Environment, other: copy }),
    );
    expect(Object.keys(duplicated.definitions)).toEqual(["Environment", "Environment_1"]);
  });

  it("keeps the lowering rules contract schemas must follow", () => {
    const props = (schema: Schema.Top) => Schema.toJsonSchemaDocument(schema).schema;
    // `Schema.Number` admits non-finite values, encoded as strings in JSON.
    expect(props(Schema.Number)).toEqual({
      anyOf: [{ type: "number" }, { type: "string", enum: ["Infinity", "-Infinity", "NaN"] }],
    });
    expect(props(Schema.Finite)).toEqual({ type: "number" });
    // `Schema.optional` lets JSON `null` stand for `undefined`; `optionalKey` does not.
    expect(property(props(Schema.Struct({ a: Schema.optional(Schema.String) })), "a")).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
    expect(property(props(Schema.Struct({ a: Schema.optionalKey(Schema.String) })), "a")).toEqual({
      type: "string",
    });
    // A pattern is exported only with the `u` flag.
    expect(props(Schema.String.check(Schema.isPattern(/^[a-z]+$/)))).toEqual({ type: "string" });
    expect(props(Schema.String.check(Schema.isPattern(/^[a-z]+$/u)))).toEqual({
      type: "string",
      pattern: "^[a-z]+$",
    });
    // Strict objects are an export option, matching the decoder option.
    expect(
      Schema.toJsonSchemaDocument(Schema.Struct({ a: Schema.String }), {
        onExcessProperty: "error",
      }).schema.additionalProperties,
    ).toBe(false);
  });
});

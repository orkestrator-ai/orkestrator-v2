import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { canonicalJsonSchema } from "./json-schema.js";
import {
  modelRecord,
  mutableArray,
  opaqueRecord,
  OpenObject,
  openRecord,
  ownedObject,
  variantRecord,
} from "./model-schema.js";

interface Model {
  id: string;
  revision: number;
  detail?: { nested: boolean };
  label: string;
}

const ModelSchema = modelRecord<Model>()({
  id: Schema.String,
  revision: Schema.Finite,
});

describe("modelRecord", () => {
  it("validates the declared fields and passes every other key through", () => {
    const value = { id: "a", revision: 2, label: "x", detail: { nested: true } };
    expect(Schema.decodeUnknownSync(ModelSchema)(value, { onExcessProperty: "ignore" })).toEqual(
      value,
    );
    expect(Schema.encodeUnknownSync(ModelSchema)(value, { onExcessProperty: "ignore" })).toEqual(
      value,
    );
  });

  it("refuses a record whose declared field is wrong or missing", () => {
    expect(() => Schema.decodeUnknownSync(ModelSchema)({ id: 1, revision: 2 })).toThrow();
    expect(() => Schema.decodeUnknownSync(ModelSchema)({ revision: 2 })).toThrow();
    expect(() => Schema.decodeUnknownSync(ModelSchema)([])).toThrow();
  });

  it("exports the declared fields and an open rest in its JSON Schema", () => {
    const schema = (
      JSON.parse(canonicalJsonSchema(ModelSchema)) as {
        schema: { properties: Record<string, unknown>; required: string[]; allOf: unknown[] };
      }
    ).schema;
    expect(Object.keys(schema.properties).sort()).toEqual(["id", "revision"]);
    expect(schema.required).toEqual(["id", "revision"]);
    expect(schema.allOf).toHaveLength(1);
  });
});

describe("opaqueRecord", () => {
  it("passes any object through unchanged and refuses a non-object", () => {
    const schema = opaqueRecord<Model>();
    const value = { anything: [1, 2], id: "x" };
    expect(Schema.decodeUnknownSync(schema)(value) as unknown).toEqual(value);
    expect(() => Schema.decodeUnknownSync(schema)("text")).toThrow();
  });
});

describe("openRecord", () => {
  it("checks the declared fields and keeps every other key", () => {
    const schema = openRecord({ id: Schema.String });
    const value = { id: "a", deep: { x: [1] } };
    expect(Schema.decodeUnknownSync(schema)(value) as unknown).toEqual(value);
    expect(() => Schema.decodeUnknownSync(schema)({ id: 1 })).toThrow();
  });

  it("builds the same JSON Schema as modelRecord for the same fields", () => {
    expect(canonicalJsonSchema(openRecord({ id: Schema.String, revision: Schema.Finite }))).toBe(
      canonicalJsonSchema(ModelSchema),
    );
    expect(canonicalJsonSchema(OpenObject)).toBe(canonicalJsonSchema(openRecord({})));
  });
});

type Variant = { kind: "a"; left: string } | { kind: "b"; right: number };

describe("variantRecord", () => {
  it("checks a field of any variant when present", () => {
    const schema = variantRecord<Variant>()({
      kind: Schema.Literals(["a", "b"]),
      right: Schema.optional(Schema.Finite),
    });
    expect(Schema.decodeUnknownSync(schema)({ kind: "a", left: "x" })).toEqual({
      kind: "a",
      left: "x",
    });
    expect(() => Schema.decodeUnknownSync(schema)({ kind: "b", right: "x" })).toThrow();
  });
});

describe("ownedObject and mutableArray", () => {
  it("accept any object and a list of items", () => {
    expect(Schema.decodeUnknownSync(ownedObject<Model>())({ any: 1 }) as unknown).toEqual({
      any: 1,
    });
    expect(() => Schema.decodeUnknownSync(ownedObject<Model>())(1)).toThrow();
    const list: string[] = Schema.decodeUnknownSync(mutableArray(Schema.String))(["a"]);
    expect(list).toEqual(["a"]);
  });
});

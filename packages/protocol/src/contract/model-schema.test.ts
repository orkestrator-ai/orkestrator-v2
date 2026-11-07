import { describe, expect, it } from "bun:test";
import * as Schema from "effect/Schema";
import { canonicalJsonSchema } from "./json-schema.js";
import { modelRecord, opaqueRecord } from "./model-schema.js";

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

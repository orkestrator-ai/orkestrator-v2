/**
 * Schemas for model records the protocol describes only in part (plan item
 * 7004; the models converge on protocol schemas in 7010).
 *
 * A domain's command results carry records whose full shape is a hand-written
 * interface today (`WebAnnotation`, `PreviewServiceSnapshot`, a design
 * snapshot…). A plain `Schema.Struct` drops every key it does not declare when
 * a client decodes a result (`decodeCommandResult` is tolerant), so a partial
 * struct would silently lose fields the renderer reads. {@link modelRecord}
 * instead validates the declared fields and passes every other key through
 * unchanged, in both directions: a struct with a string-keyed rest of unknown
 * values (`Schema.StructWithRest`). Its TypeScript type is the model interface
 * the caller names, so typed results replace `invoke<T>` casts without a
 * second, diverging type.
 *
 * Rules for the declared fields: declare what identifies the record and what
 * callers branch on (ids, revisions, states, kinds); they are validated in
 * development and tests on every result, so a declared field that is wrong
 * fails a test. The JSON Schema export names them (`required`, `properties`)
 * and an `allOf` with `additionalProperties: {}`, so the manifest digest
 * changes when they do.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";

/** A JSON-shaped codec whose decoded and encoded type is the model `T`. */
export type ModelSchema<T> = Schema.Codec<T, T, never, never>;

/** Fields that name only keys of `T` (a misspelt field is a type error). */
export type ModelFields<T> = { readonly [K in keyof T & string]?: Schema.Top };

/**
 * A record of model `T`: `fields` are validated, every other key passes
 * through. Call it as `modelRecord<WebAnnotation>()({ annotationId: Schema.String, … })`
 * (the first call fixes `T`, the second infers the fields).
 */
export function modelRecord<T extends object>() {
  return <const F extends ModelFields<T>>(
    fields: F & { readonly [K in Exclude<keyof F, keyof T>]: never },
  ): ModelSchema<T> =>
    Schema.StructWithRest(Schema.Struct(fields as Schema.Struct.Fields), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]) as unknown as ModelSchema<T>;
}

/** Any JSON object, passed through unchanged, typed as `T` (no field is declared). */
export function opaqueRecord<T extends object>(): ModelSchema<T> {
  return Schema.Record(Schema.String, Schema.Unknown) as unknown as ModelSchema<T>;
}

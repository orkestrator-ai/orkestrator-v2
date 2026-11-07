/**
 * The protocol's schema helpers for model records (plan items 7004 and 7010):
 * the one module every domain's model and result schemas build open records,
 * typed objects and mutable lists with. Before 7010 each domain item carried
 * its own copy (`openStruct` in 7001 and four later domains, `openRecord` in
 * 7005 and 7006, `variantRecord` in 7006, `ownedObject`/`mutableArray` in
 * 7003, `listOf`/`asModel` in 7007); the copies were the same constructions,
 * so moving them here changed no schema's JSON Schema export (no digest in
 * the manifest moved).
 *
 * Why open records: a client decodes a result tolerantly (`decodeCommandResult`
 * ignores unknown keys), and a plain `Schema.Struct` drops every key it does
 * not declare, so a struct that declares only part of a record would silently
 * lose the fields a reader uses, and a settings record written back whole
 * would lose a newer backend's settings. An open record is a struct with a
 * string-keyed rest of unknown values (`Schema.StructWithRest`): the declared
 * fields are checked (in both directions) and every other key passes through
 * unchanged. Its JSON Schema export names the declared fields (`required`,
 * `properties`) and an `allOf` with `additionalProperties: {}`, so the
 * manifest digest changes when they do.
 *
 * The variants, by where the static type comes from:
 *
 * | Helper                       | Run time                        | Static type                              | Use for                                                    |
 * | ---------------------------- | ------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
 * | {@link openRecord}(fields)   | open record of `fields`         | the declared struct (no index signature) | a record whose schema is its definition (models, settings) |
 * | {@link modelRecord}`<T>()`   | open record of `fields`         | the interface `T`; fields name keys of T | a record whose definition is still a protocol interface    |
 * | {@link variantRecord}`<T>()` | open record of `fields`         | the union `T`; fields name any variant's | a discriminated union of records                           |
 * | {@link opaqueRecord}`<T>()`  | any JSON object, nothing checked | `T`                                      | a record nothing routes on                                 |
 * | {@link OpenObject}           | `openRecord({})`                | `{}`                                     | any object, every key kept                                 |
 * | {@link ownedObject}`<T>()`   | any object (`ObjectKeyword`)    | `T`                                      | a value another module owns and has no schema for yet      |
 * | {@link asModel}`<T>(schema)` | `schema` unchanged              | `T`                                      | a union or list the protocol declares as an interface      |
 * | {@link mutableArray}(item)   | `Schema.Array(item)`, mutable   | `T[]`                                    | every list, so inferred types match the models' `T[]`      |
 *
 * Rules for the declared fields: declare what identifies a record and what
 * callers branch on (ids, revisions, states, kinds); results are validated in
 * development and tests, so a declared field that is wrong fails a test.
 * `openRecord`'s type deliberately has no index signature
 * (`StructWithRest`'s own type has one, which interfaces do not satisfy), so a
 * backend interface stays assignable to it.
 *
 * Browser-safe.
 */
import * as Schema from "effect/Schema";

/** A JSON-shaped codec whose decoded and encoded type is the model `T`. */
export type ModelSchema<T> = Schema.Codec<T, T, never, never>;

/** Fields that name only keys of `T` (a misspelt field is a type error). */
export type ModelFields<T> = { readonly [K in keyof T & string]?: Schema.Top };

type KeysOfUnion<T> = T extends unknown ? keyof T & string : never;

/** `fields` checked, every other key kept: the run-time shape of every open record. */
function openShape(fields: Schema.Struct.Fields): Schema.Top {
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
}

/**
 * A record whose listed fields are checked and typed while every other key
 * passes through a decode unchanged, typed as the declared struct.
 */
export function openRecord<const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Codec<Schema.Struct<Fields>["Type"], Schema.Struct<Fields>["Encoded"]> {
  return openShape(fields) as unknown as Schema.Codec<
    Schema.Struct<Fields>["Type"],
    Schema.Struct<Fields>["Encoded"]
  >;
}

/** Any JSON object, every key kept (`openRecord({})`). */
export const OpenObject = openRecord({});

/**
 * A record of model `T`: `fields` are validated, every other key passes
 * through. Call it as `modelRecord<WebAnnotation>()({ annotationId: Schema.String, … })`
 * (the first call fixes `T`, the second infers the fields).
 */
export function modelRecord<T extends object>() {
  return <const F extends ModelFields<T>>(
    fields: F & { readonly [K in Exclude<keyof F, keyof T>]: never },
  ): ModelSchema<T> => openShape(fields as Schema.Struct.Fields) as unknown as ModelSchema<T>;
}

/**
 * A record of one of the variants of `T` (a discriminated union): `fields`
 * may name a key of any variant and are validated when present; every other
 * key passes through. Like {@link modelRecord}, but for unions, whose `keyof`
 * is only the keys every variant shares. Declare a key only some variants
 * carry as optional.
 */
export function variantRecord<T extends object>() {
  return <const F extends { readonly [K in KeysOfUnion<T>]?: Schema.Top }>(
    fields: F & { readonly [K in Exclude<keyof F, KeysOfUnion<T>>]: never },
  ): ModelSchema<T> => openShape(fields as Schema.Struct.Fields) as unknown as ModelSchema<T>;
}

/** Any JSON object, passed through unchanged, typed as `T` (no field is declared). */
export function opaqueRecord<T extends object>(): ModelSchema<T> {
  return Schema.Record(Schema.String, Schema.Unknown) as unknown as ModelSchema<T>;
}

/**
 * An object owned by another module's model, decoded as an object and typed
 * as `T`. Used only where the owner has no schema yet; its schema replaces it.
 */
export function ownedObject<T extends object>(): Schema.Codec<T> {
  return Schema.ObjectKeyword as unknown as Schema.Codec<T>;
}

/**
 * `schema`, typed as the protocol's own type `T` (as {@link modelRecord} types
 * a record): unions and lists the protocol declares with mutable arrays and
 * `?:` fields, so a decoded result is the interface callers already use.
 */
export function asModel<T>(schema: Schema.Top): ModelSchema<T> {
  return schema as unknown as ModelSchema<T>;
}

/** A mutable array of `item`, so the inferred type matches the models' `T[]`. */
export function mutableArray<S extends Schema.Top>(item: S) {
  return Schema.mutable(Schema.Array(item));
}

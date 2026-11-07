/**
 * The canonical JSON Schema form of a contract schema, which the contract
 * manifest digests (plan items 1001 and 1006, docs/reports/unified-federation.md
 * §11.3). The manifest generator, release snapshots and the contract CI job
 * must all digest the same text, so the form lives here.
 *
 * Browser-safe: no Node or Bun imports (hashing is the caller's).
 */
import * as Schema from "effect/Schema";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/**
 * Sorts object keys and the set-valued `required` arrays, so the result does
 * not depend on the order fields were declared in. Every other array
 * (`anyOf`, `enum`, tuple `prefixItems`) keeps its order, because union order
 * affects decoding.
 */
export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value === null || typeof value !== "object") return value;
  const record = value as { readonly [key: string]: Json };
  const sorted: { [key: string]: unknown } = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    sorted[key] =
      key === "required" && Array.isArray(entry) && entry.every((item) => typeof item === "string")
        ? [...(entry as readonly string[])].sort()
        : canonicalJson(entry);
  }
  return sorted;
}

/**
 * The canonical JSON text of `Schema.toJsonSchemaDocument(schema)`: dialect,
 * root schema and definitions together, keys sorted as in
 * {@link canonicalJson}, no whitespace.
 */
export function canonicalJsonSchema(schema: Schema.Top): string {
  return JSON.stringify(canonicalJson(Schema.toJsonSchemaDocument(schema)));
}

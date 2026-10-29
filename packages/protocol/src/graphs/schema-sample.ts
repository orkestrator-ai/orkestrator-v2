/**
 * A deterministic value generated from a JSON schema of the graph subset
 * (item 102's `schema-subset.ts`), for mock runs (item 213, report §7.5) and
 * the designer's previews: the same schema and options always give the same
 * value, so a mock run is reproducible and the designer shows exactly what a
 * mock agent will answer.
 *
 * The rules, keyword by keyword:
 *
 * - `const` wins, then `enum` (the value at `variant`, wrapping).
 * - `anyOf`: the first branch that is not `{ "type": "null" }` (optional
 *   values are filled, so more of the graph is exercised); null only when
 *   every branch is null.
 * - `object`: every property in `properties`, in order (the subset requires
 *   them all).
 * - `array`: `arrayItems` elements (default 1) generated from `items`; a
 *   provenance list (`x-orkestrator-sources`) is empty, since there is no
 *   source to cite.
 * - `string`: a short text chosen by the property's name, so domain checks
 *   that only look at a format pass: commit fields (`headRef`, `sha`, …) get
 *   a 40-character hex SHA derived from the path, URLs an `https://` URL,
 *   branches a branch name, paths a relative path, ids `<name>-<n>`; other
 *   strings read `Sample <name>`.
 * - `number`/`integer`: `minimum` (rounded up for integers), else 1, clamped
 *   to `maximum`.
 * - `boolean`: true (the "happy path"; pin a value to exercise the other).
 *
 * Bounded: nesting past `maxDepth` yields null, arrays hold at most 8
 * generated elements. Schemas outside the subset are handled leniently
 * (a list of types takes the first non-null one; unknown keywords are
 * ignored), so built-in schemas generate too. Browser-safe.
 */
import type { GraphJsonSchema } from "./artifact-type-def.js";
import { GRAPH_SCHEMA_SOURCES_KEYWORD } from "./schema-subset.js";
import { sha256Hex } from "./sha256.js";

export interface GraphSchemaSampleOptions {
  /** Elements generated for each array; default 1, at most 8. */
  arrayItems?: number;
  /** Picks among `enum` values and varies generated text; default 0. */
  variant?: number;
  /** Nesting deeper than this yields null; default 16. */
  maxDepth?: number;
}

const MAX_ARRAY_ITEMS = 8;
const DEFAULT_MAX_DEPTH = 16;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullSchema(schema: unknown): boolean {
  return record(schema) && schema.type === "null";
}

/** The schema's single type: the first non-null entry of a type list. */
function schemaType(schema: GraphJsonSchema): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((type): type is string => typeof type === "string");
    return types.find((type) => type !== "null") ?? types[0];
  }
  if (record(schema.properties)) return "object";
  if (schema.items !== undefined) return "array";
  return undefined;
}

function sampleString(name: string, path: string, variant: number): string {
  const suffix = variant > 0 ? ` ${variant + 1}` : "";
  const lower = name.toLowerCase();
  if (/(?:^|_)(?:sha|sha1|commit|headref|baseref|headsha|basesha|oid)$|ref$|sha$/.test(lower)) {
    return sha256Hex(`orkestrator-mock-sha\0${path}\0${variant}`).slice(0, 40);
  }
  if (lower.endsWith("url")) return `https://example.com/mock/${name}${variant > 0 ? variant : ""}`;
  if (lower.includes("branch")) return variant > 0 ? `mock/branch-${variant + 1}` : "mock/branch";
  if (lower === "path" || lower === "file" || lower.endsWith("path") || lower === "cwd") {
    return variant > 0 ? `src/example-${variant + 1}.ts` : "src/example.ts";
  }
  if (lower === "id" || lower.endsWith("id")) return `${name || "item"}-${variant + 1}`;
  return `Sample ${name || "text"}${suffix}`;
}

function sampleNumber(schema: GraphJsonSchema, integer: boolean): number {
  const minimum = typeof schema.minimum === "number" ? schema.minimum : undefined;
  const maximum = typeof schema.maximum === "number" ? schema.maximum : undefined;
  let value = minimum ?? 1;
  if (integer) value = Math.ceil(value);
  if (maximum !== undefined && value > maximum) value = integer ? Math.floor(maximum) : maximum;
  return value;
}

/**
 * A value of `schema`, generated deterministically (see the module comment
 * for the rules). `name` is the property the value is for (it picks the kind
 * of text), `path` its JSON path (it seeds generated SHAs).
 */
export function graphSchemaSample(
  schema: GraphJsonSchema,
  options: GraphSchemaSampleOptions = {},
): unknown {
  const arrayItems = Math.max(0, Math.min(MAX_ARRAY_ITEMS, Math.floor(options.arrayItems ?? 1)));
  const maxDepth = Math.max(1, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH));

  const sample = (
    current: unknown,
    name: string,
    path: string,
    depth: number,
    variant: number,
  ): unknown => {
    if (!record(current) || depth > maxDepth) return null;
    if (Object.hasOwn(current, "const")) return structuredClone(current.const);
    if (Array.isArray(current.enum) && current.enum.length > 0) {
      return structuredClone(current.enum[variant % current.enum.length]);
    }
    if (Array.isArray(current.anyOf)) {
      const branch = current.anyOf.find((entry) => !isNullSchema(entry));
      return branch === undefined ? null : sample(branch, name, path, depth + 1, variant);
    }
    switch (schemaType(current)) {
      case "object": {
        const properties = record(current.properties) ? current.properties : {};
        const value: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(properties)) {
          value[key] = sample(child, key, `${path}.${key}`, depth + 1, variant);
        }
        return value;
      }
      case "array": {
        if (current[GRAPH_SCHEMA_SOURCES_KEYWORD] === true || !record(current.items)) return [];
        const items = current.items;
        // Each element takes the next variant, so generated ids and paths stay unique.
        return Array.from({ length: arrayItems }, (_, index) =>
          sample(items, name.replace(/s$/, ""), `${path}[${index}]`, depth + 1, variant + index),
        );
      }
      case "string":
        return sampleString(name, path, variant);
      case "integer":
        return sampleNumber(current, true);
      case "number":
        return sampleNumber(current, false);
      case "boolean":
        return true;
      default:
        return null;
    }
  };

  return sample(schema, "", "$", 0, Math.max(0, Math.floor(options.variant ?? 0)));
}

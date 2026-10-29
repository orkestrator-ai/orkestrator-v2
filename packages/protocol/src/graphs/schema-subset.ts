/**
 * The JSON-Schema subset graph artifact types may use (plan P1.2, report §5.3).
 *
 * A type's schema reaches two places: the backend's submit-time validator
 * (`validateWorkflowJsonSchema`, shared from `../workflow-json-schema.ts`) and
 * every provider's structured-output or tool-input schema. The subset is the
 * intersection of the two:
 *
 * - Only keywords the validator enforces: `type` (one string), `properties`,
 *   `required`, `additionalProperties`, `items`, `enum`, `const`, `minimum`,
 *   `maximum` and `anyOf`, plus the annotations `description`, `title` and
 *   `x-orkestrator-sources`. Everything else is an error with its JSON path,
 *   never silently ignored: `pattern`, `$ref` and `oneOf` above all.
 * - `minLength`, `maxLength`, `minItems` and `maxItems` are validator keywords
 *   but several providers reject or strip them (see
 *   `structured-review/budgets.ts`), so lengths and counts belong in the
 *   type's budgets, which the runtime enforces.
 * - Every object lists every property in `required` and sets
 *   `additionalProperties: false`; an optional value is `anyOf` with
 *   `{ "type": "null" }`. The root is an object.
 *
 * `x-orkestrator-sources: true` marks an array of strings as a provenance field
 * (report §5.9): the checker records where it is, and
 * {@link graphProviderSchema} strips it before a provider sees the schema.
 */
import {
  FieldErrorCollector,
  type FieldValidation,
  isPlainRecord,
  joinPath,
  jsonDepthExceeds,
} from "../field-validation.js";
import { validateWorkflowJsonSchema } from "../workflow-json-schema.js";
import type { WorkflowResultValidationIssue } from "../workflow-results.js";
import type { GraphJsonSchema } from "./artifact-type-def.js";
import {
  GRAPH_PATH_SEGMENT_PATTERN,
  GRAPH_TEMPLATE_BOUNDS,
  graphUtf8Bytes,
  isGraphFieldPath,
} from "./grammar.js";

/** The provenance annotation (report §5.9). */
export const GRAPH_SCHEMA_SOURCES_KEYWORD = "x-orkestrator-sources";

export const GRAPH_SCHEMA_TYPES = [
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
] as const;
export type GraphSchemaType = (typeof GRAPH_SCHEMA_TYPES)[number];

/** Keywords that constrain values, by the `type` they apply to. */
const KEYWORDS_BY_TYPE: Record<GraphSchemaType, readonly string[]> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items"],
  string: ["enum", "const"],
  number: ["enum", "const", "minimum", "maximum"],
  integer: ["enum", "const", "minimum", "maximum"],
  boolean: ["enum", "const"],
  null: [],
};

/** Every keyword the subset accepts somewhere. */
export const GRAPH_SCHEMA_KEYWORDS = [
  "type",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
] as const;

/** Keywords that describe rather than constrain; allowed on any schema. */
export const GRAPH_SCHEMA_ANNOTATIONS = [
  "description",
  "title",
  GRAPH_SCHEMA_SOURCES_KEYWORD,
] as const;

/** Why a well-known keyword is outside the subset, and what to use instead. */
const UNSUPPORTED_KEYWORD_HINTS: ReadonlyMap<string, string> = new Map([
  ["pattern", "pattern is not portable across providers; describe the format in description"],
  ["format", "format is not portable across providers; describe the format in description"],
  ["$ref", "references are not portable across providers; write the schema inline"],
  ["$defs", "definitions are not portable across providers; write the schema inline"],
  ["definitions", "definitions are not portable across providers; write the schema inline"],
  ["oneOf", "oneOf is not portable across providers; use anyOf"],
  ["allOf", "allOf is not portable across providers; merge the schemas into one"],
  ["not", "not is not portable across providers"],
  ["if", "conditional schemas are not portable across providers"],
  ["then", "conditional schemas are not portable across providers"],
  ["else", "conditional schemas are not portable across providers"],
  ["nullable", 'nullable is not JSON Schema; use anyOf with { "type": "null" }'],
  [
    "minLength",
    "several providers reject or strip length bounds; use the type's maxStringBytes budget",
  ],
  [
    "maxLength",
    "several providers reject or strip length bounds; use the type's maxStringBytes budget",
  ],
  ["minItems", "several providers reject or strip item bounds; use the type's maxItems budget"],
  ["maxItems", "several providers reject or strip item bounds; use the type's maxItems budget"],
  ["exclusiveMinimum", "use minimum"],
  ["exclusiveMaximum", "use maximum"],
  [
    "default",
    "defaults are not portable across providers; put sample values in the type's example",
  ],
  ["examples", "put sample values in the type's example"],
  ["patternProperties", "every property must be named in properties"],
  ["propertyNames", "every property must be named in properties"],
  ["uniqueItems", "uniqueness is not portable across providers"],
]);

const KIB = 1024;

/** Bounds a subset schema stays within, beyond the template's byte and depth bounds. */
export const GRAPH_SCHEMA_SUBSET_BOUNDS = Object.freeze({
  /** Serialized bytes of one schema (a template type's bound). */
  maxSchemaBytes: GRAPH_TEMPLATE_BOUNDS.maxTypeSchemaBytes,
  /** Raw JSON nesting of one schema. */
  maxSchemaDepth: GRAPH_TEMPLATE_BOUNDS.maxTypeSchemaDepth,
  /** Objects nested in objects (OpenAI's strict structured outputs allow 10). */
  maxObjectDepth: 10,
  maxPropertiesPerObject: 100,
  maxPropertiesTotal: 1000,
  maxEnumValues: 256,
  maxEnumValuesTotal: 1000,
  maxEnumStringBytes: 256,
  maxAnyOfBranches: 8,
  maxDescriptionBytes: 4 * KIB,
  maxTitleBytes: 200,
  maxSourcesFields: 16,
});

/** A provenance field found in a schema: `issues[].reviewSourceIds`. */
export interface GraphSchemaSourcesField {
  /** Property names, with `[]` for "each element of this array". */
  segments: string[];
  /** The segments joined: `issues[].reviewSourceIds`. */
  path: string;
}

/** What the checker learned about a schema that passed. */
export interface GraphSchemaSubsetInfo {
  sources: GraphSchemaSourcesField[];
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function scalarMatchesType(value: unknown, type: GraphSchemaType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return false;
  }
}

/** Join provenance segments for display: `["issues", "[]", "ids"]` → `issues[].ids`. */
export function graphSchemaSegmentsPath(segments: readonly string[]): string {
  return segments.reduce(
    (path, segment) => (segment === "[]" ? `${path}[]` : path ? `${path}.${segment}` : segment),
    "",
  );
}

function isNullSchema(value: unknown): boolean {
  return isPlainRecord(value) && value.type === "null" && value.anyOf === undefined;
}

/** An array-of-strings schema, or `anyOf` of one and `{ type: "null" }`. */
function isStringListSchema(schema: Record<string, unknown>): boolean {
  const plain = (candidate: unknown): boolean =>
    isPlainRecord(candidate) &&
    candidate.type === "array" &&
    isPlainRecord(candidate.items) &&
    candidate.items.type === "string" &&
    candidate.items.anyOf === undefined;
  if (Array.isArray(schema.anyOf)) {
    const alternatives = schema.anyOf;
    return (
      alternatives.length === 2 &&
      alternatives.filter(plain).length === 1 &&
      alternatives.filter(isNullSchema).length === 1
    );
  }
  return plain(schema);
}

interface WalkState {
  errors: FieldErrorCollector;
  properties: number;
  enumValues: number;
  sources: GraphSchemaSourcesField[];
}

function checkText(
  value: unknown,
  path: string,
  state: WalkState,
  maxBytes: number,
  name: string,
): void {
  if (typeof value !== "string") {
    state.errors.add(path, "type", `${name} must be a string`);
  } else if (graphUtf8Bytes(value) > maxBytes) {
    state.errors.add(path, "too_large", `${name} must be at most ${maxBytes} UTF-8 bytes`);
  }
}

function checkBound(
  schema: Record<string, unknown>,
  path: string,
  state: WalkState,
  type: GraphSchemaType,
): void {
  for (const key of ["minimum", "maximum"] as const) {
    const bound = schema[key];
    if (bound === undefined) continue;
    if (typeof bound !== "number" || !Number.isFinite(bound)) {
      state.errors.add(joinPath(path, key), "type", `${key} must be a finite number`);
    } else if (type === "integer" && !Number.isSafeInteger(bound)) {
      state.errors.add(
        joinPath(path, key),
        "not_integer",
        `${key} of an integer must be an integer`,
      );
    }
  }
  if (
    typeof schema.minimum === "number" &&
    typeof schema.maximum === "number" &&
    schema.minimum > schema.maximum
  ) {
    state.errors.add(joinPath(path, "minimum"), "out_of_range", "minimum must not exceed maximum");
  }
}

function checkEnumAndConst(
  schema: Record<string, unknown>,
  path: string,
  state: WalkState,
  type: GraphSchemaType,
): void {
  if (schema.const !== undefined) {
    if (!isScalar(schema.const) || !scalarMatchesType(schema.const, type)) {
      state.errors.add(joinPath(path, "const"), "type", `const must be a ${type} value`);
    }
    if (schema.enum !== undefined) {
      state.errors.add(joinPath(path, "enum"), "conflict", "Use either const or enum, not both");
    }
  }
  if (schema.enum === undefined) return;
  const enumPath = joinPath(path, "enum");
  if (!Array.isArray(schema.enum)) {
    state.errors.add(enumPath, "type", "enum must be an array");
    return;
  }
  if (schema.enum.length === 0) {
    state.errors.add(enumPath, "empty", "enum must list at least one value");
    return;
  }
  if (schema.enum.length > GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumValues) {
    state.errors.add(
      enumPath,
      "too_many",
      `enum must list at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumValues} values`,
    );
    return;
  }
  state.enumValues += schema.enum.length;
  if (state.enumValues > GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumValuesTotal) {
    state.errors.add(
      enumPath,
      "too_many",
      `A schema may list at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumValuesTotal} enum values in total`,
    );
    return;
  }
  const seen = new Set<unknown>();
  schema.enum.forEach((entry, index) => {
    const entryPath = joinPath(enumPath, index);
    if (!isScalar(entry) || !scalarMatchesType(entry, type)) {
      state.errors.add(entryPath, "type", `enum values must be ${type} values`);
    } else if (
      typeof entry === "string" &&
      graphUtf8Bytes(entry) > GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumStringBytes
    ) {
      state.errors.add(
        entryPath,
        "too_large",
        `enum values must be at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxEnumStringBytes} UTF-8 bytes`,
      );
    } else if (seen.has(entry)) {
      state.errors.add(entryPath, "duplicate", "enum values must be unique");
    }
    seen.add(entry);
  });
}

function checkObjectSchema(
  schema: Record<string, unknown>,
  path: string,
  state: WalkState,
  segments: string[],
  objectDepth: number,
): void {
  if (objectDepth > GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth) {
    state.errors.add(
      path,
      "too_deep",
      `Objects may be nested at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxObjectDepth} deep`,
    );
    return;
  }
  const propertiesPath = joinPath(path, "properties");
  if (schema.properties === undefined) {
    state.errors.add(propertiesPath, "required", "An object schema must list its properties");
    return;
  }
  if (!isPlainRecord(schema.properties)) {
    state.errors.add(propertiesPath, "type", "properties must be an object");
    return;
  }
  const keys = Object.keys(schema.properties);
  if (keys.length > GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject) {
    state.errors.add(
      propertiesPath,
      "too_many",
      `An object may have at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesPerObject} properties`,
    );
    return;
  }
  state.properties += keys.length;
  if (state.properties > GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesTotal) {
    state.errors.add(
      propertiesPath,
      "too_many",
      `A schema may have at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxPropertiesTotal} properties in total`,
    );
    return;
  }

  const requiredPath = joinPath(path, "required");
  const required = new Set<string>();
  if (!Array.isArray(schema.required)) {
    state.errors.add(
      requiredPath,
      schema.required === undefined ? "required" : "type",
      "required must list every property",
    );
  } else {
    schema.required.forEach((entry, index) => {
      const entryPath = joinPath(requiredPath, index);
      if (typeof entry !== "string") {
        state.errors.add(entryPath, "type", "required entries must be property names");
      } else if (required.has(entry)) {
        state.errors.add(entryPath, "duplicate", `"${entry}" is listed twice`);
      } else if (!Object.hasOwn(schema.properties as object, entry)) {
        state.errors.add(entryPath, "unknown_property", `"${entry}" is not a property`);
      }
      if (typeof entry === "string") required.add(entry);
    });
  }

  const additionalPath = joinPath(path, "additionalProperties");
  if (schema.additionalProperties !== false) {
    state.errors.add(
      additionalPath,
      schema.additionalProperties === undefined ? "required" : "type",
      "additionalProperties must be false",
    );
  }

  for (const key of keys) {
    const propertyPath = joinPath(propertiesPath, key);
    if (key.length > GRAPH_TEMPLATE_BOUNDS.maxKeyChars || !GRAPH_PATH_SEGMENT_PATTERN.test(key)) {
      state.errors.add(
        propertyPath,
        "pattern",
        `Property names must be letters, digits, '_' or '-', starting with a letter or '_', at most ${GRAPH_TEMPLATE_BOUNDS.maxKeyChars} characters`,
      );
      continue;
    }
    if (Array.isArray(schema.required) && !required.has(key)) {
      state.errors.add(
        propertyPath,
        "not_required",
        'Every property must be listed in required; express an optional value as anyOf with { "type": "null" }',
      );
    }
    visitSchema(
      (schema.properties as Record<string, unknown>)[key],
      propertyPath,
      state,
      [...segments, key],
      objectDepth,
      false,
    );
  }
}

function visitSchema(
  schema: unknown,
  path: string,
  state: WalkState,
  segments: string[],
  objectDepth: number,
  isRoot: boolean,
  insideAnyOf = false,
): void {
  if (!isPlainRecord(schema)) {
    state.errors.add(path, "type", "Expected a schema object");
    return;
  }
  const allowedKeywords = new Set<string>([...GRAPH_SCHEMA_KEYWORDS, ...GRAPH_SCHEMA_ANNOTATIONS]);
  for (const key of Object.keys(schema)) {
    if (allowedKeywords.has(key)) continue;
    state.errors.add(
      joinPath(path, key),
      "unsupported_keyword",
      UNSUPPORTED_KEYWORD_HINTS.get(key) ?? `"${key}" is not in the portable schema subset`,
    );
  }
  if (schema.description !== undefined) {
    checkText(
      schema.description,
      joinPath(path, "description"),
      state,
      GRAPH_SCHEMA_SUBSET_BOUNDS.maxDescriptionBytes,
      "description",
    );
  }
  if (schema.title !== undefined) {
    checkText(
      schema.title,
      joinPath(path, "title"),
      state,
      GRAPH_SCHEMA_SUBSET_BOUNDS.maxTitleBytes,
      "title",
    );
  }
  if (schema[GRAPH_SCHEMA_SOURCES_KEYWORD] !== undefined) {
    const sourcesPath = joinPath(path, GRAPH_SCHEMA_SOURCES_KEYWORD);
    if (schema[GRAPH_SCHEMA_SOURCES_KEYWORD] !== true) {
      state.errors.add(sourcesPath, "type", `${GRAPH_SCHEMA_SOURCES_KEYWORD} must be true`);
    } else if (isRoot || insideAnyOf) {
      state.errors.add(
        sourcesPath,
        "not_applicable",
        "Mark the property itself as a provenance field, not the root or an anyOf branch",
      );
    } else if (!isStringListSchema(schema)) {
      state.errors.add(
        sourcesPath,
        "not_applicable",
        "A provenance field must be an array of strings, optionally nullable",
      );
    } else if (state.sources.length >= GRAPH_SCHEMA_SUBSET_BOUNDS.maxSourcesFields) {
      state.errors.add(
        sourcesPath,
        "too_many",
        `A schema may mark at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxSourcesFields} provenance fields`,
      );
    } else {
      state.sources.push({ segments, path: graphSchemaSegmentsPath(segments) });
    }
  }

  if (schema.anyOf !== undefined) {
    const anyOfPath = joinPath(path, "anyOf");
    if (isRoot) {
      state.errors.add(anyOfPath, "not_applicable", "The root schema must be an object, not anyOf");
      return;
    }
    if (insideAnyOf) {
      state.errors.add(anyOfPath, "not_applicable", "Nested anyOf is not portable; flatten it");
      return;
    }
    for (const key of Object.keys(schema)) {
      if (key === "anyOf" || (GRAPH_SCHEMA_ANNOTATIONS as readonly string[]).includes(key)) {
        continue;
      }
      if (allowedKeywords.has(key)) {
        state.errors.add(
          joinPath(path, key),
          "not_applicable",
          "A schema with anyOf may carry only annotations beside it; move constraints into the branches",
        );
      }
    }
    if (!Array.isArray(schema.anyOf)) {
      state.errors.add(anyOfPath, "type", "anyOf must be an array");
      return;
    }
    if (
      schema.anyOf.length < 2 ||
      schema.anyOf.length > GRAPH_SCHEMA_SUBSET_BOUNDS.maxAnyOfBranches
    ) {
      state.errors.add(
        anyOfPath,
        schema.anyOf.length < 2 ? "too_few" : "too_many",
        `anyOf must have between 2 and ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxAnyOfBranches} branches`,
      );
      return;
    }
    schema.anyOf.forEach((branch, index) =>
      visitSchema(branch, joinPath(anyOfPath, index), state, segments, objectDepth, false, true),
    );
    return;
  }

  const typePath = joinPath(path, "type");
  if (schema.type === undefined) {
    state.errors.add(typePath, "required", "Every schema needs a type (or anyOf)");
    return;
  }
  if (Array.isArray(schema.type)) {
    state.errors.add(
      typePath,
      "type",
      'A type union is not portable; use anyOf (for example with { "type": "null" })',
    );
    return;
  }
  if (!(GRAPH_SCHEMA_TYPES as readonly unknown[]).includes(schema.type)) {
    state.errors.add(typePath, "enum", `type must be one of ${GRAPH_SCHEMA_TYPES.join(", ")}`);
    return;
  }
  const type = schema.type as GraphSchemaType;
  if (isRoot && type !== "object") {
    state.errors.add(typePath, "not_applicable", "The root schema must be an object");
    return;
  }
  const applicable = new Set(KEYWORDS_BY_TYPE[type]);
  for (const key of GRAPH_SCHEMA_KEYWORDS) {
    if (key === "type" || key === "anyOf" || schema[key] === undefined) continue;
    if (!applicable.has(key)) {
      state.errors.add(
        joinPath(path, key),
        "not_applicable",
        `${key} does not apply to type ${type}`,
      );
    }
  }
  switch (type) {
    case "object":
      checkObjectSchema(schema, path, state, segments, objectDepth + 1);
      return;
    case "array": {
      const itemsPath = joinPath(path, "items");
      if (schema.items === undefined) {
        state.errors.add(itemsPath, "required", "An array schema must describe its items");
        return;
      }
      if (Array.isArray(schema.items)) {
        state.errors.add(
          itemsPath,
          "type",
          "Tuple items are not portable; items must be one schema",
        );
        return;
      }
      visitSchema(schema.items, itemsPath, state, [...segments, "[]"], objectDepth, false);
      return;
    }
    case "number":
    case "integer":
      checkBound(schema, path, state, type);
      checkEnumAndConst(schema, path, state, type);
      return;
    case "string":
    case "boolean":
      checkEnumAndConst(schema, path, state, type);
      return;
    case "null":
      return;
  }
}

/**
 * Check `schema` against the portable subset, adding errors under `path`.
 * Returns what it found (provenance fields) when the schema passed.
 */
export function checkGraphSchemaSubset(
  schema: unknown,
  path: string,
  errors: FieldErrorCollector,
): GraphSchemaSubsetInfo | undefined {
  const failedBefore = errors.errors.length + errors.omitted;
  if (!isPlainRecord(schema)) {
    errors.add(path, "type", "Expected a schema object");
    return undefined;
  }
  if (jsonDepthExceeds(schema, GRAPH_SCHEMA_SUBSET_BOUNDS.maxSchemaDepth)) {
    errors.add(
      path,
      "too_deep",
      `A schema may be nested at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxSchemaDepth} levels deep`,
    );
    return undefined;
  }
  let bytes: number;
  try {
    bytes = graphUtf8Bytes(JSON.stringify(schema));
  } catch {
    errors.add(path, "not_json", "A schema must be JSON");
    return undefined;
  }
  if (bytes > GRAPH_SCHEMA_SUBSET_BOUNDS.maxSchemaBytes) {
    errors.add(
      path,
      "too_large",
      `A schema must serialize to at most ${GRAPH_SCHEMA_SUBSET_BOUNDS.maxSchemaBytes} bytes`,
    );
    return undefined;
  }
  const state: WalkState = { errors, properties: 0, enumValues: 0, sources: [] };
  visitSchema(schema, path, state, [], 0, true);
  return errors.errors.length + errors.omitted === failedBefore
    ? { sources: state.sources }
    : undefined;
}

/** Standalone check, with JSON paths from `$`. */
export function validateGraphSchemaSubset(
  schema: unknown,
  maxErrors = 50,
): FieldValidation<GraphSchemaSubsetInfo> {
  const errors = new FieldErrorCollector(maxErrors);
  const info = checkGraphSchemaSubset(schema, "$", errors);
  return info ? { ok: true, value: info } : errors.result({ sources: [] });
}

/**
 * The schema a provider sees: a deep copy without `x-orkestrator-sources`.
 * Everything else in the subset is portable as it stands.
 */
export function graphProviderSchema(schema: GraphJsonSchema): GraphJsonSchema {
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (!isPlainRecord(value)) return value;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === GRAPH_SCHEMA_SOURCES_KEYWORD) continue;
      // `properties` maps names to schemas; a property may be named like a keyword.
      copy[key] =
        key === "properties" && isPlainRecord(entry)
          ? Object.fromEntries(Object.entries(entry).map(([name, child]) => [name, strip(child)]))
          : strip(entry);
    }
    return copy;
  };
  return strip(schema) as GraphJsonSchema;
}

/**
 * Validate a JSON value against a subset schema: the backend's submit-time
 * validator, so the designer, mock runs and the runtime agree.
 */
export function validateGraphSchemaValue(
  schema: GraphJsonSchema,
  value: unknown,
): WorkflowResultValidationIssue[] {
  return validateWorkflowJsonSchema(schema, value);
}

/** A field reached by {@link graphSchemaAtPath}. */
export interface GraphSchemaField {
  /** The schema at the path, with a nullable wrapper removed. */
  schema: GraphJsonSchema;
  /** True when the field, or an object on the way to it, may be null. */
  nullable: boolean;
}

/** The non-null branch of `anyOf: [X, { type: "null" }]`, or the schema itself. */
export function graphSchemaNonNull(schema: GraphJsonSchema): {
  schema: GraphJsonSchema;
  nullable: boolean;
} {
  if (!Array.isArray(schema.anyOf)) return { schema, nullable: false };
  const branches = schema.anyOf.filter((branch) => !isNullSchema(branch));
  const nullable = branches.length < schema.anyOf.length;
  return branches.length === 1 && isPlainRecord(branches[0])
    ? { schema: branches[0], nullable }
    : { schema, nullable };
}

/**
 * Follow a dotted field path through object properties (and nullable
 * wrappers). Arrays are not entered: a path names one field of one value.
 * Null when the path does not exist in the schema.
 */
export function graphSchemaAtPath(schema: GraphJsonSchema, path: string): GraphSchemaField | null {
  if (!isGraphFieldPath(path)) return null;
  let current: GraphJsonSchema = schema;
  let nullable = false;
  for (const segment of path.split(".")) {
    const unwrapped = graphSchemaNonNull(current);
    nullable ||= unwrapped.nullable;
    const properties = unwrapped.schema.properties;
    if (unwrapped.schema.type !== "object" || !isPlainRecord(properties)) return null;
    const next = Object.hasOwn(properties, segment) ? properties[segment] : undefined;
    if (!isPlainRecord(next)) return null;
    current = next;
  }
  const last = graphSchemaNonNull(current);
  return { schema: last.schema, nullable: nullable || last.nullable };
}

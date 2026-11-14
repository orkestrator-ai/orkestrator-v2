/**
 * Effect Schema building blocks for the backend's own input schemas: MCP and
 * agent tool inputs, and the design service's operation descriptors and disk
 * records (plan item 7014, which replaced Zod here).
 *
 * Two things differ from plain Effect Schema, both to keep the contracts the
 * Zod schemas published:
 *
 * - **Strictness per object.** `strictObject` refuses unknown keys, as Zod's
 *   `.strict()` did, while `Schema.Struct` drops them (Zod's default). Effect
 *   only has a per-parse `onExcessProperty`, so `decodeSync`/`decodeResult`
 *   decode with `"error"` and forgive the unexpected keys of objects that are
 *   not strict (then decode again in the default mode, which drops them).
 * - **Bounds on trimmed strings.** `str({ trim: true, min, max })` checks the
 *   trimmed length, as Zod's `.trim().min().max()` did, and publishes the
 *   bounds in the JSON Schema (an Effect check after a `decodeTo` would not be
 *   published).
 *
 * `toolInput(schema)` turns a schema into the Standard Schema with JSON that
 * `McpServer.registerTool` takes: `tools/list` publishes `toolJsonSchema`, and
 * `tools/call` validates with `decodeResult`.
 */
import { fromJsonSchema, type JsonSchemaType } from "@modelcontextprotocol/server";
import { Effect, Exit, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { validateWorkflowJsonSchema } from "@orkestrator/protocol/workflow-json-schema";

/**
 * The annotation `strictObject` sets: read from an `UnexpectedKey` issue's
 * AST, and exported into the JSON Schema, where `toolJsonSchema` turns it into
 * `additionalProperties: false`.
 */
const STRICT = "x-orkestrator-strict";

/** The decoded and encoded types of a schema, like Zod's `z.infer`/`z.input`. */
export type Infer<S extends Schema.Top> = S["Type"];

type StrOptions = {
  /** Trim before every check, and decode to the trimmed value (Zod's `.trim()`). */
  readonly trim?: boolean;
  /** Lower-case after trimming (Zod's `.toLowerCase()`). */
  readonly lowercase?: boolean;
  readonly min?: number;
  readonly max?: number;
  /** Exact length (Zod's `.length(n)`). */
  readonly length?: number;
  /** Checked against the (trimmed) value; published as its source, as Zod did. */
  readonly pattern?: RegExp;
  /** The failure message for `pattern`. */
  readonly message?: string;
  readonly uuid?: boolean;
  readonly startsWith?: string;
  readonly endsWith?: string;
};

const UUID =
  /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

function stringIssues(value: string, options: StrOptions): string | undefined {
  const { min, max, length, pattern, uuid, startsWith, endsWith } = options;
  if (length !== undefined && value.length !== length)
    return `Expected a string of exactly ${length} characters`;
  if (min !== undefined && value.length < min)
    return `Expected a string of at least ${min} character${min === 1 ? "" : "s"}`;
  if (max !== undefined && value.length > max)
    return `Expected a string of at most ${max} characters`;
  if (uuid && !UUID.test(value)) return "Expected a UUID";
  if (startsWith !== undefined && !value.startsWith(startsWith))
    return `Expected a string starting with ${JSON.stringify(startsWith)}`;
  if (endsWith !== undefined && !value.endsWith(endsWith))
    return `Expected a string ending with ${JSON.stringify(endsWith)}`;
  if (pattern) {
    pattern.lastIndex = 0;
    if (!pattern.test(value)) return options.message ?? `Expected a string matching ${pattern}`;
  }
  return undefined;
}

function stringJsonSchema(options: StrOptions): Record<string, unknown> {
  const { min, max, length, pattern, uuid, startsWith, endsWith } = options;
  const json: Record<string, unknown> = {};
  if (length !== undefined) {
    json.minLength = length;
    json.maxLength = length;
  }
  if (min !== undefined) json.minLength = min;
  if (max !== undefined) json.maxLength = max;
  if (uuid) {
    json.format = "uuid";
    json.pattern = UUID.source;
  }
  if (pattern) json.pattern = pattern.source;
  else if (startsWith !== undefined && !uuid) json.pattern = `^${escapeRegExp(startsWith)}.*`;
  else if (endsWith !== undefined && !uuid) json.pattern = `.*${escapeRegExp(endsWith)}$`;
  return json;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A string field. Every check runs on the raw value, or on the trimmed (and
 * lower-cased) value with `trim`/`lowercase`, which also decode to it.
 */
export function str(options: StrOptions = {}): Schema.String {
  const normalize = (value: string) => {
    const trimmed = options.trim ? value.trim() : value;
    return options.lowercase ? trimmed.toLowerCase() : trimmed;
  };
  const hasChecks = Object.keys(options).some(
    (key) => key !== "trim" && key !== "lowercase" && key !== "message",
  );
  const raw = hasChecks
    ? Schema.String.check(
        Schema.makeFilter((value: string) => stringIssues(normalize(value), options) ?? true, {
          toJsonSchema: () => stringJsonSchema(options),
        }),
      )
    : Schema.String;
  if (!options.trim && !options.lowercase) return raw as Schema.String;
  const transformation = options.trim
    ? options.lowercase
      ? SchemaTransformation.composeTransformation(
          SchemaTransformation.trim(),
          SchemaTransformation.toLowerCase(),
        )
      : SchemaTransformation.trim()
    : SchemaTransformation.toLowerCase();
  // Typed as a plain string schema (usable as a record key); at runtime the
  // encoded side carries the checks and the decoded side the trimmed value.
  return raw.pipe(Schema.decodeTo(Schema.String, transformation)) as unknown as Schema.String;
}

type NumberOptions = {
  readonly min?: number;
  readonly max?: number;
  /** Strictly greater than (Zod's `.positive()` is `{ gt: 0 }`). */
  readonly gt?: number;
  /** The failure message of `max`. */
  readonly maxMessage?: string;
};

function numberChecks(options: NumberOptions) {
  const checks: SchemaAST.Check<number>[] = [];
  if (options.min !== undefined) checks.push(Schema.isGreaterThanOrEqualTo(options.min));
  if (options.max !== undefined)
    checks.push(
      Schema.isLessThanOrEqualTo(
        options.max,
        options.maxMessage ? { message: options.maxMessage } : undefined,
      ),
    );
  if (options.gt !== undefined) checks.push(Schema.isGreaterThan(options.gt));
  return checks;
}

/** A finite number (Zod's `z.number()`, which refused Infinity and NaN). */
export function num(options: NumberOptions = {}): Schema.Finite {
  const checks = numberChecks(options);
  return checks.length > 0
    ? Schema.Finite.check(...(checks as [SchemaAST.Check<number>]))
    : Schema.Finite;
}

/** A safe integer (Zod's `.int()`). */
export function int(options: NumberOptions = {}): Schema.Int {
  const checks = numberChecks(options);
  return checks.length > 0
    ? Schema.Int.check(...(checks as [SchemaAST.Check<number>]))
    : Schema.Int;
}

/** An array with optional item-count bounds. */
export function list<S extends Schema.Top>(
  item: S,
  options: {
    readonly min?: number;
    readonly max?: number;
    /** The failure message of `max`. */
    readonly maxMessage?: string;
  } = {},
) {
  const checks: SchemaAST.Check<ReadonlyArray<S["Type"]>>[] = [];
  if (options.min !== undefined) checks.push(Schema.isMinLength(options.min));
  if (options.max !== undefined)
    checks.push(
      Schema.isMaxLength(
        options.max,
        options.maxMessage ? { message: options.maxMessage } : undefined,
      ),
    );
  const array = Schema.Array(item);
  return checks.length > 0
    ? array.check(...(checks as [SchemaAST.Check<ReadonlyArray<S["Type"]>>]))
    : array;
}

/**
 * Adds a description the JSON Schema publishes (Zod's `.describe`). The JSON
 * Schema describes the encoded side, so a transformed schema (a trimmed
 * string, a default) is described there; `Unknown` publishes only key
 * annotations.
 */
export function describe<S extends Schema.Top>(schema: S, description: string): S["Rebuild"] {
  if (schema.ast._tag === "Unknown") return schema.annotateKey({ description });
  if (schema.ast.encoding) return schema.pipe(Schema.annotateEncoded({ description }));
  return schema.annotate({ description });
}

/** A check from a predicate and the message it fails with (Zod's `.refine`). */
export function refine<T>(predicate: (value: T) => boolean, message: string) {
  // Published as nothing; the empty export keeps a description that
  // `describe` attaches to this, the schema's last check.
  return Schema.makeFilter<T>((value) => (predicate(value) ? true : message), {
    toJsonSchema: () => ({}),
  });
}

/**
 * An object that refuses unknown keys (Zod's `.strict()`). The annotation is
 * read by `decodeResult` and published as `additionalProperties: false`.
 */
export function strictObject<const F extends Schema.Struct.Fields>(fields: F) {
  return Schema.Struct(fields).annotate({ [STRICT]: true });
}

/** An object that keeps its unknown keys (Zod's `.passthrough()`). */
export function looseObject<const F extends Schema.Struct.Fields>(fields: F) {
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]);
}

/**
 * A record (Zod's `z.record`). Effect leaves a record whose keys are checked
 * open in the JSON Schema, value schema included, so this publishes the key
 * and value schemas itself as `propertyNames` and `additionalProperties`.
 */
export function record<K extends Schema.Record.Key, V extends Schema.Top>(key: K, value: V) {
  return Schema.Record(key, value).check(
    Schema.makeFilter(() => true, {
      toJsonSchema: () => ({
        propertyNames: jsonSchemaOf(key),
        additionalProperties: jsonSchemaOf(value),
      }),
    }),
  );
}

/**
 * A key that decodes to `value` when it is missing (Zod's `.default`); the
 * JSON Schema publishes the default.
 */
export function withDefault<S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  value: S["Encoded"],
) {
  return schema
    .annotate({ default: value })
    .pipe(
      Schema.withDecodingDefaultKey(Effect.succeed(value) as never),
    ) as unknown as Schema.withDecodingDefaultKey<S>;
}

/** Field issues one refused `jsonSchemaField` value names before summarising the rest. */
const JSON_SCHEMA_FIELD_MAX_NAMED_ISSUES = 12;

/**
 * The refusal text of a value the JSON Schema rejected, naming each field at
 * fault. The SDK's validator says `data must NOT have additional properties`
 * without saying which property, so a model resent a 20 KB report several
 * times guessing at it. The workflow contract walker reports the path and,
 * for an unknown field, the fields allowed there. When it finds nothing (a
 * keyword it does not implement), the validator's own text stands.
 */
function jsonSchemaFieldRefusal(
  json: Record<string, unknown>,
  value: unknown,
  fallback: string,
): string {
  const issues = validateWorkflowJsonSchema(json as JsonSchema, value);
  if (issues.length === 0) return fallback;
  const named = issues
    .slice(0, JSON_SCHEMA_FIELD_MAX_NAMED_ISSUES)
    .map((issue) => `${issue.path}: ${issue.message}`);
  const omitted = issues.length - named.length;
  return `${named.join("; ")}${omitted > 0 ? `; and ${omitted} more` : ""}`;
}

/**
 * A field validated by a JSON Schema (Zod's `z.fromJSONSchema`): published
 * verbatim and checked by the MCP SDK's JSON Schema validator. A refusal
 * names each field at fault by its path from the field (`$.a.b`).
 */
export function jsonSchemaField<T = unknown>(json: Record<string, unknown>): Schema.Codec<T, T> {
  const standard = fromJsonSchema<T>(json as JsonSchemaType)["~standard"];
  const { $schema: _dialect, ...published } = json;
  // `Unknown` publishes `{}` whatever its checks say; `Any` publishes them.
  return Schema.Any.check(
    Schema.makeFilter(
      (value) => {
        const result = standard.validate(value);
        if (result instanceof Promise) return "Asynchronous validation is not supported";
        if (!result.issues) return true;
        return jsonSchemaFieldRefusal(
          json,
          value,
          result.issues.map((issue) => issue.message).join("; "),
        );
      },
      { toJsonSchema: () => published },
    ),
  ) as unknown as Schema.Codec<T, T>;
}

// ---------------------------------------------------------------------------
// Decoding with per-object strictness
// ---------------------------------------------------------------------------

type Decoder = (input: unknown) => Exit.Exit<unknown, Schema.SchemaError>;
const decoders = new WeakMap<SchemaAST.AST, { strict: Decoder; loose: Decoder }>();

function decodersFor(schema: Schema.Top) {
  let entry = decoders.get(schema.ast);
  if (!entry) {
    const decodable = schema as unknown as Schema.Decoder<unknown>;
    entry = {
      strict: Schema.decodeUnknownExit(decodable, { errors: "all", onExcessProperty: "error" }),
      loose: Schema.decodeUnknownExit(decodable, { errors: "all" }),
    };
    decoders.set(schema.ast, entry);
  }
  return entry;
}

/**
 * The issue without the unexpected keys of objects that are not strict, or
 * `undefined` when nothing else is left. A union is forgiven when one of its
 * members is.
 */
function withoutForgivenKeys(issue: SchemaIssue.Issue): SchemaIssue.Issue | undefined {
  switch (issue._tag) {
    case "UnexpectedKey":
      // A record reports a key its key schema refuses as unexpected: Zod refused it too.
      return issue.ast.annotations?.[STRICT] === true ||
        (issue.ast._tag === "Objects" && issue.ast.indexSignatures.length > 0)
        ? issue
        : undefined;
    case "Pointer": {
      const inner = withoutForgivenKeys(issue.issue);
      return inner ? new SchemaIssue.Pointer(issue.path, inner) : undefined;
    }
    case "Encoding": {
      const inner = withoutForgivenKeys(issue.issue);
      return inner ? new SchemaIssue.Encoding(issue.ast, inner, issue.input) : undefined;
    }
    case "Composite": {
      const kept = issue.issues
        .map(withoutForgivenKeys)
        .filter((entry): entry is SchemaIssue.Issue => entry !== undefined);
      return kept.length > 0
        ? new SchemaIssue.Composite(
            issue.ast,
            kept as [SchemaIssue.Issue, ...SchemaIssue.Issue[]],
            issue.input,
          )
        : undefined;
    }
    case "AnyOf": {
      if (issue.issues.length === 0) return issue;
      const kept: SchemaIssue.Issue[] = [];
      for (const member of issue.issues) {
        const inner = withoutForgivenKeys(member);
        if (!inner) return undefined;
        kept.push(inner);
      }
      return new SchemaIssue.AnyOf(issue.ast, kept, issue.input);
    }
    default:
      return issue;
  }
}

function issueOf(exit: Exit.Exit<unknown, Schema.SchemaError>): SchemaIssue.Issue {
  if (exit._tag === "Success") throw new Error("A successful decode has no issue");
  for (const reason of exit.cause.reasons) {
    if (reason._tag === "Fail") return reason.error.issue;
  }
  throw new Error("Schema decoding failed without a schema issue");
}

export type DecodeResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: Schema.SchemaError };

/** Decodes `input` (Zod's `safeParse`): strict objects refuse unknown keys, others drop them. */
export function decodeResult<S extends Schema.Top>(
  schema: S,
  input: unknown,
): DecodeResult<S["Type"]> {
  const { strict, loose } = decodersFor(schema);
  const exit = strict(input);
  if (exit._tag === "Success") return { success: true, data: exit.value };
  const remaining = withoutForgivenKeys(issueOf(exit));
  if (remaining) return { success: false, error: new Schema.SchemaError(remaining) };
  const retried = loose(input);
  return retried._tag === "Success"
    ? { success: true, data: retried.value }
    : { success: false, error: new Schema.SchemaError(issueOf(retried)) };
}

/** Decodes `input` or throws a `Schema.SchemaError` (Zod's `parse`). */
export function decodeSync<S extends Schema.Top>(schema: S, input: unknown): S["Type"] {
  const result = decodeResult(schema, input);
  if (!result.success) throw result.error;
  return result.data;
}

/** Whether `input` decodes. */
export function isValid<S extends Schema.Top>(schema: S, input: unknown): input is S["Encoded"] {
  return decodeResult(schema, input).success;
}

const formatter = SchemaIssue.makeFormatterStandardSchemaV1();

/** The issues of a decode failure as `{ path, message }`, as Standard Schema reports them. */
export function schemaErrorIssues(error: Schema.SchemaError) {
  return formatter(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) =>
      typeof segment === "object" && segment !== null && "key" in segment
        ? (segment.key as PropertyKey)
        : (segment as PropertyKey),
    ),
    message: issue.message,
  }));
}

// ---------------------------------------------------------------------------
// MCP tool input
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

/** Keys an `allOf` entry may carry and still be merged into its object. */
const MERGEABLE_KEYS = new Set(["description", "title", "default", "examples", STRICT]);

/**
 * Effect puts a checked schema's annotations, and a struct-with-rest's index
 * signature, into `allOf` entries next to the node. Merge the ones that only
 * describe the node itself, so a description stays where clients read it.
 */
function mergeAllOf(out: JsonObject, entries: unknown[]): unknown[] {
  const rest: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rest.push(entry);
      continue;
    }
    const record = entry as JsonObject;
    const mergeable = Object.entries(record).every(
      ([key, value]) =>
        (MERGEABLE_KEYS.has(key) && !(key in out)) ||
        (key in out && JSON.stringify(out[key]) === JSON.stringify(value)) ||
        ((key === "additionalProperties" || key === "propertyNames") && !(key in out)),
    );
    if (!mergeable) {
      rest.push(entry);
      continue;
    }
    for (const [key, value] of Object.entries(record)) out[key] = value;
  }
  return rest;
}

function finishJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(finishJsonSchema);
  if (typeof node !== "object" || node === null) return node;
  const out: JsonObject = {};
  let allOf: unknown[] | undefined;
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (key === "allOf" && Array.isArray(value)) allOf = value.map(finishJsonSchema);
    else if (key === "properties" && typeof value === "object" && value !== null)
      out.properties = Object.fromEntries(
        Object.entries(value as JsonObject).map(([name, schema]) => [
          name,
          finishJsonSchema(schema),
        ]),
      );
    else out[key] = finishJsonSchema(value);
  }
  if (allOf) {
    if (out.additionalProperties === true) delete out.additionalProperties;
    const rest = mergeAllOf(out, allOf);
    if (rest.length > 0) out.allOf = rest;
  }
  // Our only "anything but null" is an empty struct, which Zod published as an object.
  if (JSON.stringify(out.not) === '{"type":"null"}') {
    delete out.not;
    out.type = "object";
  }
  if (out[STRICT] === true) {
    delete out[STRICT];
    out.additionalProperties = false;
  } else if (out.additionalProperties === true) delete out.additionalProperties;
  return out;
}

const jsonSchemas = new WeakMap<SchemaAST.AST, JsonObject>();

const JSON_SCHEMA_OPTIONS = { includeAnnotationKey: (key: string) => key === STRICT } as const;

/** A schema's JSON Schema before `finishJsonSchema` (which runs on the whole document). */
function jsonSchemaOf(schema: Schema.Top): JsonObject {
  const document = Schema.toJsonSchemaDocument(schema, JSON_SCHEMA_OPTIONS);
  if (Object.keys(document.definitions).length > 0)
    throw new Error("Tool input schemas must not use identifier annotations ($defs)");
  return document.schema as JsonObject;
}

/**
 * The JSON Schema (draft 2020-12) `tools/list` publishes for a tool input:
 * the schema's encoded side, strict objects closed, other objects open.
 */
export function toolJsonSchema(schema: Schema.Top): JsonObject {
  let json = jsonSchemas.get(schema.ast);
  if (!json) {
    json = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...(finishJsonSchema(jsonSchemaOf(schema)) as JsonObject),
    };
    jsonSchemas.set(schema.ast, json);
  }
  return json;
}

type StandardIssue = { readonly message: string; readonly path?: ReadonlyArray<PropertyKey> };

/**
 * A tool's input as the MCP SDK's `StandardSchemaWithJSON`. The SDK lists the
 * JSON Schema and validates each call with the schema; the handler receives
 * the decoded value.
 */
export function toolInput<S extends Schema.Top>(schema: S): ToolInput<S["Encoded"], S["Type"]> {
  return {
    "~standard": {
      version: 1,
      vendor: "effect",
      validate: (value) => {
        const result = decodeResult(schema, value);
        return result.success
          ? { value: result.data }
          : { issues: schemaErrorIssues(result.error) };
      },
      jsonSchema: {
        input: () => toolJsonSchema(schema),
        output: () => toolJsonSchema(schema),
      },
    },
  };
}

/** Structurally the SDK's `StandardSchemaWithJSON<Input, Output>`. */
export interface ToolInput<Input, Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: ReadonlyArray<StandardIssue> };
    readonly jsonSchema: {
      readonly input: (options: { readonly target: string }) => Record<string, unknown>;
      readonly output: (options: { readonly target: string }) => Record<string, unknown>;
    };
  };
}

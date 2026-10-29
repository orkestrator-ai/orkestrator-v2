/**
 * Type checking on edges (report §5.7, §5.10): assignability, the result type
 * of each edge transform, and the named built-in adapters.
 *
 * The compiler (item 107) and the designer call these. They answer "may a
 * value of type A reach a port of type B, and through what". Cardinality
 * (fan-in to a list port, zip between replicated nodes) is the compiler's: a
 * replicated producer's output is lifted to `list<T>` before it asks here.
 *
 * Assignability is nominal first: the same name and major version always fit.
 * A structural fit is allowed only where it is safe: the target has no domain
 * validator (a structural match would skip it, breaking invariant 4), both
 * sides store the same way, and every value the source schema accepts the
 * target schema accepts too. Every subset object forbids unknown fields, so a
 * structural fit means the same fields with values at least as narrow; extra
 * fields need a `pick`. Budgets cannot always be proven statically (a
 * flattened element inherits its whole parent's byte budget), so a structural
 * fit whose budgets do not provably fit carries `budgetCheck: true`: the
 * runtime checks the target's budgets (`graphBudgetIssues`) as the value
 * crosses the edge, and fails the consuming activation if they are exceeded.
 */
import { formatStructuredReviewReport } from "../structured-review.js";
import { isPlainRecord } from "../field-validation.js";
import type { ArtifactTypeBudgets, GraphJsonSchema } from "./artifact-type-def.js";
import type { GraphEdgeTransform } from "./template-model.js";
import {
  graphSchemaAtPath,
  graphSchemaNonNull,
  validateGraphSchemaValue,
} from "./schema-subset.js";
import {
  type GraphTicketV1,
  type GraphTypeDefinition,
  GraphTypeLibrary,
  type GraphValueType,
  graphValueTypeElement,
  graphValueTypeLabel,
} from "./types.js";

// ---------------------------------------------------------- schema subtype

export type GraphSchemaSubtypeResult = { ok: true } | { ok: false; path: string; message: string };

const OK: GraphSchemaSubtypeResult = { ok: true };

function fail(path: string, message: string): GraphSchemaSubtypeResult {
  return { ok: false, path, message };
}

function branches(schema: GraphJsonSchema): GraphJsonSchema[] {
  return Array.isArray(schema.anyOf)
    ? schema.anyOf.filter((branch): branch is GraphJsonSchema => isPlainRecord(branch))
    : [schema];
}

/** Literal values a schema allows, when it allows only literals. */
function literals(schema: GraphJsonSchema): unknown[] | undefined {
  if (schema.const !== undefined) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

function boundFits(
  source: GraphJsonSchema,
  target: GraphJsonSchema,
  key: "minimum" | "maximum",
): boolean {
  const limit = target[key];
  if (typeof limit !== "number") return true;
  const bound = source[key];
  if (typeof bound !== "number") return false;
  return key === "minimum" ? bound >= limit : bound <= limit;
}

/**
 * True when every value `source` accepts, `target` accepts too. Conservative:
 * a `false` may be a pair that happens to fit, never the other way round.
 * Both schemas are inside the subset (`schema-subset.ts`).
 */
export function isGraphSchemaSubtype(
  source: GraphJsonSchema,
  target: GraphJsonSchema,
  path = "$",
): GraphSchemaSubtypeResult {
  // A source union fits when every branch does; a target union when one does.
  if (Array.isArray(source.anyOf)) {
    for (const branch of branches(source)) {
      const result = isGraphSchemaSubtype(branch, target, path);
      if (!result.ok) return result;
    }
    return OK;
  }
  if (Array.isArray(target.anyOf)) {
    let first: GraphSchemaSubtypeResult | undefined;
    for (const branch of branches(target)) {
      const result = isGraphSchemaSubtype(source, branch, path);
      if (result.ok) return OK;
      first ??= result;
    }
    return first ?? fail(path, "No branch of the target accepts the source");
  }

  const sourceLiterals = literals(source);
  if (sourceLiterals) {
    // Every literal the source allows must validate against the target.
    return sourceLiterals.every((value) => validateGraphSchemaValue(target, value).length === 0)
      ? OK
      : fail(path, "A value the source allows is not allowed by the target");
  }
  if (literals(target)) return fail(path, "The target allows only specific values");

  const sourceType = source.type;
  const targetType = target.type;
  if (sourceType !== targetType && !(sourceType === "integer" && targetType === "number")) {
    return fail(path, `Expected ${String(targetType)}, the source has ${String(sourceType)}`);
  }
  switch (targetType) {
    case "number":
    case "integer":
      return boundFits(source, target, "minimum") && boundFits(source, target, "maximum")
        ? OK
        : fail(path, "The source allows numbers outside the target's range");
    case "array":
      return isPlainRecord(source.items) && isPlainRecord(target.items)
        ? isGraphSchemaSubtype(source.items, target.items, `${path}[]`)
        : fail(path, "Array items are not described");
    case "object": {
      const sourceProperties = isPlainRecord(source.properties) ? source.properties : {};
      const targetProperties = isPlainRecord(target.properties) ? target.properties : {};
      const sourceRequired = new Set(Array.isArray(source.required) ? source.required : []);
      const targetRequired = Array.isArray(target.required) ? target.required : [];
      for (const key of targetRequired) {
        if (typeof key === "string" && !sourceRequired.has(key)) {
          return fail(`${path}.${key}`, "The target requires a field the source may omit");
        }
      }
      for (const key of Object.keys(sourceProperties)) {
        if (target.additionalProperties === false && !Object.hasOwn(targetProperties, key)) {
          return fail(`${path}.${key}`, "The source has a field the target does not allow");
        }
      }
      for (const [key, targetProperty] of Object.entries(targetProperties)) {
        if (!isPlainRecord(targetProperty)) continue;
        const sourceProperty = sourceProperties[key];
        if (sourceProperty === undefined) {
          if (source.additionalProperties !== false) {
            return fail(`${path}.${key}`, "The source does not constrain this field");
          }
          continue;
        }
        if (!isPlainRecord(sourceProperty)) return fail(`${path}.${key}`, "Invalid source schema");
        const result = isGraphSchemaSubtype(sourceProperty, targetProperty, `${path}.${key}`);
        if (!result.ok) return result;
      }
      return OK;
    }
    default:
      return OK;
  }
}

// ------------------------------------------------------------ assignability

export type GraphAssignabilityCode =
  "cardinality" | "version_mismatch" | "nominal_target" | "storage_mismatch" | "schema_mismatch";

export type GraphAssignability =
  | { ok: true; via: "identical" }
  | { ok: true; via: "structural"; budgetCheck: boolean }
  | { ok: false; code: GraphAssignabilityCode; message: string; path?: string };

/** True when every value within the source's budgets is within the target's. */
function budgetsFit(source: ArtifactTypeBudgets, target: ArtifactTypeBudgets): boolean {
  if (source.maxBytes > target.maxBytes) return false;
  return (["maxStringBytes", "maxItems"] as const).every((key) => {
    const limit = target[key];
    const bound = source[key];
    return limit === undefined || (bound !== undefined && bound <= limit);
  });
}

function scalarParts(type: Exclude<GraphValueType, { kind: "list" }>): {
  schema: GraphJsonSchema;
  budgets: ArtifactTypeBudgets;
  storage: "value" | "reference";
} {
  return type.kind === "named"
    ? {
        schema: type.definition.schema,
        budgets: type.definition.budgets,
        storage: type.definition.storage,
      }
    : { schema: type.schema, budgets: type.budgets, storage: "value" };
}

/** May a value of `source` type reach a port of `target` type (report §5.10)? */
export function graphTypeAssignability(
  source: GraphValueType,
  target: GraphValueType,
): GraphAssignability {
  if (source.kind === "list" || target.kind === "list") {
    if (source.kind === "list" && target.kind === "list") {
      return graphTypeAssignability(source.element, target.element);
    }
    return {
      ok: false,
      code: "cardinality",
      message: `${graphValueTypeLabel(source)} is ${source.kind === "list" ? "a list" : "one value"}; ${graphValueTypeLabel(target)} is ${target.kind === "list" ? "a list" : "one value"}`,
    };
  }
  if (source.kind === "named" && target.kind === "named") {
    const from = source.definition;
    const to = target.definition;
    if (from.name === to.name && from.version === to.version && from.builtIn === to.builtIn) {
      return { ok: true, via: "identical" };
    }
    if (from.name === to.name) {
      return {
        ok: false,
        code: "version_mismatch",
        message: `${from.ref} and ${to.ref} are different major versions`,
      };
    }
  }
  if (target.kind === "named" && target.definition.validator) {
    return {
      ok: false,
      code: "nominal_target",
      message: `${target.definition.ref} has domain checks, so only ${target.definition.ref} itself (or an adapter to it) fits`,
    };
  }
  const from = scalarParts(source);
  const to = scalarParts(target);
  if (from.storage !== to.storage) {
    return {
      ok: false,
      code: "storage_mismatch",
      message: `${graphValueTypeLabel(source)} is stored by ${from.storage}, ${graphValueTypeLabel(target)} by ${to.storage}`,
    };
  }
  const schema = isGraphSchemaSubtype(from.schema, to.schema);
  if (!schema.ok) {
    return { ok: false, code: "schema_mismatch", message: schema.message, path: schema.path };
  }
  return { ok: true, via: "structural", budgetCheck: !budgetsFit(from.budgets, to.budgets) };
}

// ----------------------------------------------------------------- adapters

export interface GraphTypeAdapter {
  /** Kebab-case; what a template's `adapt` transform names. */
  id: string;
  label: string;
  description: string;
  /** `name@major`. */
  from: string;
  /** `name@major` or `list<name@major>`. */
  to: string;
  /** Pure and total on a valid `from` value; the result is a valid `to` value. */
  apply: (value: unknown) => unknown;
}

function field<T>(value: unknown, key: string): T {
  return (value as Record<string, unknown>)[key] as T;
}

function ticketMarkdown(ticket: GraphTicketV1): string {
  const criteria = ticket.criteria.map((entry) => `- ${entry.id}: ${entry.text}`).join("\n");
  return [
    `# ${ticket.title}`,
    ticket.description,
    criteria ? `## Acceptance criteria\n\n${criteria}` : "",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
}

const ADAPTERS: readonly GraphTypeAdapter[] = Object.freeze([
  {
    id: "review-report-to-finding-list",
    label: "Report → findings",
    description: "The report's issues, one finding each, in report order.",
    from: "review-report@1",
    to: "list<finding@1>",
    apply: (value) => [...field<unknown[]>(value, "issues")],
  },
  {
    id: "review-report-to-markdown",
    label: "Report → Markdown",
    description: "The report formatted as the review view shows it.",
    from: "review-report@1",
    to: "markdown@1",
    apply: (value) => ({ markdown: formatStructuredReviewReport(value) }),
  },
  {
    id: "ticket-to-markdown",
    label: "Ticket → Markdown",
    description: "Title, description and acceptance criteria as Markdown.",
    from: "ticket@1",
    to: "markdown@1",
    apply: (value) => ({ markdown: ticketMarkdown(value as GraphTicketV1) }),
  },
  {
    id: "fix-result-to-file-list",
    label: "Fix result → files",
    description: "The files a fix or build changed, each with the fix summary as its reason.",
    from: "fix-result@1",
    to: "file-list@1",
    apply: (value) => ({
      files: field<string[]>(value, "filesChanged").map((path) => ({
        path,
        reason: field<string>(value, "summary"),
      })),
    }),
  },
  {
    id: "text-to-markdown",
    label: "Text → Markdown",
    description: "Plain text used as a Markdown document.",
    from: "text@1",
    to: "markdown@1",
    apply: (value) => ({ markdown: field<string>(value, "text") }),
  },
  {
    id: "markdown-to-text",
    label: "Markdown → text",
    description: "A Markdown document used as plain text.",
    from: "markdown@1",
    to: "text@1",
    apply: (value) => ({ text: field<string>(value, "markdown") }),
  },
] satisfies GraphTypeAdapter[]);

const ADAPTER_BY_ID = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function graphTypeAdapters(): readonly GraphTypeAdapter[] {
  return ADAPTERS;
}

export function graphTypeAdapter(id: string): GraphTypeAdapter | undefined {
  return ADAPTER_BY_ID.get(id);
}

/**
 * Run an adapter on a value of its source type, or on a list of them: a list
 * is adapted element by element, and list-producing adapters concatenate
 * their results (`list<review-report@1>` → `list<finding@1>`).
 */
export function applyGraphTypeAdapter(
  adapter: GraphTypeAdapter,
  value: unknown,
  listDepth = 0,
): unknown {
  if (listDepth === 0) return adapter.apply(value);
  const mapped = (value as unknown[]).map((entry) =>
    applyGraphTypeAdapter(adapter, entry, listDepth - 1),
  );
  return listDepth === 1 && adapter.to.startsWith("list<") ? mapped.flat() : mapped;
}

// ------------------------------------------------------------ transforms

export type GraphTransformCode =
  | "requires_list"
  | "unknown_field"
  | "not_an_object"
  | "not_a_list"
  | "too_deep"
  | "unknown_adapter"
  | "adapter_mismatch";

export type GraphTransformResult =
  { ok: true; type: GraphValueType } | { ok: false; code: GraphTransformCode; message: string };

function shapeOf(type: Exclude<GraphValueType, { kind: "list" }>): {
  schema: GraphJsonSchema;
  budgets: ArtifactTypeBudgets;
} {
  return type.kind === "named"
    ? { schema: type.definition.schema, budgets: type.definition.budgets }
    : { schema: type.schema, budgets: type.budgets };
}

function wrap(element: GraphValueType, listDepth: number): GraphValueType {
  let type = element;
  for (let depth = 0; depth < listDepth; depth++) type = { kind: "list", element: type };
  return type;
}

/** Keep only `fields` (dotted paths), preserving the object structure on the way. */
function project(
  schema: GraphJsonSchema,
  fields: readonly string[],
):
  { ok: true; schema: GraphJsonSchema } | { ok: false; code: GraphTransformCode; message: string } {
  const tree = new Map<string, Map<string, unknown> | true>();
  for (const path of fields) {
    if (!graphSchemaAtPath(schema, path)) {
      return { ok: false, code: "unknown_field", message: `The source has no field ${path}` };
    }
    let node = tree;
    const segments = path.split(".");
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        node.set(segment, true);
        return;
      }
      const existing = node.get(segment);
      if (existing === true) return;
      const child = existing ?? new Map<string, Map<string, unknown> | true>();
      node.set(segment, child);
      node = child as Map<string, Map<string, unknown> | true>;
    });
  }
  const build = (current: GraphJsonSchema, picks: Map<string, unknown>): GraphJsonSchema => {
    const { schema: object, nullable } = graphSchemaNonNull(current);
    const properties = object.properties as Record<string, GraphJsonSchema>;
    const picked: Record<string, GraphJsonSchema> = {};
    for (const [key, sub] of picks) {
      picked[key] =
        sub === true ? properties[key]! : build(properties[key]!, sub as Map<string, unknown>);
    }
    const result: GraphJsonSchema = {
      type: "object",
      additionalProperties: false,
      required: Object.keys(picked),
      properties: picked,
    };
    return nullable ? { anyOf: [result, { type: "null" }] } : result;
  };
  return { ok: true, schema: build(schema, tree as Map<string, unknown>) };
}

/**
 * The type an edge transform produces from `source` (report §5.7). `pick`
 * projects one value (or each element of a list); `filter` and `limit` keep a
 * list's type; `flatten` concatenates the list at `path` of one value or of
 * every element, naming the element type when the path is the source type's
 * `items` list; `adapt` runs a named adapter, lifted over a list.
 * `filter`'s predicate is type-checked by item 104 against the element type.
 */
export function graphEdgeTransformResultType(
  source: GraphValueType,
  transform: GraphEdgeTransform,
  library: GraphTypeLibrary,
): GraphTransformResult {
  const { element, listDepth } = graphValueTypeElement(source);
  switch (transform.op) {
    case "filter":
    case "limit":
      return listDepth > 0
        ? { ok: true, type: source }
        : {
            ok: false,
            code: "requires_list",
            message: `${transform.op} applies to a list; ${graphValueTypeLabel(source)} is one value`,
          };
    case "pick": {
      const { schema, budgets } = shapeOf(element);
      const projected = project(schema, transform.fields);
      if (!projected.ok) return projected;
      const origin = `pick(${graphValueTypeLabel(element)}: ${transform.fields.join(", ")})`;
      return {
        ok: true,
        type: wrap(
          { kind: "shape", schema: projected.schema, budgets: { ...budgets }, origin },
          listDepth,
        ),
      };
    }
    case "flatten": {
      if (listDepth > 1) {
        return {
          ok: false,
          code: "too_deep",
          message: "flatten applies to one value or a list of values, not a list of lists",
        };
      }
      const { schema, budgets } = shapeOf(element);
      const target = graphSchemaAtPath(schema, transform.path);
      if (!target) {
        return {
          ok: false,
          code: "unknown_field",
          message: `The source has no field ${transform.path}`,
        };
      }
      if (target.schema.type !== "array" || !isPlainRecord(target.schema.items)) {
        return { ok: false, code: "not_a_list", message: `${transform.path} is not a list` };
      }
      const definition: GraphTypeDefinition | undefined =
        element.kind === "named" ? element.definition : undefined;
      if (definition?.items?.path === transform.path && definition.itemType) {
        const named = library.resolve(definition.itemType);
        if (named.ok) return { ok: true, type: { kind: "list", element: named.type } };
      }
      return {
        ok: true,
        type: {
          kind: "list",
          element: {
            kind: "shape",
            schema: target.schema.items,
            budgets: { ...budgets },
            origin: `${graphValueTypeLabel(element)}.${transform.path}[]`,
          },
        },
      };
    }
    case "adapt": {
      const adapter = graphTypeAdapter(transform.adapter);
      if (!adapter) {
        return {
          ok: false,
          code: "unknown_adapter",
          message: `Unknown adapter ${transform.adapter}`,
        };
      }
      const from = library.resolve(adapter.from);
      const to = library.resolve(adapter.to);
      if (!from.ok || !to.ok) {
        return {
          ok: false,
          code: "unknown_adapter",
          message: `Adapter ${adapter.id} is unavailable`,
        };
      }
      const fits = listDepth <= 1 && graphTypeAssignability(element, from.type).ok;
      if (!fits) {
        return {
          ok: false,
          code: "adapter_mismatch",
          message: `${adapter.id} adapts ${adapter.from}, not ${graphValueTypeLabel(source)}`,
        };
      }
      if (listDepth === 0) return { ok: true, type: to.type };
      // A list-producing adapter over a list concatenates its results.
      return {
        ok: true,
        type: to.type.kind === "list" ? to.type : { kind: "list", element: to.type },
      };
    }
  }
}

/** Apply an edge's transforms in order; the first failure names its index. */
export function graphEdgeTransformsResultType(
  source: GraphValueType,
  transforms: readonly GraphEdgeTransform[],
  library: GraphTypeLibrary,
): GraphTransformResult & { index?: number } {
  let current = source;
  for (const [index, transform] of transforms.entries()) {
    const result = graphEdgeTransformResultType(current, transform, library);
    if (!result.ok) return { ...result, index };
    current = result.type;
  }
  return { ok: true, type: current };
}

/**
 * Adapters that would make `source` fit `target`, for the designer to offer
 * when an edge does not type-check.
 */
export function suggestGraphTypeAdapters(
  source: GraphValueType,
  target: GraphValueType,
  library: GraphTypeLibrary,
): GraphTypeAdapter[] {
  return ADAPTERS.filter((adapter) => {
    const result = graphEdgeTransformResultType(
      source,
      { op: "adapt", adapter: adapter.id },
      library,
    );
    return result.ok && graphTypeAssignability(result.type, target).ok;
  });
}

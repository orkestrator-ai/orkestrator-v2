/**
 * The predicate type checker (plan P1.4, report §5.10 "Condition paths").
 *
 * A predicate is checked against a *scope*: the roots its paths may start at
 * and the schema of each root's value. The compiler (107) builds one scope per
 * place a predicate appears and calls {@link checkGraphPredicateTypes}:
 *
 * - node `when` and gate branches: {@link graphNodePredicateScope} over the
 *   node's input ports (typed by the producer, so a `decision@1` port can carry
 *   the producer's `choices`), plus `params` and `run`;
 * - loop `until`: {@link graphLoopPredicateScope} over `<nodeId>.<port>` of the
 *   outputs produced inside the region, plus `params` and `run`;
 * - edge `filter`: {@link graphFilterPredicateScope} over one element of the
 *   list the filter receives (after earlier transforms on the edge).
 *
 * Every path must exist in its root's schema and have a type the operator
 * accepts; literals must fit the field's type and enum. Paths never enter a
 * list: `count`, `empty` and `nonEmpty` test a list, and a `filter` transform
 * on the edge selects its elements.
 */
import {
  FieldErrorCollector,
  type FieldValidation,
  isPlainRecord,
  joinPath,
} from "../field-validation.js";
import type { GraphJsonSchema } from "./artifact-type-def.js";
import {
  GRAPH_PREDICATE_RESERVED_ROOTS,
  type GraphLeafPredicate,
  type GraphPredicate,
  type GraphPredicateScalar,
  checkGraphPredicate,
  splitGraphPredicatePath,
} from "./predicate-shape.js";
import { graphSchemaNonNull } from "./schema-subset.js";
import type { GraphParameter } from "./template-model.js";
import {
  type GraphTypeLibrary,
  type GraphValueType,
  graphDecisionSchema,
  graphValueTypeElement,
  graphValueTypeLabel,
} from "./types.js";

/** Diagnostic codes of the type checker (structural codes come from the guard). */
export const GRAPH_PREDICATE_TYPE_CODES = [
  "unknown_root",
  "shadowed_root",
  "unknown_path",
  "through_list",
  "operator_type",
  "value_type",
  "enum_value",
  "requires_list",
] as const;
export type GraphPredicateTypeCode = (typeof GRAPH_PREDICATE_TYPE_CODES)[number];

export type GraphPredicateRootKind = "input" | "output" | "params" | "run";

/** One root a path may start at. */
export interface GraphPredicateRoot {
  /** As paths write it: `report`, `verify.verdict`, `params`, `run`. */
  name: string;
  kind: GraphPredicateRootKind;
  /**
   * The schema of the root's value (an array schema for a list port). Null
   * when the port's type did not resolve: the compiler reports that at the
   * port, so paths under the root are not checked again.
   */
  schema: GraphJsonSchema | null;
  /** For messages: `review-report@1`, `list<finding@1>`, `launch parameters`. */
  label: string;
}

export type GraphPredicateScope =
  | {
      kind: "roots";
      roots: readonly GraphPredicateRoot[];
      /** Port or node-port names a reserved root (`params`, `run`) hides. */
      shadowed?: readonly string[];
    }
  | {
      /** Paths are relative to one list element (edge `filter`). */
      kind: "element";
      /** Null when the element type did not resolve; nothing is checked. */
      schema: GraphJsonSchema | null;
      label: string;
    };

/** A port a scope exposes as a root. */
export interface GraphPredicatePortRoot {
  /** Root name: the input port name, or `<nodeId>.<port>` for a loop's `until`. */
  name: string;
  /** A type reference, or a type the compiler resolved (after edge transforms). */
  type: string | GraphValueType;
  /** The producing port's `choices`; narrows `choice` of a `decision` type. */
  choices?: readonly string[];
}

// ------------------------------------------------------------------ scopes

/** The schema a value of `type` satisfies; a list becomes an array schema. */
export function graphPredicateTypeSchema(type: GraphValueType): GraphJsonSchema {
  switch (type.kind) {
    case "named":
      return type.definition.schema;
    case "shape":
      return type.schema;
    case "list":
      return { type: "array", items: graphPredicateTypeSchema(type.element) };
  }
}

/** `params`: one property per launch parameter, never null (the launcher asks). */
export function graphParamsPredicateSchema(parameters: readonly GraphParameter[]): GraphJsonSchema {
  const properties: Record<string, GraphJsonSchema> = {};
  for (const parameter of parameters) {
    switch (parameter.type) {
      case "boolean":
        properties[parameter.key] = { type: "boolean" };
        break;
      case "integer":
      case "number":
        properties[parameter.key] = {
          type: parameter.type,
          ...(parameter.min !== undefined ? { minimum: parameter.min } : {}),
          ...(parameter.max !== undefined ? { maximum: parameter.max } : {}),
        };
        break;
      case "string":
        properties[parameter.key] = { type: "string" };
        break;
      case "enum":
        properties[parameter.key] = { type: "string", enum: [...parameter.options] };
        break;
    }
  }
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/** `run`: the loop iteration, 1 outside loops and on a loop's first pass. */
export const GRAPH_RUN_PREDICATE_SCHEMA: GraphJsonSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["iteration"],
  properties: Object.freeze({ iteration: Object.freeze({ type: "integer", minimum: 1 }) }),
});

function portRootSchema(
  port: GraphPredicatePortRoot,
  library: GraphTypeLibrary,
): { schema: GraphJsonSchema | null; label: string } {
  let type: GraphValueType;
  if (typeof port.type === "string") {
    const resolved = library.resolve(port.type);
    if (!resolved.ok) return { schema: null, label: port.type };
    type = resolved.type;
  } else {
    type = port.type;
  }
  const label = graphValueTypeLabel(type);
  if (port.choices && port.choices.length > 0) {
    const { element, listDepth } = graphValueTypeElement(type);
    if (element.kind === "named" && element.definition.name === "decision") {
      let schema = graphDecisionSchema(port.choices);
      for (let depth = 0; depth < listDepth; depth++) schema = { type: "array", items: schema };
      return { schema, label };
    }
  }
  return { schema: graphPredicateTypeSchema(type), label };
}

function rootsScope(
  ports: readonly GraphPredicatePortRoot[],
  kind: "input" | "output",
  parameters: readonly GraphParameter[],
  library: GraphTypeLibrary,
): GraphPredicateScope {
  const reserved: readonly string[] = GRAPH_PREDICATE_RESERVED_ROOTS;
  const roots: GraphPredicateRoot[] = [];
  const shadowed: string[] = [];
  const seen = new Set<string>();
  for (const port of ports) {
    if (reserved.includes(port.name)) {
      shadowed.push(port.name);
      continue;
    }
    if (seen.has(port.name)) continue;
    seen.add(port.name);
    roots.push({ name: port.name, kind, ...portRootSchema(port, library) });
  }
  roots.push(
    {
      name: "params",
      kind: "params",
      schema: graphParamsPredicateSchema(parameters),
      label: "launch parameters",
    },
    { name: "run", kind: "run", schema: GRAPH_RUN_PREDICATE_SCHEMA, label: "the run" },
  );
  return { kind: "roots", roots, ...(shadowed.length > 0 ? { shadowed } : {}) };
}

/** Scope of a node's `when` or a gate branch: the node's input ports. */
export function graphNodePredicateScope(
  inputs: readonly GraphPredicatePortRoot[],
  parameters: readonly GraphParameter[],
  library: GraphTypeLibrary,
): GraphPredicateScope {
  return rootsScope(inputs, "input", parameters, library);
}

/** Scope of a loop's `until`: outputs produced inside the region, as `<nodeId>.<port>`. */
export function graphLoopPredicateScope(
  outputs: readonly (Omit<GraphPredicatePortRoot, "name"> & { node: string; port: string })[],
  parameters: readonly GraphParameter[],
  library: GraphTypeLibrary,
): GraphPredicateScope {
  return rootsScope(
    outputs.map(({ node, port, ...rest }) => ({ ...rest, name: `${node}.${port}` })),
    "output",
    parameters,
    library,
  );
}

/**
 * Scope of an edge `filter`: one element of `list`, the type the filter
 * receives. A non-list is `requires_list` (the transform type check also says
 * so) and checks nothing.
 */
export function graphFilterPredicateScope(
  list: GraphValueType,
):
  | { ok: true; scope: GraphPredicateScope }
  | { ok: false; code: "requires_list"; message: string; scope: GraphPredicateScope } {
  if (list.kind !== "list") {
    const label = graphValueTypeLabel(list);
    return {
      ok: false,
      code: "requires_list",
      message: `filter applies to a list; ${label} is one value`,
      scope: { kind: "element", schema: null, label },
    };
  }
  return {
    ok: true,
    scope: {
      kind: "element",
      schema: graphPredicateTypeSchema(list.element),
      label: graphValueTypeLabel(list.element),
    },
  };
}

// ------------------------------------------------------------ field info

type ScalarKind = "string" | "number" | "boolean";

/** What a resolved field may hold. `types: null` means unconstrained. */
interface FieldInfo {
  types: Set<string> | null;
  nullable: boolean;
  /** Allowed literals per scalar kind; a kind absent here is unconstrained. */
  values: Map<ScalarKind, Set<GraphPredicateScalar>>;
  integerOnly: boolean;
}

function scalarKindOf(type: string): ScalarKind | null {
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  return null;
}

function fieldInfo(schema: GraphJsonSchema): FieldInfo {
  const unwrapped = graphSchemaNonNull(schema);
  let nullable = unwrapped.nullable;
  const branches: GraphJsonSchema[] = Array.isArray(unwrapped.schema.anyOf)
    ? unwrapped.schema.anyOf.filter(isPlainRecord)
    : [unwrapped.schema];
  let types: Set<string> | null = new Set();
  const constrained = new Map<ScalarKind, Set<GraphPredicateScalar>>();
  const unconstrained = new Set<ScalarKind>();
  let sawNumber = false;
  for (const branch of branches) {
    if (typeof branch.type !== "string") {
      types = null;
      continue;
    }
    if (branch.type === "null") {
      nullable = true;
      continue;
    }
    types?.add(branch.type);
    if (branch.type === "number") sawNumber = true;
    const kind = scalarKindOf(branch.type);
    if (!kind) continue;
    const listed = Array.isArray(branch.enum)
      ? branch.enum
      : Object.hasOwn(branch, "const")
        ? [branch.const]
        : null;
    if (!listed) {
      unconstrained.add(kind);
      continue;
    }
    const set = constrained.get(kind) ?? new Set<GraphPredicateScalar>();
    for (const entry of listed) set.add(entry as GraphPredicateScalar);
    constrained.set(kind, set);
  }
  for (const kind of unconstrained) constrained.delete(kind);
  return {
    types,
    nullable,
    values: constrained,
    integerOnly: types !== null && types.has("integer") && !sawNumber,
  };
}

const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;

function hasAny(info: FieldInfo, types: readonly string[]): boolean {
  return info.types === null || types.some((type) => info.types!.has(type));
}

function describe(info: FieldInfo): string {
  if (info.types === null) return "any value";
  const names = [...info.types].map((type) =>
    type === "array"
      ? "a list"
      : type === "object"
        ? "an object"
        : type === "integer"
          ? "an integer"
          : `a ${type}`,
  );
  if (info.nullable) names.push("null");
  return names.length > 0 ? names.join(" or ") : "null";
}

function describeSchema(schema: GraphJsonSchema): string {
  return describe(fieldInfo(schema));
}

function quote(value: GraphPredicateScalar): string {
  return typeof value === "string" ? JSON.stringify(value.slice(0, 64)) : String(value);
}

function listValues(values: Iterable<GraphPredicateScalar>): string {
  const all = [...values];
  const shown = all.slice(0, 12).map(quote).join(", ");
  return all.length > 12 ? `${shown}, … (${all.length} in all)` : shown;
}

// ---------------------------------------------------------------- checking

interface ResolvedPath {
  field: GraphJsonSchema;
}

function resolvePath(
  leaf: GraphLeafPredicate,
  scope: GraphPredicateScope,
  path: string,
  errors: FieldErrorCollector,
): ResolvedPath | null {
  const pathPath = joinPath(path, "path");
  const segments = leaf.path.split(".");
  let schema: GraphJsonSchema | null;
  let walked: string;
  let fields: string[];
  if (scope.kind === "element") {
    schema = scope.schema;
    walked = `the ${scope.label} element`;
    fields = segments;
  } else {
    const byName = new Map(scope.roots.map((root) => [root.name, root]));
    const split = splitGraphPredicatePath(segments, (name) => byName.has(name));
    const root = split ? byName.get(split.root) : undefined;
    if (!split || !root) {
      const known = scope.roots.map((entry) => entry.name);
      errors.add(
        pathPath,
        "unknown_root",
        `${segments[0]} is not in scope here; paths start at ${known.slice(0, 16).join(", ")}`,
      );
      return null;
    }
    if (scope.shadowed?.includes(split.root)) {
      errors.add(
        pathPath,
        "shadowed_root",
        `${split.root} names the reserved root, not the port of that name; rename the port`,
      );
    }
    schema = root.schema;
    walked = root.name;
    fields = split.fields;
  }
  if (schema === null) return null;
  let current = schema;
  for (const segment of fields) {
    const { schema: object } = graphSchemaNonNull(current);
    if (object.type === "array") {
      errors.add(
        pathPath,
        "through_list",
        `${walked} is a list; paths do not enter lists. Use count, empty or nonEmpty on it, or a filter transform on the edge`,
      );
      return null;
    }
    const properties = object.properties;
    if (object.type !== "object" || !isPlainRecord(properties)) {
      errors.add(
        pathPath,
        "unknown_path",
        `${walked} is ${describeSchema(current)} and has no field ${segment}`,
      );
      return null;
    }
    const next = Object.hasOwn(properties, segment) ? properties[segment] : undefined;
    if (!isPlainRecord(next)) {
      const known = Object.keys(properties);
      errors.add(
        pathPath,
        "unknown_path",
        `${walked} has no field ${segment}; its fields are ${known.slice(0, 16).join(", ") || "none"}`,
      );
      return null;
    }
    current = next;
    walked = `${walked}.${segment}`;
  }
  return { field: current };
}

/** Check one literal against the field; `at` is the literal's diagnostic path. */
function checkLiteral(
  value: GraphPredicateScalar,
  info: FieldInfo,
  fieldPath: string,
  at: string,
  errors: FieldErrorCollector,
): void {
  if (value === null) {
    if (!info.nullable && info.types !== null) {
      errors.add(at, "value_type", `${fieldPath} is never null; use exists to test for a value`);
    }
    return;
  }
  if (info.types === null) return;
  const kind = typeof value as ScalarKind;
  const fits =
    kind === "number"
      ? info.types.has("number") || (info.types.has("integer") && Number.isInteger(value))
      : info.types.has(kind);
  if (!fits) {
    const why =
      kind === "number" && info.types.has("integer")
        ? `${fieldPath} is an integer, so it never equals ${quote(value)}`
        : `${fieldPath} is ${describe(info)}; ${quote(value)} is a ${kind}`;
    errors.add(at, "value_type", why);
    return;
  }
  const allowed = info.values.get(kind);
  if (allowed && !allowed.has(value)) {
    errors.add(
      at,
      "enum_value",
      `${quote(value)} is not a value of ${fieldPath}; it is one of ${listValues(allowed)}`,
    );
  }
}

function checkLeaf(
  leaf: GraphLeafPredicate,
  scope: GraphPredicateScope,
  path: string,
  errors: FieldErrorCollector,
): void {
  const resolved = resolvePath(leaf, scope, path, errors);
  if (!resolved) return;
  const info = fieldInfo(resolved.field);
  const opPath = joinPath(path, "op");
  const valuePath = joinPath(path, "value");
  const mismatch = (expects: string) =>
    errors.add(opPath, "operator_type", `${leaf.op} ${expects}; ${leaf.path} is ${describe(info)}`);
  switch (leaf.op) {
    case "exists":
      return;
    case "empty":
    case "nonEmpty":
      if (!hasAny(info, ["array", "string"])) mismatch("tests a list or a string");
      return;
    case "count":
      if (!hasAny(info, ["array"])) mismatch("counts the elements of a list");
      return;
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (!hasAny(info, ["number", "integer"])) mismatch("compares numbers");
      return;
    case "eq":
    case "neq":
      if (leaf.value !== null && !hasAny(info, SCALAR_TYPES)) {
        mismatch("compares strings, numbers, booleans and null");
        return;
      }
      checkLiteral(leaf.value, info, leaf.path, valuePath, errors);
      return;
    case "in":
      if (!hasAny(info, SCALAR_TYPES)) {
        mismatch("matches strings, numbers, booleans and null");
        return;
      }
      leaf.value.forEach((entry, index) =>
        checkLiteral(entry, info, leaf.path, joinPath(valuePath, index), errors),
      );
      return;
  }
}

function checkNode(
  predicate: GraphPredicate,
  scope: GraphPredicateScope,
  path: string,
  errors: FieldErrorCollector,
): void {
  if ("all" in predicate) {
    predicate.all.forEach((child, index) =>
      checkNode(child, scope, joinPath(joinPath(path, "all"), index), errors),
    );
  } else if ("any" in predicate) {
    predicate.any.forEach((child, index) =>
      checkNode(child, scope, joinPath(joinPath(path, "any"), index), errors),
    );
  } else if ("not" in predicate) {
    checkNode(predicate.not, scope, joinPath(path, "not"), errors);
  } else {
    checkLeaf(predicate, scope, path, errors);
  }
}

/**
 * Type-check `predicate` at `path` (for example `nodes[3].when`) against
 * `scope`, adding diagnostics to `errors`. The structural guard runs first;
 * when it fails, its errors are reported and types are not checked.
 */
export function checkGraphPredicateTypes(
  predicate: unknown,
  scope: GraphPredicateScope,
  path: string,
  errors: FieldErrorCollector,
): void {
  const structural = new FieldErrorCollector();
  checkGraphPredicate(predicate, path, structural);
  if (structural.failed) {
    for (const error of structural.errors) errors.add(error.path, error.code, error.message);
    return;
  }
  checkNode(predicate as GraphPredicate, scope, path, errors);
}

/** {@link checkGraphPredicateTypes} with paths from the predicate's root. */
export function typeCheckGraphPredicate(
  predicate: unknown,
  scope: GraphPredicateScope,
): FieldValidation<GraphPredicate> {
  const errors = new FieldErrorCollector();
  checkGraphPredicateTypes(predicate, scope, "", errors);
  return errors.result(predicate as GraphPredicate);
}

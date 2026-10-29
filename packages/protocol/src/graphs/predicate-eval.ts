/**
 * The total predicate evaluator (plan P1.4): gates, `when`, loop `until` and
 * edge `filter` at run time (items 206 and 213).
 *
 * Total means it never throws and always answers a boolean, whatever the
 * predicate or the values: cyclic or hostile objects, accessors, proxies,
 * `__proto__` or `constructor` path segments, huge arrays, NaN. It re-checks
 * the predicate's shape and bounds itself (depth, node count, list and string
 * sizes) rather than trusting that a guard ran, and reads values only through
 * own data properties of plain objects, so a getter never runs and nothing is
 * read from a prototype.
 *
 * Logic is three-valued. A leaf whose value is missing, null where a list or
 * number is needed, or of a different primitive type than its literal is
 * *unknown*. `not` keeps unknown unknown; `all` is false if any child is false,
 * otherwise unknown if any is; `any` is true if any child is true, otherwise
 * unknown if any is. The decision is true only when the whole predicate is
 * true, so a missing or unknown value never makes a condition hold, even under
 * `not`. `exists` is the one leaf that is never unknown: test absence with
 * `{ not: { path, op: "exists" } }`.
 */
import {
  GRAPH_PLAN_ID_MAX_CHARS,
  GRAPH_PLAN_ID_PATTERN,
  GRAPH_TEMPLATE_BOUNDS as B,
  graphUtf8Bytes,
  isGraphFieldPath,
} from "./grammar.js";
import {
  GRAPH_PREDICATE_COMPARISONS,
  GRAPH_PREDICATE_OPS,
  type GraphPredicateComparison,
  type GraphPredicateOp,
  type GraphPredicateScalar,
  splitGraphPredicatePath,
} from "./predicate-shape.js";

export type GraphPredicateTruth = "true" | "false" | "unknown";

/** Why evaluation stopped before looking at any value; the decision is then false. */
export const GRAPH_PREDICATE_EVAL_ERROR_CODES = [
  "malformed",
  "too_deep",
  "too_many_nodes",
  "internal",
] as const;
export type GraphPredicateEvalErrorCode = (typeof GRAPH_PREDICATE_EVAL_ERROR_CODES)[number];

export interface GraphPredicateEvalError {
  code: GraphPredicateEvalErrorCode;
  message: string;
  /** Where in the predicate: `any[1].value`; `$` for the root. */
  at: string;
}

export interface GraphPredicateEvaluation {
  /** The decision: true only when the predicate definitely holds. */
  value: boolean;
  truth: GraphPredicateTruth;
  /** Paths (as written) whose value was missing or of the wrong type; at most 8. */
  unknownPaths: string[];
  error?: GraphPredicateEvalError;
}

/** The values a predicate reads, outside an edge filter. */
export interface GraphPredicateEnvironment {
  /** Root values by root name: input ports (`report`), or `<nodeId>.<port>` for `until`. */
  values?: Readonly<Record<string, unknown>> | ReadonlyMap<string, unknown>;
  /** Launch parameters by key: the `params` root. */
  params?: Readonly<Record<string, unknown>>;
  /** The `run` root: `{ iteration }`, 1-based. */
  run?: { iteration: number };
}

export const GRAPH_PREDICATE_MAX_UNKNOWN_PATHS = 8;

// ---------------------------------------------------------------- reading

const MISSING: unique symbol = Symbol("missing");
type Read = unknown | typeof MISSING;

function isPlainObject(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own data property of a plain object or an array; accessors are not run. */
function ownData(container: unknown, key: string): Read {
  if (!isPlainObject(container) && !Array.isArray(container)) return MISSING;
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  return descriptor && "value" in descriptor ? descriptor.value : MISSING;
}

/** Own enumerable data keys of a plain object, or null (accessors, too many keys). */
function plainEntries(value: unknown, maxKeys: number): Map<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length > maxKeys) return null;
  const entries = new Map<string, unknown>();
  for (const key of keys) {
    const read = ownData(value, key);
    if (read === MISSING) return null;
    entries.set(key, read);
  }
  return entries;
}

/** The elements of a bounded array as own data, or null. */
function boundedArray(value: unknown, max: number): Read[] | null {
  if (!Array.isArray(value)) return null;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length > max) return null;
  const items: Read[] = [];
  for (let index = 0; index < length; index++) items.push(ownData(value, String(index)));
  return items;
}

// -------------------------------------------------------------- preparing

type Prepared =
  | { kind: "all" | "any"; children: Prepared[] }
  | { kind: "not"; child: Prepared }
  | {
      kind: "leaf";
      path: string;
      segments: string[];
      op: GraphPredicateOp;
      value?: GraphPredicateScalar | GraphPredicateScalar[] | number;
      compare?: GraphPredicateComparison;
    };

class PrepareFailure {
  constructor(readonly error: GraphPredicateEvalError) {}
}

function fail(code: GraphPredicateEvalErrorCode, at: string, message: string): never {
  throw new PrepareFailure({ code, at: at || "$", message });
}

function at(base: string, key: string | number): string {
  return typeof key === "number" ? `${base}[${key}]` : base ? `${base}.${key}` : key;
}

function isScalar(value: unknown): value is GraphPredicateScalar {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= B.maxNumberAbs;
  return (
    typeof value === "string" &&
    value.length <= B.maxPredicateStringBytes &&
    graphUtf8Bytes(value) <= B.maxPredicateStringBytes
  );
}

const OPS: ReadonlySet<string> = new Set(GRAPH_PREDICATE_OPS);
const COMPARISONS: ReadonlySet<string> = new Set(GRAPH_PREDICATE_COMPARISONS);

function prepareNode(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): Prepared {
  if (depth > B.maxPredicateDepth) {
    fail("too_deep", path, `Predicates nest at most ${B.maxPredicateDepth} levels deep`);
  }
  if (++budget.nodes > B.maxPredicateNodes) {
    fail("too_many_nodes", path, `A predicate has at most ${B.maxPredicateNodes} nodes`);
  }
  const entries = plainEntries(value, 4);
  if (!entries) fail("malformed", path, "Expected a predicate object");
  const only = (keys: readonly string[]) =>
    entries.size === keys.length && keys.every((key) => entries.has(key));
  for (const kind of ["all", "any"] as const) {
    if (!entries.has(kind)) continue;
    if (!only([kind])) fail("malformed", path, `${kind} stands alone in its object`);
    const listPath = at(path, kind);
    const children = boundedArray(entries.get(kind), B.maxPredicateNodes);
    if (!children || children.length === 0) {
      fail("malformed", listPath, `Expected 1–${B.maxPredicateNodes} predicates`);
    }
    return {
      kind,
      children: children.map((child, index) =>
        prepareNode(child, at(listPath, index), depth + 1, budget),
      ),
    };
  }
  if (entries.has("not")) {
    if (!only(["not"])) fail("malformed", path, "not stands alone in its object");
    return {
      kind: "not",
      child: prepareNode(entries.get("not"), at(path, "not"), depth + 1, budget),
    };
  }
  const op = entries.get("op");
  if (typeof op !== "string" || !OPS.has(op)) fail("malformed", at(path, "op"), "Unknown operator");
  const leafPath = entries.get("path");
  if (!isGraphLeafPath(leafPath)) fail("malformed", at(path, "path"), "Expected a field path");
  const leaf = {
    kind: "leaf" as const,
    path: leafPath,
    segments: leafPath.split("."),
    op: op as GraphPredicateOp,
  };
  const valuePath = at(path, "value");
  const operand = entries.get("value");
  switch (op) {
    case "exists":
    case "empty":
    case "nonEmpty":
      if (!only(["path", "op"])) fail("malformed", path, `${op} takes only path and op`);
      return leaf;
    case "eq":
    case "neq":
      if (!only(["path", "op", "value"])) fail("malformed", path, `${op} takes path, op and value`);
      if (!isScalar(operand)) fail("malformed", valuePath, "Expected a bounded scalar");
      return { ...leaf, value: operand };
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      if (!only(["path", "op", "value"])) fail("malformed", path, `${op} takes path, op and value`);
      if (typeof operand !== "number" || !isScalar(operand)) {
        fail("malformed", valuePath, "Expected a finite number");
      }
      return { ...leaf, value: operand };
    case "in": {
      if (!only(["path", "op", "value"])) fail("malformed", path, "in takes path, op and value");
      const list = boundedArray(operand, B.maxPredicateListValues);
      if (!list || list.length === 0 || !list.every(isScalar)) {
        fail("malformed", valuePath, `Expected 1–${B.maxPredicateListValues} bounded scalars`);
      }
      return { ...leaf, value: list as GraphPredicateScalar[] };
    }
    case "count": {
      if (!only(["path", "op", "compare", "value"])) {
        fail("malformed", path, "count takes path, op, compare and value");
      }
      const compare = entries.get("compare");
      if (typeof compare !== "string" || !COMPARISONS.has(compare)) {
        fail("malformed", at(path, "compare"), "Unknown comparison");
      }
      if (
        !Number.isSafeInteger(operand) ||
        (operand as number) < 0 ||
        (operand as number) > B.maxArtifactItems
      ) {
        fail("malformed", valuePath, `Expected an integer from 0 to ${B.maxArtifactItems}`);
      }
      return { ...leaf, value: operand as number, compare: compare as GraphPredicateComparison };
    }
  }
  return fail("malformed", at(path, "op"), "Unknown operator");
}

type PrepareResult =
  { ok: true; prepared: Prepared } | { ok: false; error: GraphPredicateEvalError };

function prepare(predicate: unknown): PrepareResult {
  try {
    return { ok: true, prepared: prepareNode(predicate, "", 1, { nodes: 0 }) };
  } catch (error) {
    if (error instanceof PrepareFailure) return { ok: false, error: error.error };
    return { ok: false, error: internalError() };
  }
}

function internalError(): GraphPredicateEvalError {
  return { code: "internal", at: "$", message: "Evaluation stopped: a value could not be read" };
}

// ------------------------------------------------------------- evaluating

type Truth = boolean | null;

interface Run {
  /** Read the value a leaf path names; MISSING when it does not resolve. */
  resolve: (segments: readonly string[]) => Read;
  unknownPaths: string[];
}

function walk(root: Read, fields: readonly string[]): Read {
  let current = root;
  for (const segment of fields) {
    if (current === MISSING) return MISSING;
    // Paths never enter lists: an array on the way is a miss.
    current = isPlainObject(current) ? ownData(current, segment) : MISSING;
  }
  return current;
}

function scalarOf(value: Read): GraphPredicateScalar | typeof MISSING {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return MISSING;
}

function comparable(actual: GraphPredicateScalar, literal: GraphPredicateScalar): boolean {
  return actual === null || literal === null || typeof actual === typeof literal;
}

function compare(left: number, op: GraphPredicateComparison, right: number): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
  }
}

function lengthOf(value: Read): number | null {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    const length = value.length;
    return Number.isSafeInteger(length) ? length : null;
  }
  return null;
}

function evaluateLeaf(leaf: Extract<Prepared, { kind: "leaf" }>, actual: Read): Truth {
  switch (leaf.op) {
    case "exists":
      return (
        actual !== MISSING &&
        actual !== null &&
        (typeof actual === "string" ||
          typeof actual === "boolean" ||
          (typeof actual === "number" && Number.isFinite(actual)) ||
          Array.isArray(actual) ||
          isPlainObject(actual))
      );
    case "empty":
    case "nonEmpty": {
      const length = lengthOf(actual);
      if (length === null) return null;
      return leaf.op === "empty" ? length === 0 : length > 0;
    }
    case "count": {
      const length = Array.isArray(actual) ? lengthOf(actual) : null;
      return length === null ? null : compare(length, leaf.compare!, leaf.value as number);
    }
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return typeof actual === "number" && Number.isFinite(actual)
        ? compare(actual, leaf.op, leaf.value as number)
        : null;
    case "eq":
    case "neq": {
      const scalar = scalarOf(actual);
      const literal = leaf.value as GraphPredicateScalar;
      if (scalar === MISSING || !comparable(scalar, literal)) return null;
      return (scalar === literal) === (leaf.op === "eq");
    }
    case "in": {
      const scalar = scalarOf(actual);
      if (scalar === MISSING) return null;
      const candidates = (leaf.value as GraphPredicateScalar[]).filter((literal) =>
        comparable(scalar, literal),
      );
      if (candidates.length === 0) return null;
      return candidates.includes(scalar);
    }
  }
}

function evaluateNode(node: Prepared, run: Run): Truth {
  switch (node.kind) {
    case "not": {
      const child = evaluateNode(node.child, run);
      return child === null ? null : !child;
    }
    case "all": {
      let unknown = false;
      for (const child of node.children) {
        const truth = evaluateNode(child, run);
        if (truth === false) return false;
        if (truth === null) unknown = true;
      }
      return unknown ? null : true;
    }
    case "any": {
      let unknown = false;
      for (const child of node.children) {
        const truth = evaluateNode(child, run);
        if (truth === true) return true;
        if (truth === null) unknown = true;
      }
      return unknown ? null : false;
    }
    case "leaf": {
      const truth = evaluateLeaf(node, run.resolve(node.segments));
      if (
        truth === null &&
        run.unknownPaths.length < GRAPH_PREDICATE_MAX_UNKNOWN_PATHS &&
        !run.unknownPaths.includes(node.path)
      ) {
        run.unknownPaths.push(node.path);
      }
      return truth;
    }
  }
}

/**
 * A leaf path: a field path, or one whose first segment is a plan id. A loop
 * inlined from a sub-graph (item 402) reads `<instance>/<node>.<port>…` in its
 * `until`; the root names the inlined node, the rest are fields.
 */
function isGraphLeafPath(value: unknown): value is string {
  if (isGraphFieldPath(value)) return true;
  if (typeof value !== "string") return false;
  const dot = value.indexOf(".");
  const head = dot < 0 ? value : value.slice(0, dot);
  return (
    head.includes("/") &&
    head.length <= GRAPH_PLAN_ID_MAX_CHARS &&
    GRAPH_PLAN_ID_PATTERN.test(head) &&
    (dot < 0 || isGraphFieldPath(value.slice(dot + 1)))
  );
}

function settle(prepared: PrepareResult, resolve: Run["resolve"]): GraphPredicateEvaluation {
  if (!prepared.ok) {
    return { value: false, truth: "unknown", unknownPaths: [], error: prepared.error };
  }
  const run: Run = { resolve, unknownPaths: [] };
  try {
    const truth = evaluateNode(prepared.prepared, run);
    return {
      value: truth === true,
      truth: truth === null ? "unknown" : truth ? "true" : "false",
      unknownPaths: run.unknownPaths,
    };
  } catch {
    return {
      value: false,
      truth: "unknown",
      unknownPaths: run.unknownPaths,
      error: internalError(),
    };
  }
}

function environmentResolver(environment: unknown): Run["resolve"] {
  const rootValue = (name: string): Read => {
    const env = environment;
    if (name === "params") return ownData(env, "params");
    if (name === "run") return ownData(env, "run");
    const roots = ownData(env, "values");
    if (roots instanceof Map) return roots.has(name) ? roots.get(name) : MISSING;
    return ownData(roots, name);
  };
  return (segments) => {
    const split = splitGraphPredicatePath(segments, (name) => rootValue(name) !== MISSING);
    return split ? walk(rootValue(split.root), split.fields) : MISSING;
  };
}

/**
 * Evaluate a node `when`, a gate branch or a loop `until` against the values
 * in scope. Never throws; see the module comment for the three-valued rules.
 */
export function evaluateGraphPredicate(
  predicate: unknown,
  environment: GraphPredicateEnvironment,
): GraphPredicateEvaluation {
  try {
    return settle(prepare(predicate), environmentResolver(environment));
  } catch {
    return { value: false, truth: "unknown", unknownPaths: [], error: internalError() };
  }
}

/** Evaluate an element-relative predicate (an edge `filter`) against one element. */
export function evaluateGraphElementPredicate(
  predicate: unknown,
  element: unknown,
): GraphPredicateEvaluation {
  try {
    return settle(prepare(predicate), (segments) => walk(element, segments));
  } catch {
    return { value: false, truth: "unknown", unknownPaths: [], error: internalError() };
  }
}

export type GraphPredicateFilterResult =
  | {
      ok: true;
      /** The elements the predicate holds for, in order, as the same references. */
      items: unknown[];
      /** Elements dropped because the predicate was false. */
      dropped: number;
      /** Elements dropped because the predicate was unknown for them. */
      unknown: number;
    }
  | {
      ok: false;
      code: GraphPredicateEvalErrorCode | "not_a_list" | "too_many_items";
      message: string;
      at?: string;
    };

/**
 * Apply an edge `filter { where }` to a list value (report §5.7): keep the
 * elements the predicate definitely holds for. The predicate is prepared once;
 * lists longer than `maxItems` (default the artifact item cap) are refused.
 */
export function filterGraphPredicateList(
  list: unknown,
  where: unknown,
  options: { maxItems?: number } = {},
): GraphPredicateFilterResult {
  try {
    const maxItems = Math.min(options.maxItems ?? B.maxArtifactItems, B.maxArtifactItems);
    if (!Array.isArray(list))
      return { ok: false, code: "not_a_list", message: "filter applies to a list" };
    const elements = boundedArray(list, maxItems);
    if (!elements) {
      return {
        ok: false,
        code: "too_many_items",
        message: `filter applies to at most ${maxItems} elements`,
      };
    }
    const prepared = prepare(where);
    if (!prepared.ok) return { ok: false, ...prepared.error };
    const items: unknown[] = [];
    let dropped = 0;
    let unknown = 0;
    for (const element of elements) {
      const run: Run = { resolve: (segments) => walk(element, segments), unknownPaths: [] };
      const truth = evaluateNode(prepared.prepared, run);
      if (truth === true) items.push(element);
      else if (truth === false) dropped++;
      else unknown++;
    }
    return { ok: true, items, dropped, unknown };
  } catch {
    const error = internalError();
    return { ok: false, ...error };
  }
}

/**
 * Graph predicates: the JSON conditions behind a node's `when`, a gate's
 * branches, a loop's `until` and an edge's `filter` transform (report §4.4).
 *
 * This module owns the predicate *shape* and its structural guard, so the
 * template guard (101) can reject a malformed condition with a field path.
 * Path roots, the type checker against producer schemas and the total
 * evaluator belong to item 104, which extends this module rather than
 * redefining the shape.
 *
 * Path roots, by where a predicate appears (checked by 104 and the compiler):
 * - node `when` and gate branches: an input port name of that node, `params`
 *   or `run` (`report.issues`, `params.autoFix`, `run.iteration`);
 * - loop `until`: `<nodeId>.<port>` of a node in the region
 *   (`verify.verdict.complete`), plus `params` and `run`;
 * - edge `filter`: a field of one list element (`severity`).
 */
import {
  FieldErrorCollector,
  checkEnum,
  checkFiniteNumber,
  checkObject,
  isPlainRecord,
  joinPath,
  type FieldValidation,
} from "../field-validation.js";
import {
  GRAPH_TEMPLATE_BOUNDS as B,
  checkGraphFieldPath,
  checkGraphList,
  checkGraphText,
  checkPresent,
} from "./grammar.js";

export const GRAPH_PREDICATE_EQUALITY_OPS = ["eq", "neq"] as const;
export const GRAPH_PREDICATE_ORDER_OPS = ["lt", "lte", "gt", "gte"] as const;
export const GRAPH_PREDICATE_PRESENCE_OPS = ["exists", "empty", "nonEmpty"] as const;
export const GRAPH_PREDICATE_COMPARISONS = [
  ...GRAPH_PREDICATE_EQUALITY_OPS,
  ...GRAPH_PREDICATE_ORDER_OPS,
] as const;
/** Every leaf operator; `all`, `any` and `not` are the combinators. */
export const GRAPH_PREDICATE_OPS = [
  ...GRAPH_PREDICATE_COMPARISONS,
  "in",
  ...GRAPH_PREDICATE_PRESENCE_OPS,
  "count",
] as const;

export type GraphPredicateEqualityOp = (typeof GRAPH_PREDICATE_EQUALITY_OPS)[number];
export type GraphPredicateOrderOp = (typeof GRAPH_PREDICATE_ORDER_OPS)[number];
export type GraphPredicatePresenceOp = (typeof GRAPH_PREDICATE_PRESENCE_OPS)[number];
export type GraphPredicateComparison = (typeof GRAPH_PREDICATE_COMPARISONS)[number];
export type GraphPredicateOp = (typeof GRAPH_PREDICATE_OPS)[number];

/** A literal a predicate compares against. Strings are bounded. */
export type GraphPredicateScalar = string | number | boolean | null;

/** `{ path, op: "eq" | "neq", value }` */
export interface GraphEqualityPredicate {
  path: string;
  op: GraphPredicateEqualityOp;
  value: GraphPredicateScalar;
}

/** `{ path, op: "lt" | "lte" | "gt" | "gte", value }` over numbers. */
export interface GraphOrderPredicate {
  path: string;
  op: GraphPredicateOrderOp;
  value: number;
}

/** `{ path, op: "in", value: [...] }`: the value is one of the listed literals. */
export interface GraphInPredicate {
  path: string;
  op: "in";
  value: GraphPredicateScalar[];
}

/** `{ path, op: "exists" | "empty" | "nonEmpty" }` */
export interface GraphPresencePredicate {
  path: string;
  op: GraphPredicatePresenceOp;
}

/** `{ path, op: "count", compare, value }`: the list length compared with `value`. */
export interface GraphCountPredicate {
  path: string;
  op: "count";
  compare: GraphPredicateComparison;
  value: number;
}

export type GraphLeafPredicate =
  | GraphEqualityPredicate
  | GraphOrderPredicate
  | GraphInPredicate
  | GraphPresencePredicate
  | GraphCountPredicate;

export interface GraphAllPredicate {
  all: GraphPredicate[];
}
export interface GraphAnyPredicate {
  any: GraphPredicate[];
}
export interface GraphNotPredicate {
  not: GraphPredicate;
}

export type GraphPredicate =
  GraphLeafPredicate | GraphAllPredicate | GraphAnyPredicate | GraphNotPredicate;

function checkScalar(value: unknown, path: string, errors: FieldErrorCollector): boolean {
  if (!checkPresent(value, path, errors)) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") {
    return checkFiniteNumber(value, path, errors, { maxAbs: B.maxNumberAbs });
  }
  if (typeof value === "string") {
    return checkGraphText(value, path, errors, {
      maxBytes: B.maxPredicateStringBytes,
      multiline: true,
      allowEmpty: true,
    });
  }
  errors.add(path, "type", "Expected a string, number, boolean or null");
  return false;
}

interface PredicateBudget {
  nodes: number;
}

function checkNode(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
  depth: number,
  budget: PredicateBudget,
): void {
  if (depth > B.maxPredicateDepth) {
    errors.add(path, "too_deep", `Predicates nest at most ${B.maxPredicateDepth} levels deep`);
    return;
  }
  budget.nodes++;
  if (budget.nodes === B.maxPredicateNodes + 1) {
    errors.add(path, "too_many", `A predicate has at most ${B.maxPredicateNodes} nodes`);
  }
  if (budget.nodes > B.maxPredicateNodes) return;
  if (!isPlainRecord(value)) {
    errors.add(path, "type", "Expected a predicate object");
    return;
  }
  for (const combinator of ["all", "any"] as const) {
    if (combinator in value) {
      if (!checkObject(value, path, [combinator], errors)) return;
      const listPath = joinPath(path, combinator);
      if (
        checkGraphList(value[combinator], listPath, errors, { min: 1, max: B.maxPredicateNodes })
      ) {
        (value[combinator] as unknown[]).forEach((child, index) =>
          checkNode(child, joinPath(listPath, index), errors, depth + 1, budget),
        );
      }
      return;
    }
  }
  if ("not" in value) {
    if (!checkObject(value, path, ["not"], errors)) return;
    checkNode(value.not, joinPath(path, "not"), errors, depth + 1, budget);
    return;
  }
  if (!("op" in value)) {
    errors.add(path, "predicate", "Expected all, any, not, or a path with an op");
    return;
  }
  const op = value.op;
  if (!checkEnum(op, joinPath(path, "op"), errors, GRAPH_PREDICATE_OPS)) return;
  const fields =
    op === "count"
      ? ["path", "op", "compare", "value"]
      : (GRAPH_PREDICATE_PRESENCE_OPS as readonly string[]).includes(op)
        ? ["path", "op"]
        : ["path", "op", "value"];
  if (!checkObject(value, path, fields, errors)) return;
  checkGraphFieldPath(value.path, joinPath(path, "path"), errors);
  const valuePath = joinPath(path, "value");
  if (op === "count") {
    if (checkPresent(value.compare, joinPath(path, "compare"), errors)) {
      checkEnum(value.compare, joinPath(path, "compare"), errors, GRAPH_PREDICATE_COMPARISONS);
    }
    if (checkPresent(value.value, valuePath, errors)) {
      checkFiniteNumber(value.value, valuePath, errors, {
        integer: true,
        min: 0,
        max: B.maxArtifactItems,
      });
    }
  } else if (op === "in") {
    if (checkGraphList(value.value, valuePath, errors, { min: 1, max: B.maxPredicateListValues })) {
      (value.value as unknown[]).forEach((entry, index) =>
        checkScalar(entry, joinPath(valuePath, index), errors),
      );
    }
  } else if ((GRAPH_PREDICATE_ORDER_OPS as readonly string[]).includes(op)) {
    if (checkPresent(value.value, valuePath, errors)) {
      checkFiniteNumber(value.value, valuePath, errors, { maxAbs: B.maxNumberAbs });
    }
  } else if ((GRAPH_PREDICATE_EQUALITY_OPS as readonly string[]).includes(op)) {
    checkScalar(value.value, valuePath, errors);
  }
}

/**
 * Structural guard for one predicate at `path`, adding errors to `errors`.
 * Depth and node count are bounded; operand shapes match the operator.
 */
export function checkGraphPredicate(
  value: unknown,
  path: string,
  errors: FieldErrorCollector,
): void {
  if (!checkPresent(value, path, errors)) return;
  checkNode(value, path, errors, 1, { nodes: 0 });
}

export function validateGraphPredicate(value: unknown): FieldValidation<GraphPredicate> {
  const errors = new FieldErrorCollector();
  checkGraphPredicate(value, "", errors);
  return errors.result(value as GraphPredicate);
}

export function isGraphPredicate(value: unknown): value is GraphPredicate {
  return validateGraphPredicate(value).ok;
}

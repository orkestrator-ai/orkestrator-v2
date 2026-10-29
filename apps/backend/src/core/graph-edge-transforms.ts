/**
 * Edge transforms on actual values, at delivery (plan P2.6, D14, report
 * §5.7, §5.11). The compiler typed each edge's transforms (item 102,
 * `graphEdgeTransformResultType`); this module applies them to the artifact
 * values an edge delivers and says what the consumer's input port receives.
 *
 * Pure and bounded: no I/O, no user code, never more than the artifact item
 * cap of elements in flight. The ready set (`graph-run-ready-set.ts`) calls
 * {@link planGraphEdgeDelivery} once the source values are loaded; the pass
 * stores what it asks to store and plans again.
 *
 * ## Values
 *
 * An edge's source is one artifact, or a list of artifacts when its source
 * type is a list (a fan-in from a replicated producer, or a list-typed gate
 * outlet). Transforms apply in order:
 *
 * - `pick` projects one value, or each element of a list, onto the named
 *   (dotted) fields, keeping the object structure; a field the value lacks is
 *   left out, and a null on the way stays null.
 * - `filter` keeps the list elements its element-relative predicate
 *   definitely holds for (104's three-valued `filterGraphPredicateList`).
 * - `limit` keeps the first `count` elements.
 * - `flatten` concatenates the list at `path` of one value or of every
 *   element; a missing or null list contributes nothing.
 * - `adapt` runs a named built-in adapter (102's `applyGraphTypeAdapter`), on
 *   each element of a list.
 *
 * ## Deliveries
 *
 * - `forward`: only `filter` and `limit` ran (or nothing), so the port gets a
 *   subset of the source artifacts themselves: ids, lineage and item ids are
 *   kept.
 * - `store`: a transform made new values. Each becomes an artifact of the
 *   target port's (element) type, which the store validates in full (budgets,
 *   schema, domain validator; invariant 4). A list becomes one artifact per
 *   element, at most {@link GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS}.
 * - `failed`: a value does not fit the target type's budgets
 *   (`budget-exceeded`, checked whenever the compiler set `budgetCheck` and
 *   for every stored value), or the transform cannot apply (`system-error`).
 *   The consumer's position then fails with that cause and its `onFailure`
 *   applies.
 *
 * Messages carry ids, paths, codes and counts, never values.
 */
import { isPlainRecord } from "@orkestrator/protocol/field-validation";
import type {
  CompiledGraphPlan,
  GraphPlanEdge,
  GraphPlanInputPort,
} from "@orkestrator/protocol/graphs/compile";
import { GRAPH_TEMPLATE_BOUNDS } from "@orkestrator/protocol/graphs/grammar";
import { filterGraphPredicateList } from "@orkestrator/protocol/graphs/predicates";
import { GRAPH_RUN_BOUNDS } from "@orkestrator/protocol/graphs/run";
import type { GraphEdgeTransform } from "@orkestrator/protocol/graphs/template";
import {
  applyGraphTypeAdapter,
  graphTypeAdapter,
} from "@orkestrator/protocol/graphs/type-assignability";
import {
  GraphTypeLibrary,
  graphBudgetIssues,
  type GraphErrorCause,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";

/** Elements one transform chain may hold at once: the artifact item cap. */
export const GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS = GRAPH_TEMPLATE_BOUNDS.maxArtifactItems;
/** Artifacts one delivery may bind to a list port: the record's per-port bound. */
export const GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS = GRAPH_RUN_BOUNDS.maxPortArtifacts;

export type GraphEdgeTransformErrorCode =
  "requires_list" | "too_many_elements" | "unknown_adapter" | "filter_failed" | "adapter_failed";

export type GraphEdgeTransformResult =
  | { ok: true; value: unknown; list: boolean }
  | { ok: false; code: GraphEdgeTransformErrorCode; index: number; message: string };

/** One element in flight, with the artifact it still is (filter and limit keep it). */
interface Entry {
  value: unknown;
  from?: string;
}

type Chain =
  | { ok: true; list: boolean; entries: Entry[] }
  | { ok: false; code: GraphEdgeTransformErrorCode; index: number; message: string };

function ownField(value: unknown, key: string): unknown {
  if (!isPlainRecord(value) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function valueAtPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    current = ownField(current, segment);
  }
  return current;
}

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  // `__proto__` is a legal path segment; never let it reach a prototype.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

type PickTree = Map<string, PickTree | true>;

function pickTree(fields: readonly string[]): PickTree {
  const tree: PickTree = new Map();
  for (const field of fields) {
    let node = tree;
    const segments = field.split(".");
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        node.set(segment, true);
        return;
      }
      const existing = node.get(segment);
      if (existing === true) return;
      const child: PickTree = existing ?? new Map();
      node.set(segment, child);
      node = child;
    });
  }
  return tree;
}

/** `pick` on one value: the named fields, the structure on the way kept. */
export function pickGraphValue(value: unknown, fields: readonly string[]): unknown {
  const build = (current: unknown, picks: PickTree): unknown => {
    if (!isPlainRecord(current)) return current === undefined ? undefined : current;
    const out: Record<string, unknown> = {};
    for (const [key, sub] of picks) {
      const child = ownField(current, key);
      if (child === undefined) continue;
      define(out, key, sub === true || child === null ? child : build(child, sub));
    }
    return out;
  };
  return build(value, pickTree(fields));
}

function tooMany(index: number, count: number): Chain {
  return {
    ok: false,
    code: "too_many_elements",
    index,
    message: `Transform ${index} would hold ${count} elements; at most ${GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS} are allowed`,
  };
}

function applyOne(
  chain: Extract<Chain, { ok: true }>,
  transform: GraphEdgeTransform,
  index: number,
): Chain {
  const { list, entries } = chain;
  switch (transform.op) {
    case "filter": {
      if (!list) return requiresList(transform.op, index);
      const filtered = filterGraphPredicateList(
        entries.map((entry) => entry.value),
        transform.where,
        { maxItems: GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS },
      );
      if (!filtered.ok) {
        return {
          ok: false,
          code: "filter_failed",
          index,
          message: `Transform ${index} (filter) failed: ${filtered.code}`,
        };
      }
      // The kept elements are the same references, in order: align them.
      const kept: Entry[] = [];
      let next = 0;
      for (const entry of entries) {
        if (next < filtered.items.length && Object.is(filtered.items[next], entry.value)) {
          kept.push(entry);
          next += 1;
        }
      }
      return { ok: true, list, entries: kept };
    }
    case "limit":
      if (!list) return requiresList(transform.op, index);
      return { ok: true, list, entries: entries.slice(0, Math.max(0, transform.count)) };
    case "pick":
      return {
        ok: true,
        list,
        entries: entries.map((entry) => ({ value: pickGraphValue(entry.value, transform.fields) })),
      };
    case "flatten": {
      const flattened: Entry[] = [];
      for (const entry of entries) {
        const nested = valueAtPath(entry.value, transform.path);
        if (!Array.isArray(nested)) continue;
        if (flattened.length + nested.length > GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS) {
          return tooMany(index, flattened.length + nested.length);
        }
        for (const element of nested) flattened.push({ value: element });
      }
      return { ok: true, list: true, entries: flattened };
    }
    case "adapt": {
      const adapter = graphTypeAdapter(transform.adapter);
      if (!adapter) {
        return {
          ok: false,
          code: "unknown_adapter",
          index,
          message: `Transform ${index}: unknown adapter ${transform.adapter}`,
        };
      }
      const toList = adapter.to.startsWith("list<");
      const adapted: Entry[] = [];
      try {
        for (const entry of entries) {
          const result = applyGraphTypeAdapter(adapter, entry.value);
          const produced = toList && Array.isArray(result) ? result : [result];
          if (adapted.length + produced.length > GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS) {
            return tooMany(index, adapted.length + produced.length);
          }
          for (const value of produced) adapted.push({ value });
        }
      } catch {
        return {
          ok: false,
          code: "adapter_failed",
          index,
          message: `Transform ${index}: adapter ${adapter.id} could not adapt the value`,
        };
      }
      return { ok: true, list: list || toList, entries: adapted };
    }
  }
}

function requiresList(op: string, index: number): Chain {
  return {
    ok: false,
    code: "requires_list",
    index,
    message: `Transform ${index} (${op}) applies to a list`,
  };
}

function runChain(
  entries: Entry[],
  list: boolean,
  transforms: readonly GraphEdgeTransform[],
): Chain {
  if (entries.length > GRAPH_EDGE_TRANSFORM_MAX_ELEMENTS) return tooMany(0, entries.length);
  let chain: Chain = { ok: true, list, entries };
  for (const [index, transform] of transforms.entries()) {
    chain = applyOne(chain, transform, index);
    if (!chain.ok) return chain;
  }
  return chain;
}

/**
 * Applies an edge's transforms to a value: one value, or a list when `list`
 * (each element one source artifact's value). The result is a list when the
 * source was one or a transform made one (`flatten`, a list adapter).
 */
export function applyGraphEdgeTransforms(
  value: unknown,
  transforms: readonly GraphEdgeTransform[],
  options: { list: boolean },
): GraphEdgeTransformResult {
  let entries: Entry[];
  if (options.list) {
    if (!Array.isArray(value)) {
      return { ok: false, code: "requires_list", index: 0, message: "The source is not a list" };
    }
    entries = value.map((element) => ({ value: element }));
  } else {
    entries = [{ value }];
  }
  const chain = runChain(entries, options.list, transforms);
  if (!chain.ok) return chain;
  const values = chain.entries.map((entry) => entry.value);
  return { ok: true, list: chain.list, value: chain.list ? values : values[0] };
}

// ---------------------------------------------------------------- delivery

export interface GraphEdgeDeliverySource {
  /** The source artifact id. */
  id: string;
  value: unknown;
}

/** What the target port receives from one edge. */
export type GraphEdgeDelivery =
  | { kind: "forward"; ids: string[] }
  | {
      kind: "store";
      /** The target port's (element) type: what each new artifact is stored as. */
      type: string;
      values: unknown[];
      /** Lineage of every new artifact: the source artifact ids. */
      inputs: string[];
    }
  | {
      kind: "failed";
      cause: Extract<GraphErrorCause, "budget-exceeded" | "system-error">;
      message: string;
    };

/** Whether an edge needs its source values at delivery (transforms, or a runtime budget check). */
export function graphEdgeNeedsDelivery(edge: GraphPlanEdge): boolean {
  return edge.transform.length > 0 || edge.budgetCheck;
}

function elementRef(type: string): string {
  return type.startsWith("list<") && type.endsWith(">") ? type.slice(5, -1) : type;
}

function definitionOf(plan: CompiledGraphPlan, ref: string): GraphTypeDefinition | null {
  const resolution = new GraphTypeLibrary(plan.types).resolve(ref);
  return resolution.ok && resolution.type.kind === "named" ? resolution.type.definition : null;
}

function budgetFailure(
  edge: GraphPlanEdge,
  port: GraphPlanInputPort,
  definition: GraphTypeDefinition,
  values: readonly unknown[],
): GraphEdgeDelivery | null {
  for (const [index, value] of values.entries()) {
    const issues = graphBudgetIssues(definition.budgets, value, definition.storage);
    if (issues.length === 0) continue;
    const first = issues[0]!;
    return {
      kind: "failed",
      cause: "budget-exceeded",
      message: `Input ${port.name}: edge ${edge.id} delivers a value${values.length > 1 ? ` (element ${index})` : ""} over ${definition.ref}'s budgets (${first.code} at ${first.path})`,
    };
  }
  return null;
}

/**
 * What `port` receives from `edge`, given the source artifacts' values in
 * delivery order. Call it only for an edge that {@link graphEdgeNeedsDelivery}.
 */
export function planGraphEdgeDelivery(input: {
  plan: CompiledGraphPlan;
  edge: GraphPlanEdge;
  port: GraphPlanInputPort;
  sources: readonly GraphEdgeDeliverySource[];
}): GraphEdgeDelivery {
  const { plan, edge, port, sources } = input;
  const list = edge.sourceType ? edge.sourceType.kind === "list" : sources.length !== 1;
  if (!list && sources.length !== 1) {
    return {
      kind: "failed",
      cause: "system-error",
      message: `Input ${port.name}: edge ${edge.id} delivers ${sources.length} artifacts where one is expected`,
    };
  }
  const chain = runChain(
    sources.map((source) => ({ value: source.value, from: source.id })),
    list,
    edge.transform,
  );
  if (!chain.ok) {
    return {
      kind: "failed",
      cause: "system-error",
      message: `Input ${port.name}: edge ${edge.id}: ${chain.message}`,
    };
  }
  const targetRef = elementRef(port.type);
  const definition = definitionOf(plan, targetRef);
  if (!definition) {
    return {
      kind: "failed",
      cause: "system-error",
      message: `Input ${port.name}: ${targetRef} is not a type of this run`,
    };
  }
  const listPort = port.fanIn || port.type.startsWith("list<");
  if (chain.list && !listPort) {
    return {
      kind: "failed",
      cause: "system-error",
      message: `Input ${port.name} takes one value but edge ${edge.id} delivers a list`,
    };
  }
  if (chain.entries.length > GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS) {
    return {
      kind: "failed",
      cause: "budget-exceeded",
      message: `Input ${port.name}: edge ${edge.id} delivers ${chain.entries.length} elements; a port takes at most ${GRAPH_EDGE_DELIVERY_MAX_ARTIFACTS} (add a limit transform)`,
    };
  }
  const values = chain.entries.map((entry) => entry.value);
  const over = budgetFailure(edge, port, definition, values);
  if (over) return over;
  if (chain.entries.every((entry) => entry.from !== undefined)) {
    return { kind: "forward", ids: chain.entries.map((entry) => entry.from!) };
  }
  if (definition.storage !== "value") {
    return {
      kind: "failed",
      cause: "system-error",
      message: `Input ${port.name}: a transform cannot make a ${definition.ref} file artifact`,
    };
  }
  return {
    kind: "store",
    type: definition.ref,
    values,
    inputs: [...new Set(sources.map((source) => source.id))],
  };
}

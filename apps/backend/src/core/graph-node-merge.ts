/**
 * The `merge` node executor (plan P2.6, D11, report §5.9): deterministic
 * fan-in over the artifacts of one `list<T>` input, at no model cost.
 *
 * | Strategy  | Output                                                                  |
 * | --------- | ----------------------------------------------------------------------- |
 * | `concat`  | one T with every input's items (T declares `items`); item ids kept      |
 * | `dedupe`  | as `concat`, items with the same key folded; every source id kept (D11) |
 * | `vote`    | the decision most inputs chose, with the counts; a tie policy           |
 * | `best`    | the input with the highest (or lowest) numeric score                    |
 * | `collect` | the input list unchanged (the merge stores nothing)                     |
 *
 * Rules shared by every strategy:
 *
 * - Inputs are taken in their bound order, each artifact once; that order
 *   breaks every tie, so the same inputs always merge to the same output.
 * - Failure markers (`error@1` elements a collect policy passes on with
 *   `includeFailures`, item 205) take no part; `collect` keeps them.
 * - Nothing to merge (an empty list, or only failure markers) completes the
 *   merge *without* its output: consumers that require it are skipped, as
 *   behind an untaken gate outlet. `collect` delivers the empty list.
 * - A strategy that cannot decide fails with `invalid-result`: a `vote` tie
 *   under `tie: "fail"`, a `vote` with no text choice at its path, a `best`
 *   with no numeric score. The node's `onFailure` applies (merges do not
 *   retry: they are deterministic).
 * - Bounded: at most the artifact item cap of items in flight; the output is
 *   validated against its port's type like any artifact (invariant 4).
 *
 * **Item ids.** A T with `items` gives each item a stable id: the producer's
 * recorded `itemIds`, or `<node>[/iter-<n>][/<branch>]/<idPrefix>-<k>` derived
 * from the producing activation (report §5.8; the protocol's
 * `graphArtifactItemIds`, which the agent executor and prompts share). `concat` keeps them all;
 * `dedupe` keeps the first item of each key group under its id, records
 * every folded id in the artifact's `itemSources`, and, when T's items have a
 * source-id field (`x-orkestrator-sources`, such as a finding's
 * `reviewSourceIds`), fills it with the union of the folded items' sources
 * (an item's own id when it cites none), capped at the type's `maxItems`.
 *
 * The key of a `dedupe` is the values at its key paths, compared as
 * canonical JSON; an item missing every key path is never folded.
 */
import { canonicalJson } from "@orkestrator/protocol/canonical-json";
import { isPlainRecord } from "@orkestrator/protocol/field-validation";
import { GRAPH_TEMPLATE_BOUNDS, graphUtf8Bytes } from "@orkestrator/protocol/graphs/grammar";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_RUN_LIMIT_CODES,
  graphArtifactItemIds,
  type GraphArtifactProducer,
} from "@orkestrator/protocol/graphs/run";
import type { GraphMergeStrategy } from "@orkestrator/protocol/graphs/template";
import {
  GraphTypeLibrary,
  type GraphErrorCause,
  type GraphTypeDefinition,
} from "@orkestrator/protocol/graphs/types";
import type {
  GraphActivationReport,
  GraphExecutorContext,
  GraphNodeExecutor,
} from "./graph-run-executors.js";
import { GraphStorageError } from "./graph-run-errors.js";

/** Items one merge may hold: the artifact item cap. */
export const GRAPH_MERGE_MAX_ITEMS = GRAPH_TEMPLATE_BOUNDS.maxArtifactItems;
/** The type of a failure marker in a fan-in list. */
export const GRAPH_FAILURE_MARKER_TYPE = "error@1";

/** One input artifact of a merge. */
export interface GraphMergeSource {
  id: string;
  type: string;
  value: unknown;
  producer: GraphArtifactProducer;
  itemIds?: readonly string[];
}

export type GraphMergeResult =
  | {
      kind: "value";
      value: unknown;
      itemIds?: string[];
      itemSources?: string[][];
    }
  /** `collect`: deliver these input artifacts unchanged. */
  | { kind: "forward"; ids: string[] }
  /** Nothing to merge: complete without the output. */
  | { kind: "none" }
  | {
      kind: "failed";
      cause: Extract<GraphErrorCause, "invalid-result" | "budget-exceeded" | "system-error">;
      message: string;
    };

// ---------------------------------------------------------------- values

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
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Sets `path` in a (cloned) object, creating objects on the way. */
function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      define(current, segment, value);
      return;
    }
    const next = ownField(current, segment);
    if (isPlainRecord(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      define(current, segment, created);
      current = created;
    }
  });
}

/** Text cut to a UTF-8 byte budget, on a code point boundary. */
function truncateBytes(text: string, maxBytes: number | undefined): string {
  if (maxBytes === undefined || graphUtf8Bytes(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const char of text) {
    const size = graphUtf8Bytes(char);
    if (bytes + size > maxBytes - 3) break;
    out += char;
    bytes += size;
  }
  return `${out}…`;
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)];
}

// ---------------------------------------------------------------- item ids

const MAX_ITEM_ID_CHARS = GRAPH_ARTIFACT_BUDGETS.maxItemIdChars;

/** One source's item ids: recorded, else derived (`graphArtifactItemIds`, protocol `run-items.ts`). */
function sourceItemIds(
  source: GraphMergeSource,
  element: GraphTypeDefinition,
  count: number,
): string[] {
  return graphArtifactItemIds(source, element.items, { count });
}

/** Makes ids unique in order (`~2`, `~3` …), as the artifact guard requires. */
function uniqueItemIds(ids: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return ids.map((id) => {
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 1) return id;
    const suffix = `~${count}`;
    return `${id.slice(0, MAX_ITEM_ID_CHARS - suffix.length)}${suffix}`;
  });
}

// ---------------------------------------------------------------- strategies

interface Item {
  value: unknown;
  id: string;
}

function itemsOf(
  sources: readonly GraphMergeSource[],
  element: GraphTypeDefinition,
): { items: Item[] } | Extract<GraphMergeResult, { kind: "failed" }> {
  const path = element.items?.path;
  if (path === undefined) {
    return {
      kind: "failed",
      cause: "system-error",
      message: `${element.ref} declares no items to merge`,
    };
  }
  const items: Item[] = [];
  for (const source of sources) {
    const list = valueAtPath(source.value, path);
    const values = Array.isArray(list) ? list : [];
    if (items.length + values.length > GRAPH_MERGE_MAX_ITEMS) {
      return {
        kind: "failed",
        cause: "budget-exceeded",
        message: `The merge would hold more than ${GRAPH_MERGE_MAX_ITEMS} items`,
      };
    }
    const ids = sourceItemIds(source, element, values.length);
    values.forEach((value, index) => items.push({ value, id: ids[index]! }));
  }
  return { items };
}

/** The first input with its items replaced. */
function withItems(
  sources: readonly GraphMergeSource[],
  element: GraphTypeDefinition,
  items: unknown[],
): unknown {
  const base = structuredClone(sources[0]!.value);
  if (!isPlainRecord(base)) return base;
  setAtPath(base, element.items!.path, items);
  return base;
}

function concat(
  sources: readonly GraphMergeSource[],
  element: GraphTypeDefinition,
): GraphMergeResult {
  const collected = itemsOf(sources, element);
  if ("kind" in collected) return collected;
  return {
    kind: "value",
    value: withItems(
      sources,
      element,
      collected.items.map((item) => structuredClone(item.value)),
    ),
    itemIds: uniqueItemIds(collected.items.map((item) => item.id)),
  };
}

/** The item field holding source ids (`issues[].reviewSourceIds` → `reviewSourceIds`). */
function itemSourcesField(element: GraphTypeDefinition): string | null {
  const path = element.items?.path;
  if (path === undefined) return null;
  const prefix = [...path.split("."), "[]"];
  for (const field of element.sources) {
    const { segments } = field;
    if (
      segments.length === prefix.length + 1 &&
      prefix.every((segment, index) => segments[index] === segment)
    ) {
      return segments[segments.length - 1]!;
    }
  }
  return null;
}

function dedupeKey(value: unknown, paths: readonly string[]): string | null {
  const parts = paths.map((path) => valueAtPath(value, path));
  if (parts.every((part) => part === undefined)) return null;
  return canonicalJson(parts.map((part) => (part === undefined ? null : part)));
}

function dedupe(
  sources: readonly GraphMergeSource[],
  element: GraphTypeDefinition,
  keyPaths: readonly string[],
): GraphMergeResult {
  const collected = itemsOf(sources, element);
  if ("kind" in collected) return collected;
  const groups: Item[][] = [];
  const byKey = new Map<string, Item[]>();
  for (const item of collected.items) {
    const key = dedupeKey(item.value, keyPaths);
    const group = key === null ? undefined : byKey.get(key);
    if (group) {
      group.push(item);
      continue;
    }
    const created = [item];
    groups.push(created);
    if (key !== null) byKey.set(key, created);
  }
  const field = itemSourcesField(element);
  const cap = element.budgets.maxItems;
  const items = groups.map((group) => {
    const first = structuredClone(group[0]!.value);
    if (field === null || !isPlainRecord(first)) return first;
    // Every folded item's sources: those it cites, or itself when it cites none.
    const cited = uniqueStrings(
      group.flatMap((item) => {
        const existing = ownField(item.value, field);
        const strings = Array.isArray(existing)
          ? existing.filter((entry): entry is string => typeof entry === "string")
          : [];
        return strings.length > 0 ? strings : [item.id];
      }),
    );
    define(first, field, cap === undefined ? cited : cited.slice(0, cap));
    return first;
  });
  const itemIds = uniqueItemIds(groups.map((group) => group[0]!.id));
  return {
    kind: "value",
    value: withItems(sources, element, items),
    itemIds,
    itemSources: groups.map((group) => uniqueStrings(group.map((item) => item.id))),
  };
}

function vote(
  sources: readonly GraphMergeSource[],
  strategy: Extract<GraphMergeStrategy, { kind: "vote" }>,
  output: GraphTypeDefinition,
): GraphMergeResult {
  const path = strategy.path ?? "choice";
  const votes: { choice: string; source: GraphMergeSource }[] = [];
  for (const source of sources) {
    const choice = valueAtPath(source.value, path);
    if (typeof choice === "string") votes.push({ choice, source });
  }
  if (votes.length === 0) {
    return {
      kind: "failed",
      cause: "invalid-result",
      message: `None of the ${sources.length} inputs has a text choice at ${path}`,
    };
  }
  // First-seen order: a `first` tie goes to the choice that appears first.
  const counts = new Map<string, number>();
  for (const { choice } of votes) counts.set(choice, (counts.get(choice) ?? 0) + 1);
  const most = Math.max(...counts.values());
  const leaders = [...counts].filter(([, count]) => count === most).map(([choice]) => choice);
  if (leaders.length > 1 && strategy.tie === "fail") {
    return {
      kind: "failed",
      cause: "invalid-result",
      message: `The vote is tied: ${leaders.length} choices have ${most} of ${votes.length} votes each`,
    };
  }
  const winner = leaders[0]!;
  const chosen = votes.find((entry) => entry.choice === winner)!.source;
  const value = structuredClone(chosen.value);
  const tally = [...counts].map(([choice, count]) => `${choice} ${count}`).join(", ");
  const summary = `Vote: ${tally} (${votes.length} votes${leaders.length > 1 ? "; tie broken by input order" : ""}).`;
  const rationale = ownField(value, "rationale");
  if (isPlainRecord(value) && typeof rationale === "string") {
    define(
      value,
      "rationale",
      truncateBytes(`${summary} ${rationale}`, output.budgets.maxStringBytes),
    );
  }
  return { kind: "value", value };
}

function best(
  sources: readonly GraphMergeSource[],
  strategy: Extract<GraphMergeStrategy, { kind: "best" }>,
  element: GraphTypeDefinition,
): GraphMergeResult {
  const lowest = strategy.prefer === "lowest";
  let chosen: { source: GraphMergeSource; score: number } | null = null;
  for (const source of sources) {
    const score = valueAtPath(source.value, strategy.score);
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    // Strictly better only: the earliest input wins a tie.
    if (!chosen || (lowest ? score < chosen.score : score > chosen.score)) {
      chosen = { source, score };
    }
  }
  if (!chosen) {
    return {
      kind: "failed",
      cause: "invalid-result",
      message: `None of the ${sources.length} inputs has a numeric score at ${strategy.score}`,
    };
  }
  const value = structuredClone(chosen.source.value);
  if (!element.items) return { kind: "value", value };
  const items = valueAtPath(chosen.source.value, element.items.path);
  const count = Array.isArray(items) ? items.length : 0;
  return {
    kind: "value",
    value,
    itemIds: uniqueItemIds(sourceItemIds(chosen.source, element, count)),
  };
}

/**
 * Merges the inputs of one activation. Pure and deterministic: the same
 * sources in the same order always give the same result.
 */
export function mergeGraphValues(input: {
  strategy: GraphMergeStrategy;
  /** The input list's element type. */
  element: GraphTypeDefinition;
  /** The output port's type. */
  output: GraphTypeDefinition;
  sources: readonly GraphMergeSource[];
}): GraphMergeResult {
  const { strategy, element, output } = input;
  const seen = new Set<string>();
  const all = input.sources.filter((source) => {
    if (seen.has(source.id)) return false;
    seen.add(source.id);
    return true;
  });
  if (strategy.kind === "collect") return { kind: "forward", ids: all.map((source) => source.id) };
  const sources = all.filter((source) => source.type !== GRAPH_FAILURE_MARKER_TYPE);
  if (sources.length === 0) return { kind: "none" };
  switch (strategy.kind) {
    case "concat":
      return concat(sources, element);
    case "dedupe":
      return dedupe(sources, element, strategy.key);
    case "vote":
      return vote(sources, strategy, output);
    case "best":
      return best(sources, strategy, element);
  }
}

// ---------------------------------------------------------------- executor

function elementRef(type: string): string {
  return type.startsWith("list<") && type.endsWith(">") ? type.slice(5, -1) : type;
}

function definitionOf(library: GraphTypeLibrary, ref: string): GraphTypeDefinition {
  const resolution = library.resolve(ref);
  if (!resolution.ok || resolution.type.kind !== "named") {
    throw new Error(`${ref} is not a type of this run`);
  }
  return resolution.type.definition;
}

/** A refused output: over a budget, or a merged value its type does not accept. */
function storeFailure(error: GraphStorageError): GraphActivationReport {
  const issues = (error.issues ?? []).slice(0, 4);
  const budget =
    (GRAPH_RUN_LIMIT_CODES as readonly string[]).includes(error.code) ||
    issues.some((issue) => /:too_(large|many_items)$/.test(issue));
  return {
    state: "failed",
    cause: budget ? "budget-exceeded" : "invalid-result",
    error: `The merged output could not be stored: ${error.message}${issues.length > 0 ? ` (${issues.join(", ")})` : ""}`,
  };
}

async function runMerge(context: GraphExecutorContext): Promise<GraphActivationReport> {
  const { node, activation, run } = context;
  if (node.kind !== "merge") throw new Error("The merge executor runs merge nodes only");
  const port = node.inputs[0];
  const output = node.outputs[0];
  if (!port || !output) throw new Error("A merge node has one input and one output");
  if (node.strategy.kind === "collect") {
    // The ready set delivers the input list itself to consumers.
    return { state: "complete", outputs: {} };
  }
  const bound = activation.inputs[port.name];
  const ids = uniqueStrings(bound === undefined ? [] : Array.isArray(bound) ? bound : [bound]);
  const library = new GraphTypeLibrary(run.plan.types);
  const element = definitionOf(library, elementRef(port.type));
  const outputType = definitionOf(library, output.type);
  const sources: GraphMergeSource[] = [];
  for (const id of ids) {
    const artifact = await context.artifacts.requireVerified(run.id, id);
    sources.push({
      id,
      type: artifact.type,
      value: artifact.body.value,
      producer: artifact.producer,
      ...(artifact.itemIds ? { itemIds: artifact.itemIds } : {}),
    });
  }
  const result = mergeGraphValues({
    strategy: node.strategy,
    element,
    output: outputType,
    sources,
  });
  switch (result.kind) {
    case "forward":
    case "none":
      return { state: "complete", outputs: {} };
    case "failed":
      return { state: "failed", cause: result.cause, error: result.message };
    case "value":
      break;
  }
  try {
    const artifact = await context.artifacts.putValue({
      runId: run.id,
      type: output.type,
      producer: { nodeId: node.id, activation: activation.key, port: output.name },
      inputs: ids,
      ...(result.itemIds ? { itemIds: result.itemIds } : {}),
      ...(result.itemSources ? { itemSources: result.itemSources } : {}),
      ...(output.choices ? { validation: { choices: output.choices } } : {}),
      value: result.value,
    });
    return { state: "complete", outputs: { [output.name]: artifact.id } };
  } catch (error) {
    if (error instanceof GraphStorageError) return storeFailure(error);
    throw error;
  }
}

/**
 * The merge executor: completes at `start` (and again, idempotently, at
 * `recover` or `observe`: the output artifact's id follows from its content
 * and lineage). Register it once on `graphRuns.executors`.
 */
export function createGraphMergeExecutor(): GraphNodeExecutor {
  return {
    kind: "merge",
    start: runMerge,
    observe: runMerge,
    recover: runMerge,
    cancel: async () => ({ state: "cancelled" }),
  };
}

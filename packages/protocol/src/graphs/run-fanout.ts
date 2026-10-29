/**
 * `items` fan-out (item 401; report §4.4, §5.8; D9, D10): one branch per item
 * of a list artifact, bounded by `maxBranches`.
 *
 * The branch count is known only at run time, so the runtime records the
 * branch set it expanded to as a {@link GraphItemFanOut} on the run (one live
 * record per node position) and never recomputes it: retries, restarts and a
 * recovered backend read the same items.
 *
 * - **Items.** A `list<T>` input holds one item per element artifact; its id
 *   is the artifact's `sourceItem` (the upstream item an edge `flatten` cut
 *   it from), else the element's producer label (`review/panel.2`, a whole
 *   artifact as one item; `/item-<n>` added when several share a label). A
 *   named type that declares `items` holds one item per entry of its item
 *   list, with `graphArtifactItemIds`.
 * - **Branch keys.** `item.<encoded id>` ({@link graphItemBranchSegment}):
 *   derived from the item's stable id, not its position, so zip edges pair
 *   the same item and a branch key names its item. `/` becomes `:`, `+` (the
 *   axis separator) becomes `_`, `$` is dropped and anything else outside
 *   the branch key grammar becomes `-`; an encoding over 64 characters
 *   becomes `item.h-<16 hex of SHA-256>`, and an id that repeats in one
 *   fan-out gets `.2`, `.3`.
 * - **Truncation** is explicit: `truncate: "first"` runs the first
 *   `maxBranches` items and the record keeps `total` and the truncated ids;
 *   `"fail"` fails the node position before any branch starts (the runtime).
 * - **Supersession.** A rewind that supersedes one of a fan-out's source
 *   artifacts supersedes the fan-out too, so the position expands again from
 *   the live input; restarting one branch keeps it.
 *
 * Browser-safe: the run view draws item branches from here.
 */
import { graphNodeBranches, type GraphBranch } from "./run-branches.js";
import { graphArtifactItemIds, graphItemIdLabel, graphItemIdOwner } from "./run-items.js";
import type { ArtifactTypeItems } from "./artifact-type-def.js";
import type { GraphPlanNode } from "./plan.js";
import type {
  GraphArtifactProducer,
  GraphFanOutItem,
  GraphItemFanOut,
  GraphRun,
  NodeActivation,
} from "./run-model.js";
import { GRAPH_RUN_BOUNDS } from "./run-model.js";
import { sha256Hex } from "./sha256.js";
import type { GraphItemsTruncate } from "./template-model.js";

/** The axis segment every item branch key starts with. */
export const GRAPH_ITEM_BRANCH_PREFIX = "item.";
/** Characters of an encoded id before it is hashed instead. */
export const GRAPH_ITEM_BRANCH_ENCODED_MAX_CHARS = 64;

/** The `items` axis of a plan node, if it replicates over items. */
export function graphNodeItemsAxis(
  node: GraphPlanNode,
): { input: string; maxBranches: number; truncate: GraphItemsTruncate } | undefined {
  const replicate = node.kind === "agent" || node.kind === "subgraph" ? node.replicate : undefined;
  const axis = replicate?.axes.find((entry) => entry.over === "items");
  return axis?.over === "items"
    ? { input: axis.input, maxBranches: axis.maxBranches, truncate: axis.truncate ?? "first" }
    : undefined;
}

/** `item.<encoded id>`: an item's branch key segment (module comment). */
export function graphItemBranchSegment(id: string): string {
  const encoded = id
    .replaceAll("$", "")
    .replaceAll("/", ":")
    .replaceAll("+", "_")
    .replace(/[^A-Za-z0-9._:-]/g, "-");
  if (encoded.length === 0 || encoded.length > GRAPH_ITEM_BRANCH_ENCODED_MAX_CHARS) {
    return `${GRAPH_ITEM_BRANCH_PREFIX}h-${sha256Hex(id).slice(0, 16)}`;
  }
  return `${GRAPH_ITEM_BRANCH_PREFIX}${encoded}`;
}

/** One item of an input, before keys and truncation. */
export interface GraphItemCandidate {
  id: string;
  artifact: string;
}

/** What the runtime knows about one artifact of an items input. */
export interface GraphItemSourceArtifact {
  id: string;
  producer: GraphArtifactProducer;
  itemIds?: readonly string[];
  sourceItem?: string;
}

/**
 * The items of a `list<T>` input, one per element artifact in order: each
 * element's `sourceItem`, else its producer's label (`/item-<n>` added when
 * several elements share one).
 */
export function graphListItemCandidates(
  elements: readonly GraphItemSourceArtifact[],
): GraphItemCandidate[] {
  const labels = elements.map((element) =>
    element.sourceItem === undefined ? graphItemIdLabel(graphItemIdOwner(element.producer)) : null,
  );
  const shared = new Map<string, number>();
  for (const label of labels) {
    if (label !== null) shared.set(label, (shared.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return elements.map((element, index) => {
    const label = labels[index];
    if (label === null || label === undefined)
      return { id: element.sourceItem!, artifact: element.id };
    if (shared.get(label)! === 1) return { id: label, artifact: element.id };
    const occurrence = (seen.get(label) ?? 0) + 1;
    seen.set(label, occurrence);
    return { id: `${label}/item-${occurrence}`, artifact: element.id };
  });
}

/** The items of an input whose type declares `items`: one per entry, ids from `run-items.ts`. */
export function graphTypedItemCandidates(
  artifact: GraphItemSourceArtifact,
  items: ArtifactTypeItems,
  value: unknown,
): GraphItemCandidate[] {
  return graphArtifactItemIds(artifact, items, { value }).map((id) => ({
    id,
    artifact: artifact.id,
  }));
}

/**
 * Keys the candidates (repeats suffixed `.2`, `.3`) and cuts them to
 * `maxBranches`: the items that run, the input's total, and the ids that do
 * not run (at most {@link GRAPH_RUN_BOUNDS.maxTruncatedItemIds} by name).
 */
export function graphItemFanOutItems(
  candidates: readonly GraphItemCandidate[],
  maxBranches: number,
): { items: GraphFanOutItem[]; total: number; truncatedIds: string[] } {
  const used = new Set<string>();
  const items: GraphFanOutItem[] = [];
  const running = candidates.slice(0, Math.max(0, maxBranches));
  running.forEach((candidate, position) => {
    const base = graphItemBranchSegment(candidate.id);
    let key = base;
    for (let suffix = 2; used.has(key); suffix++) key = `${base}.${suffix}`;
    used.add(key);
    items.push({ key, index: position + 1, id: candidate.id, artifact: candidate.artifact });
  });
  return {
    items,
    total: candidates.length,
    truncatedIds: candidates
      .slice(running.length, running.length + GRAPH_RUN_BOUNDS.maxTruncatedItemIds)
      .map((candidate) => candidate.id),
  };
}

/** The live fan-out of one node position, if it expanded. */
export function graphLiveItemFanOut(
  run: Pick<GraphRun, "fanOuts">,
  nodeId: string,
  iteration: number,
): GraphItemFanOut | undefined {
  return run.fanOuts?.find(
    (fanOut) =>
      fanOut.nodeId === nodeId &&
      fanOut.iteration === iteration &&
      fanOut.supersededBy === undefined,
  );
}

/**
 * A node's branches at one position: `null` for an unreplicated node, the
 * static branches for one without an `items` axis, the fan-out's items
 * crossed with the other axes once it expanded, and `undefined` while it has
 * not expanded (or expanded to no items: the position is one unbranched,
 * skipped activation).
 */
export function graphRunNodeBranches(
  run: Pick<GraphRun, "fanOuts" | "bindings">,
  node: GraphPlanNode,
  iteration: number,
): GraphBranch[] | null | undefined {
  if (!graphNodeItemsAxis(node)) return graphNodeBranches(node, run.bindings.roles);
  const fanOut = graphLiveItemFanOut(run, node.id, iteration);
  if (!fanOut || fanOut.items.length === 0) return undefined;
  return graphNodeBranches(node, run.bindings.roles, fanOut.items);
}

/** The branch an activation runs (undefined for an unreplicated node or an unknown key). */
export function graphActivationBranch(
  run: Pick<GraphRun, "fanOuts" | "bindings">,
  node: GraphPlanNode,
  activation: Pick<NodeActivation, "iteration" | "branchKey">,
): GraphBranch | undefined {
  if (activation.branchKey === undefined) return undefined;
  return graphRunNodeBranches(run, node, activation.iteration)?.find(
    (branch) => branch.key === activation.branchKey,
  );
}

/**
 * The fan-outs with every live one whose sources include a superseded
 * artifact marked superseded by `rewindId` (the position expands again).
 */
export function supersedeGraphItemFanOuts(
  fanOuts: readonly GraphItemFanOut[] | undefined,
  rewindId: string,
  artifacts: ReadonlySet<string>,
): GraphItemFanOut[] | undefined {
  if (!fanOuts) return undefined;
  return fanOuts.map((fanOut) =>
    fanOut.supersededBy === undefined && fanOut.sources.some((id) => artifacts.has(id))
      ? { ...fanOut, supersededBy: rewindId }
      : fanOut,
  );
}

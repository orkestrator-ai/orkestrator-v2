/**
 * Stable item ids (plan P2.5; report §5.8, §5.9; D11): the one derivation the
 * agent executor (at accept time), merges, prompts and the provenance check
 * share.
 *
 * A value whose type declares `items` gives every element of that list an id
 * when it is accepted:
 *
 * ```
 * <node>[/iter-<n>][/<branch>]/<idPrefix>-<k>
 * ```
 *
 * `k` is 1-based; the iteration segment appears from iteration 2, the branch
 * segment only for a replicated node's branch. So `review/panel.2/issue-3` is
 * the third issue of the second panel model's report, and
 * `fix/iter-2/diagnosis-1` the first diagnosis of a loop's second round. This
 * generalises today's `reviewer-{pos}/issue-{n}`. Branch keys are stable
 * across retries (a retried branch keeps its key), so a retry's items keep
 * the ids a consolidator may already have seen.
 *
 * Ids are at most {@link GRAPH_ITEM_ID_MAX_CHARS} characters: a branch key too
 * long to fit is shortened to `b-<12 hex of its SHA-256>`, and a label still
 * too long becomes `<16 hex>` of the whole label's hash. Both are stable.
 *
 * A run input with items reads as `$input/<port>` (the producer's port is
 * the input's name). Browser-safe.
 */
import type { ArtifactTypeItems } from "./artifact-type-def.js";
import { parseGraphActivationKey } from "./run-identity.js";
import {
  GRAPH_ARTIFACT_BUDGETS,
  GRAPH_RUN_INPUT_PRODUCER,
  type GraphArtifactProducer,
} from "./run-model.js";
import { sha256Hex } from "./sha256.js";

/** Characters of one item id (the artifact guard's bound). */
export const GRAPH_ITEM_ID_MAX_CHARS = GRAPH_ARTIFACT_BUDGETS.maxItemIdChars;

/** What an item id is derived from: the producing activation's position. */
export interface GraphItemIdOwner {
  nodeId: string;
  iteration: number;
  branchKey?: string;
}

/** Characters `/<prefix>-<k>` needs for `count` items. */
function suffixChars(idPrefix: string, count: number): number {
  return 1 + idPrefix.length + 1 + String(Math.max(1, count)).length;
}

/**
 * The label every item id of one activation's output starts with:
 * `<node>[/iter-<n>][/<branch>]`, shortened when the ids would not fit.
 */
export function graphItemIdLabel(owner: GraphItemIdOwner, idPrefix = "item", count = 1): string {
  const head = [owner.nodeId, ...(owner.iteration > 1 ? [`iter-${owner.iteration}`] : [])];
  const room = GRAPH_ITEM_ID_MAX_CHARS - suffixChars(idPrefix, count);
  const full = [...head, ...(owner.branchKey !== undefined ? [owner.branchKey] : [])].join("/");
  if (full.length <= room) return full;
  if (owner.branchKey !== undefined) {
    const short = [...head, `b-${sha256Hex(owner.branchKey).slice(0, 12)}`].join("/");
    if (short.length <= room) return short;
  }
  return sha256Hex(full).slice(0, 16);
}

/** The ids of `count` items one activation produced, in list order. */
export function graphItemIds(owner: GraphItemIdOwner, idPrefix: string, count: number): string[] {
  const label = graphItemIdLabel(owner, idPrefix, count);
  return Array.from({ length: count }, (_, index) => `${label}/${idPrefix}-${index + 1}`);
}

/** The list a type's `items.path` names in a value, or undefined when it holds none. */
export function graphItemList(items: ArtifactTypeItems, value: unknown): unknown[] | undefined {
  let list: unknown = value;
  for (const segment of items.path.split(".")) {
    list =
      list && typeof list === "object" && !Array.isArray(list)
        ? (list as Record<string, unknown>)[segment]
        : undefined;
  }
  return Array.isArray(list) ? list : undefined;
}

/** The position an artifact's producer names, for deriving its item ids. */
export function graphItemIdOwner(producer: GraphArtifactProducer): GraphItemIdOwner {
  if (
    producer.nodeId === GRAPH_RUN_INPUT_PRODUCER &&
    producer.activation === GRAPH_RUN_INPUT_PRODUCER
  ) {
    return { nodeId: `${GRAPH_RUN_INPUT_PRODUCER}/${producer.port}`, iteration: 1 };
  }
  const parts = parseGraphActivationKey(producer.activation);
  if (!parts) return { nodeId: producer.nodeId, iteration: 1 };
  return {
    nodeId: parts.nodeId,
    iteration: parts.iteration,
    ...(parts.branchKey !== undefined ? { branchKey: parts.branchKey } : {}),
  };
}

/**
 * The stable ids of an artifact's items: the producer's recorded `itemIds`
 * when they match the item count, else derived from the producing
 * activation. `count` defaults to the length of the value's item list.
 * Empty when the type has no `items`.
 */
export function graphArtifactItemIds(
  artifact: { producer: GraphArtifactProducer; itemIds?: readonly string[] },
  items: ArtifactTypeItems | undefined,
  options: { value?: unknown; count?: number } = {},
): string[] {
  if (!items) return [];
  const count = options.count ?? graphItemList(items, options.value)?.length ?? 0;
  if (count === 0) return [];
  if (artifact.itemIds && artifact.itemIds.length === count) return [...artifact.itemIds];
  return graphItemIds(graphItemIdOwner(artifact.producer), items.idPrefix, count);
}

/**
 * The ids to record when an activation's value is accepted, or undefined
 * when its type has no `items` or the list is empty.
 */
export function graphAcceptedItemIds(
  items: ArtifactTypeItems | undefined,
  value: unknown,
  owner: GraphItemIdOwner,
): string[] | undefined {
  if (!items) return undefined;
  const list = graphItemList(items, value);
  if (!list || list.length === 0) return undefined;
  return graphItemIds(owner, items.idPrefix, list.length);
}

/**
 * `items` fan-out at run time (item 401; report §4.4, §5.8; D9, D10): the
 * branch set an `items` node position expands to, from its resolved items
 * input. Pure; the ready set (`graph-run-ready-set.ts`) calls it once the
 * position's inputs are resolved and its `when` holds, records the fan-out
 * on the view and creates the branch activations in the same round.
 *
 * - A `list<T>` input holds one item per element artifact (failure markers a
 *   fan-in collected are not items); a type that declares `items` holds one
 *   per entry of its item list. The ids and keys come from the protocol's
 *   `run-fanout.ts`.
 * - Items beyond `maxBranches` are truncated explicitly: `truncate: "first"`
 *   records the total and the truncated ids on the fan-out; `"fail"` fails
 *   the position with `budget-exceeded` before any branch starts.
 *
 * Messages carry node and port names and counts, never item values.
 */
import type { GraphPlanInputPort, GraphPlanNode } from "@orkestrator/protocol/graphs/compile";
import {
  graphItemFanOutItems,
  graphListItemCandidates,
  graphNodeItemsAxis,
  graphTypedItemCandidates,
  type GraphItemCandidate,
  type GraphItemFanOut,
  type GraphItemSourceArtifact,
} from "@orkestrator/protocol/graphs/run";
import type { GraphErrorCause } from "@orkestrator/protocol/graphs/types";
import type { GraphRunView } from "./graph-run-view.js";

export type GraphItemsExpansion =
  /** Artifact values (with their envelope facts) to load first. */
  | { kind: "pending"; missing: string[] }
  | { kind: "failed"; message: string; cause: GraphErrorCause }
  | { kind: "expanded"; fanOut: GraphItemFanOut };

/** Whether the port holds a list (one item per element) rather than one value with `items`. */
function isListPort(port: GraphPlanInputPort): boolean {
  return port.fanIn || port.type.startsWith("list<");
}

/**
 * The fan-out of an `items` node position, given the artifact ids its items
 * input resolved to (`ids`, without failure markers; empty when an optional
 * input is absent).
 */
export function expandGraphItems(
  view: GraphRunView,
  node: GraphPlanNode,
  iteration: number,
  ids: readonly string[],
  at: string,
): GraphItemsExpansion {
  const axis = graphNodeItemsAxis(node);
  const port = axis ? node.inputs.find((input) => input.name === axis.input) : undefined;
  if (!axis || !port) {
    return {
      kind: "failed",
      message: `${node.id} has no items input to replicate over`,
      cause: "system-error",
    };
  }
  const missing: string[] = [];
  let candidates: GraphItemCandidate[] = [];
  if (isListPort(port)) {
    const elements: GraphItemSourceArtifact[] = [];
    for (const id of ids) {
      const artifact = view.values.get(id)?.artifact;
      if (!artifact) {
        missing.push(id);
        continue;
      }
      elements.push({
        id,
        producer: artifact.producer,
        ...(artifact.itemIds ? { itemIds: artifact.itemIds } : {}),
        ...(artifact.sourceItem !== undefined ? { sourceItem: artifact.sourceItem } : {}),
      });
    }
    if (missing.length > 0) return { kind: "pending", missing };
    candidates = graphListItemCandidates(elements);
  } else if (ids.length > 0) {
    const id = ids[0]!;
    const loaded = view.values.get(id);
    if (!loaded?.artifact) return { kind: "pending", missing: [id] };
    const items = view.typeDefinition(loaded.artifact.type)?.items;
    if (!items) {
      return {
        kind: "failed",
        message: `Input ${port.name} of ${node.id} is a ${loaded.artifact.type}, which declares no items`,
        cause: "system-error",
      };
    }
    candidates = graphTypedItemCandidates(
      {
        id,
        producer: loaded.artifact.producer,
        ...(loaded.artifact.itemIds ? { itemIds: loaded.artifact.itemIds } : {}),
      },
      items,
      loaded.value,
    );
  }
  const { items, total, truncatedIds } = graphItemFanOutItems(candidates, axis.maxBranches);
  if (total > axis.maxBranches && axis.truncate === "fail") {
    return {
      kind: "failed",
      message: `Input ${port.name} holds ${total} items; ${node.id} runs at most ${axis.maxBranches} (truncate: fail)`,
      cause: "budget-exceeded",
    };
  }
  return {
    kind: "expanded",
    fanOut: {
      nodeId: node.id,
      iteration,
      sources: [...new Set(ids)],
      items,
      total,
      ...(truncatedIds.length > 0 ? { truncatedIds } : {}),
      createdAt: at,
    },
  };
}

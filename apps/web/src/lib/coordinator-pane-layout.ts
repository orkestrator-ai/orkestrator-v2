import { createUuid } from "@/lib/uuid";
import { MAX_SPLIT_DEPTH, type EdgeDirection } from "@/types/paneLayout";
import {
  collectCoordinatorLeaves,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLeaf,
  type CoordinatorPaneNode,
  type CoordinatorPaneSplit,
} from "@orkestrator/protocol/coordinator-pane-layout";

/**
 * Editing operations over a coordinator pane layout. The shape, bounds and
 * sanitizer live in the protocol, where the backend validates stored layouts.
 */
export {
  collectCoordinatorLeaves,
  sanitizeCoordinatorPaneLayout,
  type CoordinatorPaneLayout,
  type CoordinatorPaneLeaf,
  type CoordinatorPaneNode,
  type CoordinatorPaneSplit,
} from "@orkestrator/protocol/coordinator-pane-layout";

function generateId(prefix: string): string {
  return `${prefix}-${createUuid()}`;
}

function emptyLeaf(id = generateId("coordinator-pane")): CoordinatorPaneLeaf {
  return { kind: "leaf", id, conversationIds: [], activeConversationId: null };
}

export function findCoordinatorLeaf(
  node: CoordinatorPaneNode,
  paneId: string,
): CoordinatorPaneLeaf | null {
  return collectCoordinatorLeaves(node).find((leaf) => leaf.id === paneId) ?? null;
}

function depth(node: CoordinatorPaneNode): number {
  if (node.kind === "leaf") return 0;
  return 1 + Math.max(depth(node.children[0]), depth(node.children[1]));
}

function mapNode(
  node: CoordinatorPaneNode,
  fn: (node: CoordinatorPaneNode) => CoordinatorPaneNode,
): CoordinatorPaneNode {
  const mapped = fn(node);
  if (mapped !== node || mapped.kind === "leaf") return mapped;
  const first = mapNode(mapped.children[0], fn);
  const second = mapNode(mapped.children[1], fn);
  return first === mapped.children[0] && second === mapped.children[1]
    ? mapped
    : { ...mapped, children: [first, second] };
}

function updateLeaf(
  node: CoordinatorPaneNode,
  paneId: string,
  updater: (leaf: CoordinatorPaneLeaf) => CoordinatorPaneLeaf,
): CoordinatorPaneNode {
  return mapNode(node, (candidate) =>
    candidate.kind === "leaf" && candidate.id === paneId ? updater(candidate) : candidate,
  );
}

function withoutConversation(
  leaf: CoordinatorPaneLeaf,
  conversationId: string,
): CoordinatorPaneLeaf {
  const index = leaf.conversationIds.indexOf(conversationId);
  if (index === -1) return leaf;
  const conversationIds = leaf.conversationIds.filter((id) => id !== conversationId);
  return {
    ...leaf,
    conversationIds,
    // The neighbour that slides into the closed tab's place, like a browser.
    activeConversationId:
      leaf.activeConversationId === conversationId
        ? (conversationIds[Math.min(index, conversationIds.length - 1)] ?? null)
        : leaf.activeConversationId,
  };
}

/** Drops empty panes, keeping one (possibly empty) pane so the page has a strip. */
function pruneEmpty(node: CoordinatorPaneNode): CoordinatorPaneNode | null {
  if (node.kind === "leaf") return node.conversationIds.length > 0 ? node : null;
  const first = pruneEmpty(node.children[0]);
  const second = pruneEmpty(node.children[1]);
  if (!first) return second;
  if (!second) return first;
  return first === node.children[0] && second === node.children[1]
    ? node
    : { ...node, children: [first, second] };
}

function settle(
  layout: CoordinatorPaneLayout,
  previous: CoordinatorPaneLayout,
): CoordinatorPaneLayout {
  const firstLeafId = collectCoordinatorLeaves(previous.root)[0]?.id;
  // An empty root leaf is kept as it is: replacing it with an equal new one
  // would make every reconcile look like a change.
  const root =
    pruneEmpty(layout.root) ?? (layout.root.kind === "leaf" ? layout.root : emptyLeaf(firstLeafId));
  const leaves = collectCoordinatorLeaves(root);
  const activePaneId = leaves.some((leaf) => leaf.id === layout.activePaneId)
    ? layout.activePaneId
    : leaves[0]!.id;
  if (root === previous.root && activePaneId === previous.activePaneId) return previous;
  return { root, activePaneId };
}

/**
 * Follows the backend's open conversations.
 *
 * Closed conversations leave their pane (an emptied pane collapses into its
 * sibling), duplicates are dropped, and open conversations no pane holds yet —
 * a new side agent, a main started by mail — join the focused pane. Returns
 * the same object when nothing changes, so callers can compare by identity.
 */
export function reconcileCoordinatorLayout(
  layout: CoordinatorPaneLayout | null | undefined,
  openConversationIds: readonly string[],
): CoordinatorPaneLayout {
  if (!layout) {
    const leaf: CoordinatorPaneLeaf = {
      ...emptyLeaf(),
      conversationIds: [...openConversationIds],
      activeConversationId: openConversationIds[0] ?? null,
    };
    return { root: leaf, activePaneId: leaf.id };
  }

  const open = new Set(openConversationIds);
  const placed = new Set<string>();
  const root = mapNode(layout.root, (node) => {
    if (node.kind !== "leaf") return node;
    const conversationIds = node.conversationIds.filter((id) => {
      if (!open.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    });
    let leaf = node;
    if (conversationIds.length !== node.conversationIds.length) {
      const previousIndex = node.conversationIds.indexOf(node.activeConversationId ?? "");
      leaf = {
        ...node,
        conversationIds,
        activeConversationId: conversationIds.includes(node.activeConversationId ?? "")
          ? node.activeConversationId
          : (conversationIds[Math.min(Math.max(previousIndex, 0), conversationIds.length - 1)] ??
            null),
      };
    }
    if (leaf.activeConversationId === null && leaf.conversationIds.length > 0) {
      leaf = { ...leaf, activeConversationId: leaf.conversationIds[0]! };
    }
    return leaf;
  });
  let next = settle({ root, activePaneId: layout.activePaneId }, layout);

  const unplaced = openConversationIds.filter((id) => !placed.has(id));
  if (unplaced.length > 0) {
    next = {
      ...next,
      root: updateLeaf(next.root, next.activePaneId, (leaf) => ({
        ...leaf,
        conversationIds: [...leaf.conversationIds, ...unplaced],
        activeConversationId: leaf.activeConversationId ?? unplaced[0]!,
      })),
    };
  }
  return next;
}

/** Focuses a pane and, when given, one of its conversations. */
export function focusCoordinatorPane(
  layout: CoordinatorPaneLayout,
  paneId: string,
  conversationId?: string,
): CoordinatorPaneLayout {
  const leaf = findCoordinatorLeaf(layout.root, paneId);
  if (!leaf) return layout;
  const activate =
    conversationId !== undefined &&
    leaf.conversationIds.includes(conversationId) &&
    leaf.activeConversationId !== conversationId;
  if (!activate && layout.activePaneId === paneId) return layout;
  return {
    root: activate
      ? updateLeaf(layout.root, paneId, (current) => ({
          ...current,
          activeConversationId: conversationId,
        }))
      : layout.root,
    activePaneId: paneId,
  };
}

/** Brings a conversation to the front of whichever pane holds it, and focuses that pane. */
export function revealCoordinatorConversation(
  layout: CoordinatorPaneLayout,
  conversationId: string,
): CoordinatorPaneLayout {
  const leaf = collectCoordinatorLeaves(layout.root).find((candidate) =>
    candidate.conversationIds.includes(conversationId),
  );
  return leaf ? focusCoordinatorPane(layout, leaf.id, conversationId) : layout;
}

/** The conversation the user is working in: the focused pane's front tab. */
export function focusedCoordinatorConversationId(layout: CoordinatorPaneLayout): string | null {
  return findCoordinatorLeaf(layout.root, layout.activePaneId)?.activeConversationId ?? null;
}

export function reorderCoordinatorConversations(
  layout: CoordinatorPaneLayout,
  paneId: string,
  fromIndex: number,
  toIndex: number,
): CoordinatorPaneLayout {
  const leaf = findCoordinatorLeaf(layout.root, paneId);
  if (
    !leaf ||
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= leaf.conversationIds.length ||
    toIndex >= leaf.conversationIds.length
  ) {
    return layout;
  }
  const conversationIds = [...leaf.conversationIds];
  const [moved] = conversationIds.splice(fromIndex, 1);
  conversationIds.splice(toIndex, 0, moved!);
  return {
    ...layout,
    root: updateLeaf(layout.root, paneId, (current) => ({ ...current, conversationIds })),
  };
}

/** Moves a tab into another tab group; an emptied source group closes. */
export function moveCoordinatorConversation(
  layout: CoordinatorPaneLayout,
  fromPaneId: string,
  toPaneId: string,
  conversationId: string,
  toIndex?: number,
): CoordinatorPaneLayout {
  const from = findCoordinatorLeaf(layout.root, fromPaneId);
  const to = findCoordinatorLeaf(layout.root, toPaneId);
  if (!from || !to || !from.conversationIds.includes(conversationId)) return layout;
  if (fromPaneId === toPaneId) {
    return toIndex === undefined
      ? layout
      : reorderCoordinatorConversations(
          layout,
          fromPaneId,
          from.conversationIds.indexOf(conversationId),
          toIndex,
        );
  }
  let root = updateLeaf(layout.root, fromPaneId, (leaf) =>
    withoutConversation(leaf, conversationId),
  );
  root = updateLeaf(root, toPaneId, (leaf) => {
    const conversationIds = [...leaf.conversationIds];
    conversationIds.splice(toIndex ?? conversationIds.length, 0, conversationId);
    return { ...leaf, conversationIds, activeConversationId: conversationId };
  });
  return settle({ root, activePaneId: toPaneId }, layout);
}

/** Drops a tab on a pane edge: that pane splits and the tab opens a new group there. */
export function splitCoordinatorPaneAtEdge(
  layout: CoordinatorPaneLayout,
  targetPaneId: string,
  edge: EdgeDirection,
  conversationId: string,
  fromPaneId: string,
): CoordinatorPaneLayout {
  const target = findCoordinatorLeaf(layout.root, targetPaneId);
  const source = findCoordinatorLeaf(layout.root, fromPaneId);
  if (!target || !source || !source.conversationIds.includes(conversationId)) return layout;
  // Splitting a lone tab off its own pane would leave an empty group behind.
  if (targetPaneId === fromPaneId && source.conversationIds.length < 2) return layout;
  if (depth(layout.root) >= MAX_SPLIT_DEPTH) return layout;

  const newPane: CoordinatorPaneLeaf = {
    ...emptyLeaf(),
    conversationIds: [conversationId],
    activeConversationId: conversationId,
  };
  const root = updateLeaf(layout.root, fromPaneId, (leaf) =>
    withoutConversation(leaf, conversationId),
  );
  const updatedTarget = findCoordinatorLeaf(root, targetPaneId)!;
  const split: CoordinatorPaneSplit = {
    kind: "split",
    id: generateId("coordinator-split"),
    direction: edge === "left" || edge === "right" ? "horizontal" : "vertical",
    children:
      edge === "left" || edge === "top" ? [newPane, updatedTarget] : [updatedTarget, newPane],
    sizes: [50, 50],
  };
  const replaced = mapNode(root, (node) => (node.id === targetPaneId ? split : node));
  return settle({ root: replaced, activePaneId: newPane.id }, layout);
}

export function resizeCoordinatorSplit(
  layout: CoordinatorPaneLayout,
  splitId: string,
  sizes: [number, number],
): CoordinatorPaneLayout {
  const root = mapNode(layout.root, (node) =>
    node.kind === "split" &&
    node.id === splitId &&
    (node.sizes[0] !== sizes[0] || node.sizes[1] !== sizes[1])
      ? { ...node, sizes }
      : node,
  );
  return root === layout.root ? layout : { ...layout, root };
}

/**
 * Coordinator pane layouts: shared shape, bounds and the backend record.
 *
 * Browser-safe. The backend stores one layout per project (revision-checked)
 * so every client shows the same tab groups; the web client owns the editing
 * operations (`apps/web/src/lib/coordinator-pane-layout.ts`).
 */

/** Deepest split tree a stored layout may hold (matches environment pane layouts). */
export const COORDINATOR_PANE_MAX_SPLIT_DEPTH = 9;
/** Serialized bytes one stored layout may take. */
export const COORDINATOR_PANE_LAYOUT_MAX_BYTES = 64 * 1024;

/**
 * How the coordinator page arranges its conversation tabs into tab groups.
 *
 * The same split tree as an environment's pane layout, except that a leaf holds
 * conversation ids rather than tab records: conversations themselves are owned
 * by the backend workspace, so this is presentation only. It never opens or
 * closes a conversation; it only follows the backend's open set.
 */
export interface CoordinatorPaneLeaf {
  kind: "leaf";
  id: string;
  conversationIds: string[];
  activeConversationId: string | null;
}

export interface CoordinatorPaneSplit {
  kind: "split";
  id: string;
  direction: "horizontal" | "vertical";
  children: [CoordinatorPaneNode, CoordinatorPaneNode];
  sizes: [number, number];
}

export type CoordinatorPaneNode = CoordinatorPaneLeaf | CoordinatorPaneSplit;

export interface CoordinatorPaneLayout {
  root: CoordinatorPaneNode;
  activePaneId: string;
}

export function collectCoordinatorLeaves(node: CoordinatorPaneNode): CoordinatorPaneLeaf[] {
  if (node.kind === "leaf") return [node];
  return [
    ...collectCoordinatorLeaves(node.children[0]),
    ...collectCoordinatorLeaves(node.children[1]),
  ];
}

const MAX_PERSISTED_ID_LENGTH = 200;

function isPersistedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_PERSISTED_ID_LENGTH;
}

function sanitizeNode(
  value: unknown,
  level: number,
  nodeIds: Set<string>,
): CoordinatorPaneNode | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isPersistedId(record.id) || nodeIds.has(record.id)) return null;
  nodeIds.add(record.id);
  if (record.kind === "leaf") {
    if (!Array.isArray(record.conversationIds)) return null;
    const conversationIds = Array.from(new Set(record.conversationIds.filter(isPersistedId))).slice(
      0,
      64,
    );
    return {
      kind: "leaf",
      id: record.id,
      conversationIds,
      activeConversationId:
        isPersistedId(record.activeConversationId) &&
        conversationIds.includes(record.activeConversationId)
          ? record.activeConversationId
          : (conversationIds[0] ?? null),
    };
  }
  if (record.kind !== "split" || level >= COORDINATOR_PANE_MAX_SPLIT_DEPTH) return null;
  if (record.direction !== "horizontal" && record.direction !== "vertical") return null;
  if (!Array.isArray(record.children) || record.children.length !== 2) return null;
  const first = sanitizeNode(record.children[0], level + 1, nodeIds);
  const second = sanitizeNode(record.children[1], level + 1, nodeIds);
  if (!first || !second) return null;
  const sizes = Array.isArray(record.sizes) ? record.sizes : [];
  const valid = (size: unknown): size is number =>
    typeof size === "number" && Number.isFinite(size) && size > 0 && size < 100;
  return {
    kind: "split",
    id: record.id,
    direction: record.direction,
    children: [first, second],
    sizes: valid(sizes[0]) && valid(sizes[1]) ? [sizes[0], sizes[1]] : [50, 50],
  };
}

/** Bounds an untrusted persisted layout; returns null when it cannot be used. */
export function sanitizeCoordinatorPaneLayout(value: unknown): CoordinatorPaneLayout | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const root = sanitizeNode(record.root, 0, new Set());
  if (!root) return null;
  const leaves = collectCoordinatorLeaves(root);
  const activePaneId = leaves.some((leaf) => leaf.id === record.activePaneId)
    ? (record.activePaneId as string)
    : leaves[0]!.id;
  return { root, activePaneId };
}

/** One project's stored layout. `revision` starts at 1 and moves on every save. */
export interface CoordinatorPaneLayoutRecord {
  projectId: string;
  layout: CoordinatorPaneLayout;
  revision: number;
  updatedAt: string;
}

/**
 * A save is a compare-and-swap on `revision`; `expectedRevision: 0` means
 * "only if none is stored". A conflict returns the stored record (or null) so
 * the client adopts what another client saved.
 */
export type CoordinatorPaneLayoutSaveResult =
  | { status: "saved"; record: CoordinatorPaneLayoutRecord }
  | { status: "conflict"; current: CoordinatorPaneLayoutRecord | null };

export function parseCoordinatorPaneLayoutRecord(
  value: unknown,
): CoordinatorPaneLayoutRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const layout = sanitizeCoordinatorPaneLayout(record.layout);
  if (
    !layout ||
    !isPersistedId(record.projectId) ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    typeof record.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    projectId: record.projectId,
    layout,
    revision: record.revision as number,
    updatedAt: record.updatedAt,
  };
}

export function parseCoordinatorPaneLayoutSaveResult(
  value: unknown,
): CoordinatorPaneLayoutSaveResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.status === "saved") {
    const record = parseCoordinatorPaneLayoutRecord(result.record);
    return record ? { status: "saved", record } : null;
  }
  if (result.status === "conflict") {
    return {
      status: "conflict",
      current: result.current === null ? null : parseCoordinatorPaneLayoutRecord(result.current),
    };
  }
  return null;
}

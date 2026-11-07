import { create } from "zustand";
import { persist } from "zustand/middleware";
import { windowStorageKey } from "@/lib/desktop-storage-key";

/**
 * Which other nodes this window shows in its own React tree instead of a
 * workspace realm (plan item 4001, report §12 Phase 4).
 *
 * A per-window device setting, default empty, persisted under the window's
 * key and edited per machine in Settings → Machines. It is a rollback switch
 * while in-tree workspaces reach parity, not version skew: any node can be
 * shown either way, so nothing here depends on the node's version
 * (`docs/architecture/version-compatibility.md`). Phase 6 deletes realms and
 * this setting with them.
 *
 * Development override: `VITE_ORKESTRATOR_IN_TREE_NODES` in a development
 * build, a comma-separated list of node ids or `*` for every node, is added
 * to the stored list (it never removes one).
 */
interface InTreeNodesState {
  /** Node ids, unique, in the order they were turned on. */
  nodes: string[];
  setInTree: (nodeId: string, inTree: boolean) => void;
}

/** Most nodes one window keeps a choice for; the oldest goes first. */
export const MAX_IN_TREE_NODES = 64;
const MAX_NODE_ID_LENGTH = 200;

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_NODE_ID_LENGTH;
}

/** A stored list, bounded and deduplicated; anything else is empty. */
export function normalizeInTreeNodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isNodeId))].slice(-MAX_IN_TREE_NODES);
}

export const useInTreeNodesStore = create<InTreeNodesState>()(
  persist(
    (set, get) => ({
      nodes: [],
      setInTree: (nodeId, inTree) => {
        if (!isNodeId(nodeId)) return;
        const without = get().nodes.filter((id) => id !== nodeId);
        set({ nodes: inTree ? [...without, nodeId].slice(-MAX_IN_TREE_NODES) : without });
      },
    }),
    {
      name: windowStorageKey("in-tree-nodes"),
      version: 1,
      partialize: (state) => ({ nodes: state.nodes }),
      merge: (persisted, current) => ({
        ...current,
        nodes: normalizeInTreeNodes((persisted as { nodes?: unknown } | undefined)?.nodes),
      }),
    },
  ),
);

/** The development override's node ids, `"*"` for all, or none. */
export function developmentInTreeOverride(
  env: Record<string, unknown> | undefined = import.meta.env as unknown as
    Record<string, unknown> | undefined,
): ReadonlySet<string> | "*" {
  if (env?.DEV !== true) return new Set();
  const raw = env.VITE_ORKESTRATOR_IN_TREE_NODES;
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  if (raw.trim() === "*") return "*";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(isNodeId),
  );
}

/** Whether `nodeId` is shown in the window's tree, for `stored` and an override. */
export function isInTreeNode(
  nodeId: string,
  stored: readonly string[],
  override: ReadonlySet<string> | "*" = developmentInTreeOverride(),
): boolean {
  return override === "*" || override.has(nodeId) || stored.includes(nodeId);
}

/** Whether this window shows `nodeId` in its own tree. */
export function useInTreeNode(nodeId: string): boolean {
  return useInTreeNodesStore((state) => isInTreeNode(nodeId, state.nodes));
}

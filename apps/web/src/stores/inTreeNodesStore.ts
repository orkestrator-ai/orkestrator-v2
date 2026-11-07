import { create } from "zustand";
import { persist } from "zustand/middleware";
import { windowStorageKey } from "@/lib/desktop-storage-key";

/**
 * Whether this window shows other nodes' workspaces in its own React tree
 * (plan item 6001, report §12 Phase 6.1).
 *
 * Every node renders in-tree by default, on desktop, browser and iOS. The one
 * setting, `useRealmsForRemoteMachines` (default off), brings back the
 * separate workspace views (realms) for every other node in this window, as a
 * rollback for one release. It is a per-window device setting, persisted
 * under the window's key and edited in Settings → Machines. It is a rollback
 * switch, not version skew: any node can be shown either way, so nothing here
 * depends on the node's version (`docs/architecture/version-compatibility.md`).
 * Plan items 6002 and 6003 delete realms and this setting with them.
 *
 * It replaces 4001's per-node opt-in list (`in-tree-nodes`), which is no
 * longer read: with in-tree the default, the opt-in has nothing to add.
 */
interface InTreeNodesState {
  /** The rollback: show other nodes in separate workspace views. Default off. */
  useRealmsForRemoteMachines: boolean;
  setUseRealmsForRemoteMachines: (on: boolean) => void;
}

export const useInTreeNodesStore = create<InTreeNodesState>()(
  persist(
    (set) => ({
      useRealmsForRemoteMachines: false,
      setUseRealmsForRemoteMachines: (on) => set({ useRealmsForRemoteMachines: on === true }),
    }),
    {
      name: windowStorageKey("use-realms-for-remote-machines"),
      version: 1,
      partialize: (state) => ({ useRealmsForRemoteMachines: state.useRealmsForRemoteMachines }),
      merge: (persisted, current) => ({
        ...current,
        useRealmsForRemoteMachines:
          (persisted as { useRealmsForRemoteMachines?: unknown } | undefined)
            ?.useRealmsForRemoteMachines === true,
      }),
    },
  ),
);

/**
 * Whether this window shows other nodes in its own tree: true unless the
 * rollback is on. Every node is treated the same.
 */
export function nodesInTree(
  state: Pick<InTreeNodesState, "useRealmsForRemoteMachines"> = useInTreeNodesStore.getState(),
): boolean {
  return !state.useRealmsForRemoteMachines;
}

/** Whether this window shows other nodes in its own tree (a hook). */
export function useNodesInTree(): boolean {
  return useInTreeNodesStore(nodesInTree);
}

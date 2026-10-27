import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SidebarGrouping } from "@/lib/federation/aggregate";

const MAX_COLLAPSED_ENTRIES = 2048;
/** Recently used projects and environments, newest first, across machines. */
export const MAX_RECENT_KEYS = 64;

function toggled(list: readonly string[], key: string, collapsed?: boolean): string[] {
  const has = list.includes(key);
  const next = collapsed ?? !has;
  if (next === has) return list as string[];
  return next
    ? [...list, key].slice(-MAX_COLLAPSED_ENTRIES)
    : list.filter((entry) => entry !== key);
}

/**
 * This client's cross-machine presentation: the machine filter and
 * grouping, and what is collapsed in the multi-machine sidebar. It is
 * client-local by design — filters are not backend state — and every entry names a machine by its identity, never by a route or
 * forwarded port. Hiding a machine or changing the filter is presentation
 * only: it never stops an agent or touches a backend.
 */

export interface MachineCollapseState {
  /** Every project of the machine; their keys not in `collapsedProjectKeys` are expanded. */
  projectKeys: readonly string[];
  collapsedProjectKeys: readonly string[];
  /** `sidebarFolderKey(machineId, "")`: every folder of the machine. */
  folderPrefix: string;
  folderKeys?: readonly string[];
  collapsedFolderKeys: readonly string[];
}

interface MachineViewState {
  /** `"all"` or a machine identity. Filters presentation, never connections. */
  machineFilter: string;
  grouping: Exclude<SidebarGrouping, "activity">;
  /** Show just the dot (plus tooltip) instead of the machine name label. */
  compactMachineLabels: boolean;
  /**
   * Collapsed machine sections, projects (by project key) and folders (by
   * `sidebarFolderKey`). Kept with the window rather than the workspace node,
   * so the sidebar stays as it was when the window moves to another node.
   */
  collapsedMachines: string[];
  collapsedProjectKeys: string[];
  collapsedFolderKeys: string[];
  /** Machines whose own collapse state has been carried over into the keys above. */
  seededMachines: string[];
  knownProjectKeys: string[];
  knownFolderKeys: string[];
  /**
   * Node-qualified project and environment keys (`projectKey`,
   * `environmentKey`), most recently used first, on any machine. The project
   * search ranks by it. View state of this client only, like the sidebar's
   * own recent projects, and never resolved against this window's stores.
   */
  recentKeys: string[];
  /**
   * The other machine's project the search last revealed, highlighted in the
   * sidebar until something else is selected. `revision` re-scrolls to it
   * when the same project is chosen again. Not persisted.
   */
  revealedProject: { key: string; revision: number } | null;
  setMachineFilter: (filter: string) => void;
  setGrouping: (grouping: Exclude<SidebarGrouping, "activity">) => void;
  setCompactMachineLabels: (compact: boolean) => void;
  setMachineCollapsed: (machineId: string, collapsed?: boolean) => void;
  setProjectKeyCollapsed: (key: string, collapsed?: boolean) => void;
  setFolderKeyCollapsed: (key: string, collapsed?: boolean) => void;
  /** Replaces one machine's collapsed projects and folders. */
  setMachineCollapseState: (machineId: string, state: MachineCollapseState) => void;
  /** Moves keys to the front of `recentKeys`, the first one newest. */
  recordRecent: (keys: readonly string[]) => void;
  revealProject: (key: string | null) => void;
}

export function withRecentKeys(list: readonly string[], keys: readonly string[]): string[] {
  const fresh = keys.filter((key, index) => key && keys.indexOf(key) === index);
  if (fresh.length === 0) return list as string[];
  if (fresh.every((key, index) => list[index] === key)) return list as string[];
  return [...fresh, ...list.filter((key) => !fresh.includes(key))].slice(0, MAX_RECENT_KEYS);
}

/**
 * A folder's collapse key in the multi-machine sidebar: the machine it is on
 * ("by machine"), or the merged list it is in ("by project", "by repository").
 */
export function sidebarFolderKey(scope: string, folderKey: string): string {
  return `${scope}/${folderKey}`;
}

export const useMachineViewStore = create<MachineViewState>()(
  persist(
    (set) => ({
      machineFilter: "all",
      grouping: "machine",
      compactMachineLabels: false,
      collapsedMachines: [],
      collapsedProjectKeys: [],
      collapsedFolderKeys: [],
      seededMachines: [],
      knownProjectKeys: [],
      knownFolderKeys: [],
      recentKeys: [],
      revealedProject: null,
      setMachineFilter: (machineFilter) => set({ machineFilter }),
      setGrouping: (grouping) => set({ grouping }),
      setCompactMachineLabels: (compactMachineLabels) => set({ compactMachineLabels }),
      setMachineCollapsed: (machineId, collapsed) =>
        set((state) => ({
          collapsedMachines: toggled(state.collapsedMachines, machineId, collapsed),
        })),
      setProjectKeyCollapsed: (key, collapsed) =>
        set((state) => ({
          collapsedProjectKeys: toggled(state.collapsedProjectKeys, key, collapsed),
          knownProjectKeys: toggled(state.knownProjectKeys, key, true),
        })),
      setFolderKeyCollapsed: (key, collapsed) =>
        set((state) => ({
          collapsedFolderKeys: toggled(state.collapsedFolderKeys, key, collapsed),
          knownFolderKeys: toggled(state.knownFolderKeys, key, true),
        })),
      setMachineCollapseState: (machineId, next) =>
        set((state) => {
          const projectKeys = new Set(next.projectKeys);
          return {
            knownProjectKeys: Array.from(
              new Set([...state.knownProjectKeys, ...next.projectKeys]),
            ).slice(-MAX_COLLAPSED_ENTRIES),
            knownFolderKeys: Array.from(
              new Set([
                ...state.knownFolderKeys,
                ...(next.folderKeys ?? []),
                ...next.collapsedFolderKeys,
              ]),
            ).slice(-MAX_COLLAPSED_ENTRIES),
            collapsedProjectKeys: [
              ...state.collapsedProjectKeys.filter((key) => !projectKeys.has(key)),
              ...next.collapsedProjectKeys,
            ].slice(-MAX_COLLAPSED_ENTRIES),
            collapsedFolderKeys: [
              ...state.collapsedFolderKeys.filter((key) => !key.startsWith(next.folderPrefix)),
              ...next.collapsedFolderKeys,
            ].slice(-MAX_COLLAPSED_ENTRIES),
            seededMachines: state.seededMachines.includes(machineId)
              ? state.seededMachines
              : [...state.seededMachines, machineId].slice(-MAX_COLLAPSED_ENTRIES),
          };
        }),
      recordRecent: (keys) =>
        set((state) => {
          const recentKeys = withRecentKeys(state.recentKeys, keys);
          return recentKeys === state.recentKeys ? state : { recentKeys };
        }),
      revealProject: (key) =>
        set((state) =>
          key === null && state.revealedProject === null
            ? state
            : {
                revealedProject:
                  key === null
                    ? null
                    : { key, revision: (state.revealedProject?.revision ?? 0) + 1 },
              },
        ),
    }),
    {
      name: "machine-view-storage",
      partialize: (state) => ({
        machineFilter: state.machineFilter,
        grouping: state.grouping,
        compactMachineLabels: state.compactMachineLabels,
        collapsedMachines: state.collapsedMachines,
        collapsedProjectKeys: state.collapsedProjectKeys,
        collapsedFolderKeys: state.collapsedFolderKeys,
        seededMachines: state.seededMachines,
        knownProjectKeys: state.knownProjectKeys,
        knownFolderKeys: state.knownFolderKeys,
        recentKeys: state.recentKeys,
      }),
    },
  ),
);

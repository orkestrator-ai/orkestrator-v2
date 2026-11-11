import type { StateCreator } from "zustand";
import { persist } from "zustand/middleware";
import { defineScopedStore, scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { nodeStorageKey } from "@/lib/persistence-keys";

/** Projects whose Linear view is remembered (least recently changed dropped first). */
export const MAX_LINEAR_VIEW_PROJECTS = 100;
/** Hidden lanes remembered per project. */
export const MAX_HIDDEN_LINEAR_LANES = 50;

export type LinearIssueView = "list" | "board";

export interface LinearProjectView {
  view: LinearIssueView;
  /** Workflow state names whose lane the board view hides. */
  hiddenLanes: string[];
  updatedAt: number;
}

export interface LinearViewPreferencesState {
  projects: Record<string, LinearProjectView>;
  setView: (projectId: string, view: LinearIssueView) => void;
  setLaneHidden: (projectId: string, lane: string, hidden: boolean) => void;
  showAllLanes: (projectId: string) => void;
}

export const DEFAULT_LINEAR_PROJECT_VIEW: LinearProjectView = {
  view: "list",
  hiddenLanes: [],
  updatedAt: 0,
};

function bounded(projects: Record<string, LinearProjectView>): Record<string, LinearProjectView> {
  const entries = Object.entries(projects);
  if (entries.length <= MAX_LINEAR_VIEW_PROJECTS) return projects;
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_LINEAR_VIEW_PROJECTS),
  );
}

function update(
  state: LinearViewPreferencesState,
  projectId: string,
  change: (current: LinearProjectView) => Omit<LinearProjectView, "updatedAt">,
): Pick<LinearViewPreferencesState, "projects"> {
  const current = state.projects[projectId] ?? DEFAULT_LINEAR_PROJECT_VIEW;
  return {
    projects: bounded({
      ...state.projects,
      [projectId]: { ...change(current), updatedAt: Date.now() },
    }),
  };
}

/**
 * Durable renderer UI preference: each project's Linear tab view (list or
 * board) and the board lanes the user hid. It only changes what the tab shows;
 * nothing is sent to Linear. Kept per node, like other per-project view
 * state: project ids belong to their node (`nodeStorageKey`).
 */
export const linearViewPreferencesStore = defineScopedStore<LinearViewPreferencesState>(
  "linear-view-preferences",
  (scope) => {
    const creator: StateCreator<
      LinearViewPreferencesState,
      [],
      [["zustand/persist", Pick<LinearViewPreferencesState, "projects">]]
    > = persist(
      (set) => ({
        projects: {},
        setView: (projectId, view) =>
          set((state) => update(state, projectId, (current) => ({ ...current, view }))),
        setLaneHidden: (projectId, lane, hidden) =>
          set((state) =>
            update(state, projectId, (current) => {
              const others = current.hiddenLanes.filter((name) => name !== lane);
              return {
                ...current,
                hiddenLanes: hidden ? [...others, lane].slice(-MAX_HIDDEN_LINEAR_LANES) : others,
              };
            }),
          ),
        showAllLanes: (projectId) =>
          set((state) => update(state, projectId, (current) => ({ ...current, hiddenLanes: [] }))),
      }),
      {
        name: nodeStorageKey("linear-view-preferences", scope),
        partialize: (state) => ({ projects: state.projects }),
      },
    );
    // `persist` adds its `persist` API to the store; nothing here reads it.
    return creator as StateCreator<LinearViewPreferencesState>;
  },
);

/** The nearest node scope's Linear view preferences. */
export const useLinearViewPreferencesStore = scopedStoreHook(linearViewPreferencesStore);

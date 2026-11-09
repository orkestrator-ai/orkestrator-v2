import type { StateCreator } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { projectFolderKey } from "@orkestrator/protocol/project-folders";
import { scopeNodeIsLeaf } from "@/lib/federation/leaf-node";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import { windowScopeOf, type NodeSelection } from "@/lib/node-scope/window-scope";
import { nodeStorageKey } from "@/lib/persistence-keys";
import { createUIStateStorage, UI_NODE_PERSISTED_FIELDS } from "@/lib/ui-state-storage";
import { selectionOnScope } from "./windowSelectionStore";

export type { ActivitySortOrder, EnvironmentSortMode } from "./uiChromeStore";

const RECENT_PROJECT_LIMIT = 5;

const isFolderCollapsed = (collapsed: string[], folder: string): boolean =>
  collapsed.some((name) => projectFolderKey(name) === projectFolderKey(folder));

const withoutFolder = (collapsed: string[], folder: string): string[] =>
  collapsed.filter((name) => projectFolderKey(name) !== projectFolderKey(folder));

const addRecentProject = (recentProjectIds: string[], projectId: string): string[] =>
  [projectId, ...recentProjectIds.filter((id) => id !== projectId)].slice(0, RECENT_PROJECT_LIMIT);

/**
 * The panel a project's page shows. `home` is the project home's own tabs;
 * the rest are the project board.
 */
export type ProjectBoardTab =
  | "home"
  | "coordinator"
  | "schedules"
  | "kanban"
  | "github"
  | "linear"
  | "features"
  | "notes"
  | "pull-requests";

/**
 * A project opens on its coordinator, except on a leaf node: coordination
 * happens on the command node, so a leaf's project opens on its home.
 */
const projectLandingBoardTab = (scope: NodeScope): ProjectBoardTab =>
  scopeNodeIsLeaf(scope) ? "home" : "coordinator";

/**
 * One node's UI state (report §7.1 class (d), plan item 3006). Project and
 * environment ids are node-local, so each node scope has its own.
 *
 * `selectedProjectId` and `selectedEnvironmentId` are this node's projection
 * of the window's one node-qualified selection (`WindowScope.selection`):
 * they hold the selection while it is on this node and are null while the
 * window shows another node (or nothing). Selecting here moves the window's
 * selection to this node. The window's chrome (sidebar, zoom, sort, graph
 * heights) is `uiChromeStore`, shared by every node.
 */
export interface UIState {
  selectedProjectId: string | null;
  /** Explicit project navigation, including reselecting the same row. */
  projectSelectionRevision: number;
  selectedEnvironmentId: string | null;
  /** Most recently opened project IDs, newest first. */
  recentProjectIds: string[];
  projectBoardTab: ProjectBoardTab;
  /** Project IDs that are collapsed in the hierarchical sidebar */
  collapsedProjects: string[];
  /** Projects with an explicit collapse choice; defaults may still apply to the others. */
  projectCollapseChoices: string[];
  /**
   * Sidebar folder names that are collapsed. Keyed by name because a folder
   * has no record of its own — see `@orkestrator/protocol/project-folders`.
   */
  collapsedProjectFolders: string[];
  /** Environment IDs selected in multi-select mode */
  selectedEnvironmentIds: string[];
  /** Environment IDs that have their sessions section expanded (collapsed by default) */
  expandedSessionsEnvironments: string[];
  /**
   * Leaf-mode coordinator gates the user chose to open anyway, keyed by
   * `leafCoordinatorGateKey`. Kept for the app session only: not persisted, so
   * the notice returns after a restart.
   */
  openedLeafCoordinators: string[];

  // Actions
  selectProject: (projectId: string | null) => void;
  selectEnvironment: (environmentId: string | null) => void;
  setProjectBoardTab: (tab: ProjectBoardTab) => void;
  /** Select both project and environment at once (for hierarchical sidebar) */
  selectProjectAndEnvironment: (projectId: string, environmentId: string) => void;
  /** Toggle the collapsed state of a project */
  toggleProjectCollapse: (projectId: string) => void;
  /** Set the collapsed state of a project */
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
  /** Toggle the collapsed state of a sidebar project folder */
  toggleProjectFolderCollapse: (folder: string) => void;
  /** Set the collapsed state of a sidebar project folder */
  setProjectFolderCollapsed: (folder: string, collapsed: boolean) => void;
  /** Toggle an environment in multi-select mode */
  toggleEnvironmentSelection: (environmentId: string) => void;
  /** Set multiple environment IDs as selected (for range selection) */
  setMultiSelection: (environmentIds: string[]) => void;
  /** Clear all multi-selected environments */
  clearMultiSelection: () => void;
  /** Toggle the expanded state of sessions for an environment */
  toggleSessionsExpanded: (environmentId: string) => void;
  /** Check if sessions are expanded for an environment */
  isSessionsExpanded: (environmentId: string) => boolean;
  /** Collapse projects that have no environments (used on initial load) */
  collapseEmptyProjects: (projectIds: string[], projectsWithEnvironments: Set<string>) => void;
  /** Remember, for this app session, that the user opened a gated coordinator. */
  openLeafCoordinator: (key: string) => void;
}

type PersistedUIState = Pick<UIState, (typeof UI_NODE_PERSISTED_FIELDS)[number]>;

/**
 * Keeps a scope's `uiStore` and its window's selection in step: the window's
 * selection is projected onto the store, and a selection made in the store
 * moves the window's to this node. Returns the initial projection.
 *
 * A selection made here moves the window to this node when it is explicit
 * navigation (the project was selected again, or an environment was chosen),
 * or while this node is already shown, as the window's own workspace came
 * back from another node's before (plan item 3006 keeps that rule).
 */
function bindWindowSelection(
  scope: NodeScope,
  set: Parameters<StateCreator<UIState>>[0],
  get: () => UIState,
  api: Parameters<StateCreator<UIState>>[2],
): Pick<UIState, "selectedProjectId" | "selectedEnvironmentId"> {
  const windowScope = windowScopeOf(scope);
  if (!windowScope) return { selectedProjectId: null, selectedEnvironmentId: null };
  const shownHere = (selection: NodeSelection | null): selection is NodeSelection =>
    selectionOnScope(scope, selection) !== null;
  let projecting = false;

  const project = (selection: NodeSelection | null) => {
    const state = get();
    if (!state) return;
    const here = shownHere(selection);
    const projectId = here ? selection.projectId : null;
    const environmentId = here ? selection.environmentId : null;
    if (state.selectedProjectId === projectId && state.selectedEnvironmentId === environmentId) {
      return;
    }
    projecting = true;
    try {
      if (here) {
        set({ selectedProjectId: projectId, selectedEnvironmentId: environmentId });
      } else {
        // The window moved to another node: this node's workspace shows
        // nothing behind it, as `selectProject(null)` left it before.
        set((current) => ({
          selectedProjectId: null,
          selectedEnvironmentId: null,
          selectedEnvironmentIds: [],
          projectSelectionRevision: current.projectSelectionRevision + 1,
          projectBoardTab: projectLandingBoardTab(scope),
        }));
      }
    } finally {
      projecting = false;
    }
  };

  const stopProjecting = windowScope.selection.subscribe(project);
  const stopPublishing = api.subscribe((state, previous) => {
    if (projecting || !previous) return;
    const reselected = state.projectSelectionRevision !== previous.projectSelectionRevision;
    const environmentChosen =
      state.selectedEnvironmentId !== null &&
      state.selectedEnvironmentId !== previous.selectedEnvironmentId;
    if (
      !reselected &&
      state.selectedProjectId === previous.selectedProjectId &&
      state.selectedEnvironmentId === previous.selectedEnvironmentId
    ) {
      return;
    }
    const current = windowScope.selection.get();
    const explicit =
      reselected ||
      environmentChosen ||
      (current === null &&
        (state.selectedProjectId !== null || state.selectedEnvironmentId !== null));
    if (!shownHere(current) && !explicit) return;
    windowScope.select({
      nodeId: scope.nodeId,
      projectId: state.selectedProjectId,
      environmentId: state.selectedEnvironmentId,
    });
  });
  scope.onDispose("ui-window-selection", () => {
    stopProjecting();
    stopPublishing();
  });

  const selection = windowScope.selection.get();
  return shownHere(selection)
    ? { selectedProjectId: selection.projectId, selectedEnvironmentId: selection.environmentId }
    : { selectedProjectId: null, selectedEnvironmentId: null };
}

/**
 * Applies a node's stored UI state to `current`. Only the node fields are
 * read; the window's chrome is `uiChromeStore`'s.
 */
export function mergePersistedUIState(persisted: unknown, current: UIState): UIState {
  const stored = (typeof persisted === "object" && persisted !== null ? persisted : {}) as Record<
    string,
    unknown
  >;
  const restored: Partial<PersistedUIState> = {};
  for (const field of UI_NODE_PERSISTED_FIELDS) {
    if (Array.isArray(stored[field])) restored[field] = stored[field] as string[];
  }
  return { ...current, ...restored };
}

export const uiStore = defineScopedStore<UIState>("ui", (scope) => {
  const creator: StateCreator<UIState, [], [["zustand/persist", PersistedUIState]]> = persist(
    (set, get, api) => ({
      ...bindWindowSelection(scope, set, get, api),
      projectSelectionRevision: 0,
      recentProjectIds: [],
      projectBoardTab: projectLandingBoardTab(scope),
      collapsedProjects: [],
      projectCollapseChoices: [],
      collapsedProjectFolders: [],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      openedLeafCoordinators: [],

      // Actions
      selectProject: (projectId) =>
        set((state) => ({
          selectedProjectId: projectId,
          projectSelectionRevision: state.projectSelectionRevision + 1,
          projectBoardTab: projectLandingBoardTab(scope),
          selectedEnvironmentId: null,
          selectedEnvironmentIds: [],
          recentProjectIds: projectId
            ? addRecentProject(state.recentProjectIds, projectId)
            : state.recentProjectIds,
        })),

      selectEnvironment: (environmentId) => set({ selectedEnvironmentId: environmentId }),

      setProjectBoardTab: (tab) => set({ projectBoardTab: tab }),

      selectProjectAndEnvironment: (projectId, environmentId) =>
        set((state) => ({
          selectedProjectId: projectId,
          projectSelectionRevision: state.projectSelectionRevision + 1,
          selectedEnvironmentId: environmentId,
          recentProjectIds: addRecentProject(state.recentProjectIds, projectId),
        })),

      toggleProjectCollapse: (projectId) =>
        set((state) => ({
          projectCollapseChoices: Array.from(new Set([...state.projectCollapseChoices, projectId])),
          collapsedProjects: state.collapsedProjects.includes(projectId)
            ? state.collapsedProjects.filter((id) => id !== projectId)
            : [...state.collapsedProjects, projectId],
        })),

      setProjectCollapsed: (projectId, collapsed) =>
        set((state) => ({
          projectCollapseChoices: Array.from(new Set([...state.projectCollapseChoices, projectId])),
          collapsedProjects: collapsed
            ? state.collapsedProjects.includes(projectId)
              ? state.collapsedProjects
              : [...state.collapsedProjects, projectId]
            : state.collapsedProjects.filter((id) => id !== projectId),
        })),

      // Folder identity is the case-folded name, matching how the sidebar tree
      // groups projects. Comparing these entries literally would leave a
      // folder stuck collapsed after it was reached by a differently-cased
      // spelling of its own name.
      toggleProjectFolderCollapse: (folder) =>
        set((state) => ({
          collapsedProjectFolders: isFolderCollapsed(state.collapsedProjectFolders, folder)
            ? withoutFolder(state.collapsedProjectFolders, folder)
            : [...state.collapsedProjectFolders, folder],
        })),

      setProjectFolderCollapsed: (folder, collapsed) =>
        set((state) => ({
          collapsedProjectFolders: collapsed
            ? isFolderCollapsed(state.collapsedProjectFolders, folder)
              ? state.collapsedProjectFolders
              : [...state.collapsedProjectFolders, folder]
            : withoutFolder(state.collapsedProjectFolders, folder),
        })),

      toggleEnvironmentSelection: (environmentId) =>
        set((state) => ({
          selectedEnvironmentIds: state.selectedEnvironmentIds.includes(environmentId)
            ? state.selectedEnvironmentIds.filter((id) => id !== environmentId)
            : [...state.selectedEnvironmentIds, environmentId],
        })),

      setMultiSelection: (environmentIds) => set({ selectedEnvironmentIds: environmentIds }),

      clearMultiSelection: () => set({ selectedEnvironmentIds: [] }),

      toggleSessionsExpanded: (environmentId) =>
        set((state) => ({
          expandedSessionsEnvironments: state.expandedSessionsEnvironments.includes(environmentId)
            ? state.expandedSessionsEnvironments.filter((id) => id !== environmentId)
            : [...state.expandedSessionsEnvironments, environmentId],
        })),

      isSessionsExpanded: (environmentId) =>
        get().expandedSessionsEnvironments.includes(environmentId),

      collapseEmptyProjects: (projectIds, projectsWithEnvironments) =>
        set((state) => {
          const empty = projectIds.filter(
            (id) =>
              !state.projectCollapseChoices.includes(id) &&
              !state.collapsedProjects.includes(id) &&
              !projectsWithEnvironments.has(id),
          );
          if (empty.length === 0) return state;
          return { collapsedProjects: [...state.collapsedProjects, ...empty] };
        }),

      openLeafCoordinator: (key) =>
        set((state) =>
          state.openedLeafCoordinators.includes(key)
            ? state
            : { openedLeafCoordinators: [...state.openedLeafCoordinators, key] },
        ),
    }),
    {
      name: nodeStorageKey("ui-project-storage", scope),
      storage: createJSONStorage(() => createUIStateStorage(scope)),
      merge: mergePersistedUIState,
      partialize: (state) => ({
        collapsedProjects: state.collapsedProjects,
        projectCollapseChoices: state.projectCollapseChoices,
        collapsedProjectFolders: state.collapsedProjectFolders,
        recentProjectIds: state.recentProjectIds,
      }),
    },
  );
  // `persist` adds its `persist` API to the store; nothing here reads it.
  return creator as StateCreator<UIState>;
});

/** Reads the nearest node scope's UI state; other code uses `scope.store(uiStore)`. */
export const useUIStore = scopedStoreHook(uiStore);

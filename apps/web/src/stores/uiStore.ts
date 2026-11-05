import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { projectFolderKey } from "@orkestrator/protocol/project-folders";
import type { ActivitySortOrder } from "@orkestrator/protocol/environment-activity-order";
import type { CoordinatorWorkBucket } from "@/lib/coordinator-work-items";
import { windowStorageKey } from "@/lib/desktop-storage-key";
import { workspaceTarget } from "@/lib/portal/portal-transport";
import { portalStore } from "@/lib/portal/portal-store";
import { createUIStateStorage } from "@/lib/ui-state-storage";

/** Zoom level constraints */
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
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
  "home" | "coordinator" | "kanban" | "github" | "linear" | "features" | "notes" | "pull-requests";
export type EnvironmentSortMode = "project" | "activity";
/**
 * How "By activity" orders environments. Every order keeps merged environments
 * below unmerged ones and working environments below the others. Within those
 * groups `priority` puts unread work, then waiting, before idle, newest first
 * within each; `newest` and `oldest` order by activity time alone. Defined with
 * the shared comparator.
 */
export type { ActivitySortOrder } from "@orkestrator/protocol/environment-activity-order";

/**
 * A project opens on its coordinator, except on a leaf node: coordination
 * happens on the command node, so a leaf's project opens on its home.
 */
const initialProjectBoardTab = (): ProjectBoardTab =>
  workspaceTarget() !== null || portalStore.getState().status?.mode === "leaf"
    ? "home"
    : "coordinator";

interface UIState {
  // Sidebar state
  selectedProjectId: string | null;
  /** Explicit project navigation, including reselecting the same row. */
  projectSelectionRevision: number;
  selectedEnvironmentId: string | null;
  /** Whether the left projects/environments panel is visible. */
  sidebarOpen: boolean;
  /** Coordinator Work panel sections folded shut, on this device, across projects. */
  collapsedWorkBuckets: CoordinatorWorkBucket[];
  /** Most recently opened project IDs, newest first. */
  recentProjectIds: string[];
  projectBoardTab: ProjectBoardTab;
  sidebarWidth: number;
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
  /** How environments are arranged in the sidebar. */
  environmentSortMode: EnvironmentSortMode;
  /** Order of the "By activity" list. */
  activitySortOrder: ActivitySortOrder;
  /** Zoom level as a percentage (50-200, default 100) */
  zoomLevel: number;
  /** Multi Review graph height set by dragging its divider; null sizes it to the graph. */
  multiReviewGraphHeight: number | null;
  /** Build pipeline graph height set by dragging its divider; null sizes it to the graph. */
  pipelineGraphHeight: number | null;
  /**
   * This client's data-saving preference: slower background reads of what it
   * shows (`setReadCoordinatorDataSaving`). Client-local by design — it never
   * changes another client's freshness or the backend's own cadence.
   */
  dataSaving: boolean;
  /**
   * Leaf-mode coordinator gates the user chose to open anyway, keyed by
   * `leafCoordinatorGateKey`. Kept for the app session only: not persisted, so
   * the notice returns after a restart.
   */
  openedLeafCoordinators: string[];

  // Actions
  selectProject: (projectId: string | null) => void;
  selectEnvironment: (environmentId: string | null) => void;
  /** Toggle the left projects/environments panel. */
  toggleSidebar: () => void;
  setProjectBoardTab: (tab: ProjectBoardTab) => void;
  /** Select both project and environment at once (for hierarchical sidebar) */
  selectProjectAndEnvironment: (projectId: string, environmentId: string) => void;
  setSidebarWidth: (width: number) => void;
  setMultiReviewGraphHeight: (height: number | null) => void;
  setPipelineGraphHeight: (height: number | null) => void;
  /** Fold or unfold one section of the coordinator Work panel */
  toggleWorkBucketCollapsed: (bucket: CoordinatorWorkBucket) => void;
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
  setEnvironmentSortMode: (mode: EnvironmentSortMode) => void;
  setActivitySortOrder: (order: ActivitySortOrder) => void;
  /** Check if sessions are expanded for an environment */
  isSessionsExpanded: (environmentId: string) => boolean;
  /** Collapse projects that have no environments (used on initial load) */
  collapseEmptyProjects: (projectIds: string[], projectsWithEnvironments: Set<string>) => void;
  /** Set zoom level (clamped to 50-200) */
  setZoomLevel: (level: number) => void;
  /** Zoom in by 10% */
  zoomIn: () => void;
  /** Zoom out by 10% */
  zoomOut: () => void;
  /** Reset zoom to 100% */
  resetZoom: () => void;
  setDataSaving: (enabled: boolean) => void;
  /** Remember, for this app session, that the user opened a gated coordinator. */
  openLeafCoordinator: (key: string) => void;
}

export const createUIStore = () =>
  create<UIState>()(
    persist(
      (set, get) => ({
        // Initial state
        selectedProjectId: null,
        projectSelectionRevision: 0,
        selectedEnvironmentId: null,
        sidebarOpen: true,
        collapsedWorkBuckets: [],
        recentProjectIds: [],
        projectBoardTab: initialProjectBoardTab(),
        sidebarWidth: 280,
        collapsedProjects: [],
        projectCollapseChoices: [],
        collapsedProjectFolders: [],
        selectedEnvironmentIds: [],
        expandedSessionsEnvironments: [],
        environmentSortMode: "project",
        activitySortOrder: "priority",
        zoomLevel: ZOOM_DEFAULT,
        multiReviewGraphHeight: null,
        pipelineGraphHeight: null,
        dataSaving: false,
        openedLeafCoordinators: [],

        // Actions
        toggleWorkBucketCollapsed: (bucket) =>
          set((state) => ({
            collapsedWorkBuckets: state.collapsedWorkBuckets.includes(bucket)
              ? state.collapsedWorkBuckets.filter((item) => item !== bucket)
              : [...state.collapsedWorkBuckets, bucket],
          })),

        selectProject: (projectId) =>
          set((state) => ({
            selectedProjectId: projectId,
            projectSelectionRevision: state.projectSelectionRevision + 1,
            projectBoardTab: initialProjectBoardTab(),
            selectedEnvironmentId: null,
            selectedEnvironmentIds: [],
            recentProjectIds: projectId
              ? addRecentProject(state.recentProjectIds, projectId)
              : state.recentProjectIds,
          })),

        selectEnvironment: (environmentId) => set({ selectedEnvironmentId: environmentId }),

        toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),

        setProjectBoardTab: (tab) => set({ projectBoardTab: tab }),

        selectProjectAndEnvironment: (projectId, environmentId) =>
          set((state) => ({
            selectedProjectId: projectId,
            projectSelectionRevision: state.projectSelectionRevision + 1,
            selectedEnvironmentId: environmentId,
            recentProjectIds: addRecentProject(state.recentProjectIds, projectId),
          })),

        setSidebarWidth: (width) => set({ sidebarWidth: width }),

        setMultiReviewGraphHeight: (height) => set({ multiReviewGraphHeight: height }),
        setPipelineGraphHeight: (height) => set({ pipelineGraphHeight: height }),

        toggleProjectCollapse: (projectId) =>
          set((state) => ({
            projectCollapseChoices: Array.from(
              new Set([...state.projectCollapseChoices, projectId]),
            ),
            collapsedProjects: state.collapsedProjects.includes(projectId)
              ? state.collapsedProjects.filter((id) => id !== projectId)
              : [...state.collapsedProjects, projectId],
          })),

        setProjectCollapsed: (projectId, collapsed) =>
          set((state) => ({
            projectCollapseChoices: Array.from(
              new Set([...state.projectCollapseChoices, projectId]),
            ),
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

        setEnvironmentSortMode: (mode) => set({ environmentSortMode: mode }),

        setActivitySortOrder: (order) => set({ activitySortOrder: order }),

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

        setZoomLevel: (level) => set({ zoomLevel: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) }),

        zoomIn: () =>
          set((state) => ({
            zoomLevel: Math.min(ZOOM_MAX, state.zoomLevel + ZOOM_STEP),
          })),

        zoomOut: () =>
          set((state) => ({
            zoomLevel: Math.max(ZOOM_MIN, state.zoomLevel - ZOOM_STEP),
          })),

        resetZoom: () => set({ zoomLevel: ZOOM_DEFAULT }),

        setDataSaving: (enabled) => set({ dataSaving: enabled }),

        openLeafCoordinator: (key) =>
          set((state) =>
            state.openedLeafCoordinators.includes(key)
              ? state
              : { openedLeafCoordinators: [...state.openedLeafCoordinators, key] },
          ),
      }),
      {
        name: windowStorageKey("ui-storage"),
        storage: createJSONStorage(() => createUIStateStorage()),
        partialize: (state) => ({
          sidebarWidth: state.sidebarWidth,
          sidebarOpen: state.sidebarOpen,
          collapsedWorkBuckets: state.collapsedWorkBuckets,
          collapsedProjects: state.collapsedProjects,
          projectCollapseChoices: state.projectCollapseChoices,
          collapsedProjectFolders: state.collapsedProjectFolders,
          recentProjectIds: state.recentProjectIds,
          environmentSortMode: state.environmentSortMode,
          activitySortOrder: state.activitySortOrder,
          zoomLevel: state.zoomLevel,
          multiReviewGraphHeight: state.multiReviewGraphHeight,
          pipelineGraphHeight: state.pipelineGraphHeight,
          dataSaving: state.dataSaving,
        }),
      },
    ),
  );

export const useUIStore = createUIStore();

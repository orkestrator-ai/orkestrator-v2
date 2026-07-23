import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Zoom level constraints */
const ZOOM_MIN = 50;
const ZOOM_MAX = 200;
const ZOOM_STEP = 10;
const ZOOM_DEFAULT = 100;
const RECENT_PROJECT_LIMIT = 5;

const addRecentProject = (recentProjectIds: string[], projectId: string): string[] =>
  [projectId, ...recentProjectIds.filter((id) => id !== projectId)].slice(
    0,
    RECENT_PROJECT_LIMIT,
  );

export type ProjectBoardTab = "kanban" | "linear" | "features";
export type EnvironmentSortMode = "project" | "activity";

interface UIState {
  // Sidebar state
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  /** Most recently opened project IDs, newest first. */
  recentProjectIds: string[];
  projectBoardTab: ProjectBoardTab;
  projectBoardNotesOpen: boolean;
  sidebarWidth: number;
  /** Project IDs that are collapsed in the hierarchical sidebar */
  collapsedProjects: string[];
  /** Environment IDs selected in multi-select mode */
  selectedEnvironmentIds: string[];
  /** Environment IDs that have their sessions section expanded (collapsed by default) */
  expandedSessionsEnvironments: string[];
  /** How environments are arranged in the sidebar. */
  environmentSortMode: EnvironmentSortMode;
  /** Zoom level as a percentage (50-200, default 100) */
  zoomLevel: number;

  // Actions
  selectProject: (projectId: string | null) => void;
  selectEnvironment: (environmentId: string | null) => void;
  setProjectBoardTab: (tab: ProjectBoardTab) => void;
  setProjectBoardNotesOpen: (open: boolean) => void;
  /** Select both project and environment at once (for hierarchical sidebar) */
  selectProjectAndEnvironment: (projectId: string, environmentId: string) => void;
  setSidebarWidth: (width: number) => void;
  /** Toggle the collapsed state of a project */
  toggleProjectCollapse: (projectId: string) => void;
  /** Set the collapsed state of a project */
  setProjectCollapsed: (projectId: string, collapsed: boolean) => void;
  /** Toggle an environment in multi-select mode */
  toggleEnvironmentSelection: (environmentId: string) => void;
  /** Set multiple environment IDs as selected (for range selection) */
  setMultiSelection: (environmentIds: string[]) => void;
  /** Clear all multi-selected environments */
  clearMultiSelection: () => void;
  /** Toggle the expanded state of sessions for an environment */
  toggleSessionsExpanded: (environmentId: string) => void;
  setEnvironmentSortMode: (mode: EnvironmentSortMode) => void;
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
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      // Initial state
      selectedProjectId: null,
      selectedEnvironmentId: null,
      recentProjectIds: [],
      projectBoardTab: "kanban",
      projectBoardNotesOpen: false,
      sidebarWidth: 280,
      collapsedProjects: [],
      selectedEnvironmentIds: [],
      expandedSessionsEnvironments: [],
      environmentSortMode: "project",
      zoomLevel: ZOOM_DEFAULT,

      // Actions
      selectProject: (projectId) =>
        set((state) => ({
          selectedProjectId: projectId,
          selectedEnvironmentId: null,
          selectedEnvironmentIds: [],
          recentProjectIds: projectId
            ? addRecentProject(state.recentProjectIds, projectId)
            : state.recentProjectIds,
        })),

      selectEnvironment: (environmentId) =>
        set({ selectedEnvironmentId: environmentId }),

      setProjectBoardTab: (tab) =>
        set({ projectBoardTab: tab, projectBoardNotesOpen: false }),

      setProjectBoardNotesOpen: (open) =>
        set({ projectBoardNotesOpen: open }),

      selectProjectAndEnvironment: (projectId, environmentId) =>
        set((state) => ({
          selectedProjectId: projectId,
          selectedEnvironmentId: environmentId,
          recentProjectIds: addRecentProject(state.recentProjectIds, projectId),
        })),

      setSidebarWidth: (width) => set({ sidebarWidth: width }),

      toggleProjectCollapse: (projectId) =>
        set((state) => ({
          collapsedProjects: state.collapsedProjects.includes(projectId)
            ? state.collapsedProjects.filter((id) => id !== projectId)
            : [...state.collapsedProjects, projectId],
        })),

      setProjectCollapsed: (projectId, collapsed) =>
        set((state) => ({
          collapsedProjects: collapsed
            ? state.collapsedProjects.includes(projectId)
              ? state.collapsedProjects
              : [...state.collapsedProjects, projectId]
            : state.collapsedProjects.filter((id) => id !== projectId),
        })),

      toggleEnvironmentSelection: (environmentId) =>
        set((state) => ({
          selectedEnvironmentIds: state.selectedEnvironmentIds.includes(environmentId)
            ? state.selectedEnvironmentIds.filter((id) => id !== environmentId)
            : [...state.selectedEnvironmentIds, environmentId],
        })),

      setMultiSelection: (environmentIds) =>
        set({ selectedEnvironmentIds: environmentIds }),

      clearMultiSelection: () =>
        set({ selectedEnvironmentIds: [] }),

      toggleSessionsExpanded: (environmentId) =>
        set((state) => ({
          expandedSessionsEnvironments: state.expandedSessionsEnvironments.includes(environmentId)
            ? state.expandedSessionsEnvironments.filter((id) => id !== environmentId)
            : [...state.expandedSessionsEnvironments, environmentId],
        })),

      setEnvironmentSortMode: (mode) =>
        set({ environmentSortMode: mode }),

      isSessionsExpanded: (environmentId) =>
        get().expandedSessionsEnvironments.includes(environmentId),

      collapseEmptyProjects: (projectIds, projectsWithEnvironments) =>
        set((state) => {
          // Find projects that have no environments and aren't already collapsed
          const emptyProjects = projectIds.filter(
            (id) => !projectsWithEnvironments.has(id) && !state.collapsedProjects.includes(id)
          );
          if (emptyProjects.length === 0) {
            return state; // No change needed
          }
          return {
            collapsedProjects: [...state.collapsedProjects, ...emptyProjects],
          };
        }),

      setZoomLevel: (level) =>
        set({ zoomLevel: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level)) }),

      zoomIn: () =>
        set((state) => ({
          zoomLevel: Math.min(ZOOM_MAX, state.zoomLevel + ZOOM_STEP),
        })),

      zoomOut: () =>
        set((state) => ({
          zoomLevel: Math.max(ZOOM_MIN, state.zoomLevel - ZOOM_STEP),
        })),

      resetZoom: () =>
        set({ zoomLevel: ZOOM_DEFAULT }),
    }),
    {
      name: "ui-storage",
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        collapsedProjects: state.collapsedProjects,
        recentProjectIds: state.recentProjectIds,
        environmentSortMode: state.environmentSortMode,
        zoomLevel: state.zoomLevel,
      }),
    }
  )
);

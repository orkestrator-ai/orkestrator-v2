import { defineScopedStore } from "@/lib/node-scope/scoped-store";
import { scopedStoreHook } from "@/lib/node-scope/scoped-store";
import type { Project } from "@/types";

/** Sort projects by their order field */
const sortByOrder = (projects: Project[]): Project[] =>
  [...projects].sort((a, b) => a.order - b.order);

export interface ProjectState {
  // State
  projects: Project[];
  deletingProjects: Set<string>;
  setDeleting: (projectId: string, deleting: boolean) => void;
  isLoading: boolean;
  hasLoaded: boolean;
  error: string | null;

  // Actions
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
  /** Apply an authoritative record, including deleted optional keys. */
  replaceProject: (project: Project) => void;
  /** Reorder projects based on the new order of IDs */
  reorderProjects: (projectIds: string[]) => void;
  /** Apply a new order together with the folder memberships that changed. */
  arrangeProjects: (projectIds: string[], folders: Record<string, string | null>) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  // Selectors
  getProjectById: (projectId: string) => Project | undefined;

  // Snapshot ordering. The version is coordination metadata for rejecting
  // backend snapshots started before a mutation; it is this scope's own, so a
  // mutation on one node never makes another node's read stale.
  /** @internal Capture this before starting an asynchronous project snapshot read. */
  getMutationVersion: () => number;
  /** @internal Invalidate snapshots as soon as a backend mutation is requested. */
  invalidateSnapshots: () => void;
  /**
   * @internal Apply a backend snapshot only when no project mutation has
   * happened since the read began. Returns whether the snapshot was accepted.
   */
  applySnapshot: (projects: Project[], expectedMutationVersion: number) => boolean;
}

/** The projects of one node, held per node scope (plan item 3004). */
export const projectStore = defineScopedStore<ProjectState>("project", () => (set, get) => {
  // Not state: nothing renders it, and a selector must never re-render for it.
  let mutationVersion = 0;
  const advanceProjectMutationVersion = (): void => {
    mutationVersion += 1;
  };
  return {
    // Initial state
    projects: [],
    deletingProjects: new Set(),
    setDeleting: (projectId, deleting) =>
      set((state) => {
        const deletingProjects = new Set(state.deletingProjects);
        if (deleting) deletingProjects.add(projectId);
        else deletingProjects.delete(projectId);
        return { deletingProjects };
      }),
    isLoading: false,
    hasLoaded: false,
    error: null,

    // Actions
    setProjects: (projects) => {
      advanceProjectMutationVersion();
      set({ projects: sortByOrder(projects), hasLoaded: true });
    },

    addProject: (project) => {
      advanceProjectMutationVersion();
      set((state) => ({
        projects: sortByOrder([...state.projects, project]),
      }));
    },

    removeProject: (projectId) => {
      advanceProjectMutationVersion();
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
      }));
    },

    updateProject: (projectId, updates) => {
      advanceProjectMutationVersion();
      set((state) => ({
        projects: sortByOrder(
          state.projects.map((p) => (p.id === projectId ? { ...p, ...updates } : p)),
        ),
      }));
    },

    replaceProject: (project) => {
      advanceProjectMutationVersion();
      set((state) => ({
        projects: sortByOrder(state.projects.map((p) => (p.id === project.id ? project : p))),
      }));
    },

    reorderProjects: (projectIds) => {
      get().arrangeProjects(projectIds, {});
    },

    arrangeProjects: (projectIds, folders) => {
      advanceProjectMutationVersion();
      set((state) => ({
        projects: projectIds
          .map((id, index): Project | null => {
            const project = state.projects.find((p) => p.id === id);
            if (!project) return null;
            // Mirrors the backend: an unmentioned project keeps its membership,
            // and clearing one removes the key rather than storing an explicit
            // null, so the optimistic record matches the snapshot that follows.
            if (!(id in folders)) return { ...project, order: index };
            const folder = folders[id] ?? null;
            const next = { ...project, order: index };
            if (folder) next.folder = folder;
            else delete next.folder;
            return next;
          })
          .filter((p): p is Project => p !== null),
      }));
    },

    setLoading: (isLoading) => set({ isLoading }),

    setError: (error) => set({ error }),

    // Selectors
    getProjectById: (projectId) => get().projects.find((p) => p.id === projectId),

    getMutationVersion: () => mutationVersion,
    invalidateSnapshots: advanceProjectMutationVersion,
    applySnapshot: (projects, expectedMutationVersion) => {
      if (expectedMutationVersion !== mutationVersion) return false;
      set({ projects: sortByOrder(projects), hasLoaded: true });
      return true;
    },
  };
});

/** Reads the nearest node scope's projects; other code uses `scope.store(projectStore)`. */
export const useProjectStore = scopedStoreHook(projectStore);

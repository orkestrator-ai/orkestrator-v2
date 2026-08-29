import { create } from "zustand";
import type { Project } from "@/types";

/** Sort projects by their order field */
const sortByOrder = (projects: Project[]): Project[] =>
  [...projects].sort((a, b) => a.order - b.order);

// Kept outside the persisted store shape: this is process-local coordination
// metadata for rejecting backend snapshots that were started before a mutation.
let projectMutationVersion = 0;

const advanceProjectMutationVersion = (): void => {
  projectMutationVersion += 1;
};

interface ProjectState {
  // State
  projects: Project[];
  isLoading: boolean;
  error: string | null;

  // Actions
  setProjects: (projects: Project[]) => void;
  addProject: (project: Project) => void;
  removeProject: (projectId: string) => void;
  updateProject: (projectId: string, updates: Partial<Project>) => void;
  /** Reorder projects based on the new order of IDs */
  reorderProjects: (projectIds: string[]) => void;
  /** Apply a new order together with the folder memberships that changed. */
  arrangeProjects: (projectIds: string[], folders: Record<string, string | null>) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;

  // Selectors
  getProjectById: (projectId: string) => Project | undefined;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  // Initial state
  projects: [],
  isLoading: false,
  error: null,

  // Actions
  setProjects: (projects) => {
    advanceProjectMutationVersion();
    set({ projects: sortByOrder(projects) });
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
}));

/** @internal Capture this before starting an asynchronous project snapshot read. */
export const getProjectMutationVersion = (): number => projectMutationVersion;

/** @internal Invalidate snapshots as soon as a backend mutation is requested. */
export const invalidateProjectSnapshots = (): void => {
  advanceProjectMutationVersion();
};

/**
 * @internal Apply a backend snapshot only when no project mutation has happened
 * since the read began. Returns whether the snapshot was accepted.
 */
export const applyProjectSnapshot = (
  projects: Project[],
  expectedMutationVersion: number,
): boolean => {
  if (expectedMutationVersion !== projectMutationVersion) {
    return false;
  }

  useProjectStore.setState({ projects: sortByOrder(projects) });
  return true;
};

import { create } from "zustand";
import type { Project } from "@/types";

/** Sort projects by their order field */
const sortByOrder = (projects: Project[]): Project[] =>
  [...projects].sort((a, b) => a.order - b.order);

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
  setProjects: (projects) => set({ projects: sortByOrder(projects) }),

  addProject: (project) =>
    set((state) => ({
      projects: sortByOrder([...state.projects, project]),
    })),

  removeProject: (projectId) =>
    set((state) => ({
      projects: state.projects.filter((p) => p.id !== projectId),
    })),

  updateProject: (projectId, updates) =>
    set((state) => ({
      projects: sortByOrder(
        state.projects.map((p) =>
          p.id === projectId ? { ...p, ...updates } : p
        )
      ),
    })),

  reorderProjects: (projectIds) =>
    set((state) => ({
      projects: projectIds
        .map((id, index) => {
          const project = state.projects.find((p) => p.id === id);
          return project ? { ...project, order: index } : null;
        })
        .filter((p): p is Project => p !== null),
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  // Selectors
  getProjectById: (projectId) => get().projects.find((p) => p.id === projectId),
}));

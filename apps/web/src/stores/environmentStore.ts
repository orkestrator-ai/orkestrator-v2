import { create } from "zustand";
import { deepEqualJson } from "@/lib/chat/message-identity";
import type { Environment, EnvironmentStatus, PrState } from "@/types";

const sortByOrder = (environments: Environment[]): Environment[] =>
  [...environments].sort((a, b) => a.order - b.order);

interface EnvironmentState {
  environments: Environment[];
  isLoading: boolean;
  error: string | null;
  deletingEnvironments: Set<string>;

  setEnvironments: (environments: Environment[]) => void;
  mergeEnvironmentsForProject: (projectId: string, environments: Environment[]) => void;
  addEnvironment: (environment: Environment) => void;
  removeEnvironment: (environmentId: string) => void;
  updateEnvironment: (environmentId: string, updates: Partial<Environment>) => void;
  updateEnvironmentStatus: (environmentId: string, status: EnvironmentStatus) => void;
  setEnvironmentPR: (
    environmentId: string,
    prUrl: string | null,
    prState: PrState | null,
    hasMergeConflicts?: boolean | null,
  ) => void;
  reorderEnvironments: (projectId: string, environmentIds: string[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  setDeleting: (environmentId: string, isDeleting: boolean) => void;

  getEnvironmentById: (environmentId: string) => Environment | undefined;
  getEnvironmentsByProjectId: (projectId: string) => Environment[];
  isDeleting: (environmentId: string) => boolean;
}

export const useEnvironmentStore = create<EnvironmentState>()((set, get) => ({
  environments: [],
  isLoading: false,
  error: null,
  deletingEnvironments: new Set<string>(),

  setEnvironments: (environments) => set({ environments: sortByOrder(environments) }),

  mergeEnvironmentsForProject: (projectId, newEnvironments) =>
    set((state) => {
      const current = state.environments.filter((environment) => environment.projectId === projectId);
      const sorted = sortByOrder(newEnvironments);
      if (
        current.length === sorted.length
        && sorted.every((environment, index) => deepEqualJson(environment, current[index]))
      ) {
        return state;
      }
      return {
        environments: sortByOrder([
          ...state.environments.filter((environment) => environment.projectId !== projectId),
          ...sorted,
        ]),
      };
    }),

  addEnvironment: (environment) =>
    set((state) => ({ environments: sortByOrder([...state.environments, environment]) })),

  removeEnvironment: (environmentId) =>
    set((state) => {
      const deletingEnvironments = new Set(state.deletingEnvironments);
      deletingEnvironments.delete(environmentId);
      return {
        environments: state.environments.filter((environment) => environment.id !== environmentId),
        deletingEnvironments,
      };
    }),

  updateEnvironment: (environmentId, updates) =>
    set((state) => {
      const previous = state.environments.find((environment) => environment.id === environmentId);
      if (!previous) return state;
      const changed = (Object.keys(updates) as Array<keyof Environment>).some(
        (key) => !deepEqualJson(previous[key], updates[key]),
      );
      if (!changed) return state;
      const environments = state.environments.map((environment) =>
        environment.id === environmentId ? { ...environment, ...updates } : environment
      );
      return {
        environments:
          updates.order !== undefined && updates.order !== previous.order
            ? sortByOrder(environments)
            : environments,
      };
    }),

  updateEnvironmentStatus: (environmentId, status) =>
    set((state) => ({
      environments: state.environments.map((environment) =>
        environment.id === environmentId ? { ...environment, status } : environment
      ),
    })),

  setEnvironmentPR: (environmentId, prUrl, prState, hasMergeConflicts) =>
    set((state) => ({
      environments: state.environments.map((environment) =>
        environment.id === environmentId
          ? { ...environment, prUrl, prState, hasMergeConflicts: hasMergeConflicts ?? null }
          : environment
      ),
    })),

  reorderEnvironments: (projectId, environmentIds) =>
    set((state) => ({
      environments: [
        ...state.environments.filter((environment) => environment.projectId !== projectId),
        ...environmentIds.flatMap((id, order) => {
          const environment = state.environments.find(
            (candidate) => candidate.id === id && candidate.projectId === projectId,
          );
          return environment ? [{ ...environment, order }] : [];
        }),
      ],
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  setDeleting: (environmentId, isDeleting) =>
    set((state) => {
      const deletingEnvironments = new Set(state.deletingEnvironments);
      if (isDeleting) deletingEnvironments.add(environmentId);
      else deletingEnvironments.delete(environmentId);
      return { deletingEnvironments };
    }),

  getEnvironmentById: (environmentId) =>
    get().environments.find((environment) => environment.id === environmentId),
  getEnvironmentsByProjectId: (projectId) =>
    sortByOrder(get().environments.filter((environment) => environment.projectId === projectId)),
  isDeleting: (environmentId) =>
    get().deletingEnvironments.has(environmentId)
    || get().environments.some(
      (environment) => environment.id === environmentId
        && (environment.lifecycleOperation === "deleting" || Boolean(environment.deletionRequestedAt)),
    ),
}));

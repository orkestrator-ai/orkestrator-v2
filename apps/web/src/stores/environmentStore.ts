import { create } from "zustand";
import { deepEqualJson } from "@/lib/chat/message-identity";
import { clearRichEnvironmentContent } from "@/lib/chat/rich-content-reset";
import type { Environment, EnvironmentStatus, PrState } from "@/types";

const sortByOrder = (environments: Environment[]): Environment[] =>
  [...environments].sort((a, b) => a.order - b.order);

/**
 * A newer reading of `previous` that keeps every value that did not change, and
 * `previous` itself when nothing did. Snapshots arrive as freshly decoded
 * objects, so without this one changed field gives every environment in the
 * project, and every nested object in it, a new identity, and each subscriber
 * selecting any of them re-renders for a change it does not read.
 */
function reuseUnchangedFields(previous: Environment | undefined, next: Environment): Environment {
  if (!previous || previous === next) return next;
  const before = previous as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  const keys = Object.keys(after);
  let identical = keys.length === Object.keys(before).length;
  const reused: Record<string, unknown> = {};
  for (const key of keys) {
    if (deepEqualJson(before[key], after[key])) {
      reused[key] = before[key];
    } else {
      reused[key] = after[key];
      identical = false;
    }
  }
  return identical ? previous : (reused as unknown as Environment);
}

function reuseUnchangedEnvironments(
  previous: readonly Environment[],
  next: readonly Environment[],
): Environment[] {
  const byId = new Map(previous.map((environment) => [environment.id, environment]));
  return next.map((environment) => reuseUnchangedFields(byId.get(environment.id), environment));
}

const sameEnvironments = (a: readonly Environment[], b: readonly Environment[]): boolean =>
  a.length === b.length && a.every((environment, index) => environment === b[index]);

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

  setEnvironments: (environments) =>
    set((state) => {
      const sorted = sortByOrder(reuseUnchangedEnvironments(state.environments, environments));
      return sameEnvironments(state.environments, sorted) ? state : { environments: sorted };
    }),

  mergeEnvironmentsForProject: (projectId, newEnvironments) =>
    set((state) => {
      const current = state.environments.filter(
        (environment) => environment.projectId === projectId,
      );
      const sorted = sortByOrder(reuseUnchangedEnvironments(current, newEnvironments));
      if (sameEnvironments(current, sorted)) return state;
      return {
        environments: sortByOrder([
          ...state.environments.filter((environment) => environment.projectId !== projectId),
          ...sorted,
        ]),
      };
    }),

  addEnvironment: (environment) =>
    set((state) => ({ environments: sortByOrder([...state.environments, environment]) })),

  removeEnvironment: (environmentId) => {
    // Deleting an environment removes its conversations' rich view state,
    // render cache entries and cached artifact reads too.
    clearRichEnvironmentContent(environmentId);
    set((state) => {
      const deletingEnvironments = new Set(state.deletingEnvironments);
      deletingEnvironments.delete(environmentId);
      return {
        environments: state.environments.filter((environment) => environment.id !== environmentId),
        deletingEnvironments,
      };
    });
  },

  updateEnvironment: (environmentId, updates) =>
    set((state) => {
      const previous = state.environments.find((environment) => environment.id === environmentId);
      if (!previous) return state;
      const changed = (Object.keys(updates) as Array<keyof Environment>).some(
        (key) => !deepEqualJson(previous[key], updates[key]),
      );
      if (!changed) return state;
      const environments = state.environments.map((environment) =>
        environment.id === environmentId
          ? reuseUnchangedFields(environment, { ...environment, ...updates })
          : environment,
      );
      return {
        environments:
          updates.order !== undefined && updates.order !== previous.order
            ? sortByOrder(environments)
            : environments,
      };
    }),

  updateEnvironmentStatus: (environmentId, status) =>
    set((state) => {
      const current = state.environments.find((environment) => environment.id === environmentId);
      if (!current || current.status === status) return state;
      return {
        environments: state.environments.map((environment) =>
          environment === current ? { ...environment, status } : environment,
        ),
      };
    }),

  setEnvironmentPR: (environmentId, prUrl, prState, hasMergeConflicts) =>
    set((state) => {
      const current = state.environments.find((environment) => environment.id === environmentId);
      if (
        !current ||
        (current.prUrl === prUrl &&
          current.prState === prState &&
          current.hasMergeConflicts === (hasMergeConflicts ?? null))
      ) {
        return state;
      }
      return {
        environments: state.environments.map((environment) =>
          environment === current
            ? {
                ...environment,
                prUrl,
                prState,
                hasMergeConflicts: hasMergeConflicts ?? null,
                prMergeability: environment.prUrl === prUrl ? environment.prMergeability : null,
              }
            : environment,
        ),
      };
    }),

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
    get().deletingEnvironments.has(environmentId) ||
    get().environments.some(
      (environment) =>
        environment.id === environmentId &&
        (environment.lifecycleOperation === "deleting" || Boolean(environment.deletionRequestedAt)),
    ),
}));

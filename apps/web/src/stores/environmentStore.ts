import { create } from "zustand";
import type { Environment, EnvironmentStatus, PrState } from "@/types";

/** Sort environments by their order field */
const sortByOrder = (environments: Environment[]): Environment[] =>
  [...environments].sort((a, b) => a.order - b.order);

/**
 * Seed the runtime readiness sets from each environment's persisted
 * `setupScriptsComplete` flag. This avoids the "waiting for setup scripts"
 * UI on app restart for environments that finished setup in a prior session.
 */
const hydrateReadinessFromPersisted = (
  environments: Environment[],
  currentEnvironments: Environment[],
  currentSetupCommandsResolved: Set<string>,
  currentWorkspaceReady: Set<string>
): { setupCommandsResolved: Set<string>; workspaceReadyEnvironments: Set<string> } => {
  const setupCommandsResolved = new Set(currentSetupCommandsResolved);
  const workspaceReadyEnvironments = new Set(currentWorkspaceReady);
  const previousEnvironmentsById = new Map(
    currentEnvironments.map((environment) => [environment.id, environment])
  );
  for (const env of environments) {
    if (env.setupScriptsComplete) {
      setupCommandsResolved.add(env.id);
      workspaceReadyEnvironments.add(env.id);
      continue;
    }

    if (previousEnvironmentsById.get(env.id)?.setupScriptsComplete) {
      setupCommandsResolved.delete(env.id);
      workspaceReadyEnvironments.delete(env.id);
    }
  }
  return { setupCommandsResolved, workspaceReadyEnvironments };
};

interface EnvironmentState {
  // State
  environments: Environment[];
  isLoading: boolean;
  error: string | null;
  /** Runtime state: environments whose workspace is ready (git cloned, shell prompt available) */
  workspaceReadyEnvironments: Set<string>;
  /** Runtime state: environments currently being deleted */
  deletingEnvironments: Set<string>;
  /** Runtime state: pending setup commands to run in terminal (from orkestrator-ai.json setupLocal) */
  pendingSetupCommands: Map<string, string[]>;
  /** Runtime state: tracks whether setup commands have been resolved for an environment (true = we know if there are commands or not) */
  setupCommandsResolved: Set<string>;
  /** Runtime state: tracks environments where setup scripts are currently executing in a terminal */
  setupScriptsRunning: Set<string>;
  /**
   * Runtime state: environments that have been activated at least once this
   * app session. Used to trigger a one-shot setup re-run when opening an
   * environment whose persisted `setupScriptsComplete` is false.
   */
  sessionActivated: Set<string>;

  // Actions
  setEnvironments: (environments: Environment[]) => void;
  /** Merge environments for a specific project (replaces that project's envs, keeps others) */
  mergeEnvironmentsForProject: (projectId: string, environments: Environment[]) => void;
  addEnvironment: (environment: Environment) => void;
  removeEnvironment: (environmentId: string) => void;
  updateEnvironment: (
    environmentId: string,
    updates: Partial<Environment>
  ) => void;
  updateEnvironmentStatus: (
    environmentId: string,
    status: EnvironmentStatus
  ) => void;
  setEnvironmentPR: (environmentId: string, prUrl: string | null, prState: PrState | null, hasMergeConflicts?: boolean | null) => void;
  /** Reorder environments within a project based on the new order of IDs */
  reorderEnvironments: (projectId: string, environmentIds: string[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  /** Mark an environment's workspace as ready */
  setWorkspaceReady: (environmentId: string, isReady: boolean) => void;
  /** Mark an environment as being deleted */
  setDeleting: (environmentId: string, isDeleting: boolean) => void;
  /** Set pending setup commands for an environment (to be run in terminal) */
  setPendingSetupCommands: (environmentId: string, commands: string[]) => void;
  /** Get and clear pending setup commands for an environment */
  consumePendingSetupCommands: (environmentId: string) => string[] | undefined;
  /** Mark setup commands as resolved for an environment (we know if there are commands or not) */
  setSetupCommandsResolved: (environmentId: string, resolved: boolean) => void;
  /** Mark whether setup scripts are currently running for an environment */
  setSetupScriptsRunning: (environmentId: string, isRunning: boolean) => void;
  /**
   * Record that an environment has been activated this app session. Returns
   * true if this was the first activation (so callers can perform one-shot
   * work like re-running setup scripts).
   */
  markSessionActivated: (environmentId: string) => boolean;

  // Selectors
  getEnvironmentById: (environmentId: string) => Environment | undefined;
  getEnvironmentsByProjectId: (projectId: string) => Environment[];
  /** Check if an environment's workspace is ready */
  isWorkspaceReady: (environmentId: string) => boolean;
  /** Check if an environment is being deleted */
  isDeleting: (environmentId: string) => boolean;
  /** Check if setup commands have been resolved for an environment */
  isSetupCommandsResolved: (environmentId: string) => boolean;
  /** Check if setup scripts are currently running for an environment */
  isSetupScriptsRunning: (environmentId: string) => boolean;
}

export const useEnvironmentStore = create<EnvironmentState>()((set, get) => ({
  // Initial state
  environments: [],
  isLoading: false,
  error: null,
  workspaceReadyEnvironments: new Set<string>(),
  deletingEnvironments: new Set<string>(),
  pendingSetupCommands: new Map<string, string[]>(),
  setupCommandsResolved: new Set<string>(),
  setupScriptsRunning: new Set<string>(),
  sessionActivated: new Set<string>(),

  // Actions
  setEnvironments: (environments) =>
    set((state) => {
      const seeded = hydrateReadinessFromPersisted(
        environments,
        state.environments,
        state.setupCommandsResolved,
        state.workspaceReadyEnvironments
      );
      return {
        environments: sortByOrder(environments),
        setupCommandsResolved: seeded.setupCommandsResolved,
        workspaceReadyEnvironments: seeded.workspaceReadyEnvironments,
      };
    }),

  mergeEnvironmentsForProject: (projectId, newEnvs) =>
    set((state) => {
      // Keep environments from other projects, replace this project's environments
      const otherEnvs = state.environments.filter((e) => e.projectId !== projectId);
      const seeded = hydrateReadinessFromPersisted(
        newEnvs,
        state.environments,
        state.setupCommandsResolved,
        state.workspaceReadyEnvironments
      );
      return {
        environments: sortByOrder([...otherEnvs, ...newEnvs]),
        setupCommandsResolved: seeded.setupCommandsResolved,
        workspaceReadyEnvironments: seeded.workspaceReadyEnvironments,
      };
    }),

  addEnvironment: (environment) =>
    set((state) => {
      const seeded = hydrateReadinessFromPersisted(
        [environment],
        state.environments,
        state.setupCommandsResolved,
        state.workspaceReadyEnvironments
      );
      return {
        environments: sortByOrder([...state.environments, environment]),
        setupCommandsResolved: seeded.setupCommandsResolved,
        workspaceReadyEnvironments: seeded.workspaceReadyEnvironments,
      };
    }),

  removeEnvironment: (environmentId) =>
    set((state) => {
      // Clean up all related runtime state for this environment
      const newWorkspaceReady = new Set(state.workspaceReadyEnvironments);
      newWorkspaceReady.delete(environmentId);

      const newDeleting = new Set(state.deletingEnvironments);
      newDeleting.delete(environmentId);

      const newPendingCommands = new Map(state.pendingSetupCommands);
      newPendingCommands.delete(environmentId);

      const newSetupResolved = new Set(state.setupCommandsResolved);
      newSetupResolved.delete(environmentId);

      const newSetupRunning = new Set(state.setupScriptsRunning);
      newSetupRunning.delete(environmentId);

      const newSessionActivated = new Set(state.sessionActivated);
      newSessionActivated.delete(environmentId);

      return {
        environments: state.environments.filter((e) => e.id !== environmentId),
        workspaceReadyEnvironments: newWorkspaceReady,
        deletingEnvironments: newDeleting,
        pendingSetupCommands: newPendingCommands,
        setupCommandsResolved: newSetupResolved,
        setupScriptsRunning: newSetupRunning,
        sessionActivated: newSessionActivated,
      };
    }),

  updateEnvironment: (environmentId, updates) =>
    set((state) => {
      const nextState: Pick<EnvironmentState, "environments"> &
        Partial<Pick<EnvironmentState, "setupCommandsResolved" | "workspaceReadyEnvironments">> = {
        environments: sortByOrder(
          state.environments.map((e) =>
            e.id === environmentId ? { ...e, ...updates } : e
          )
        ),
      };

      // Only mirror setupScriptsComplete onto the runtime readiness sets when
      // the value has actually CHANGED from what we had before. Callers often
      // pass full environment objects returned from the backend (e.g.
      // updateEnvironmentAgentSettings, getEnvironment refreshes); those
      // responses carry the current-but-unchanged setupScriptsComplete value
      // as a passenger, and treating that as a deliberate transition wrongly
      // clobbers workspaceReady that was just flipped true by in-memory
      // setup-complete detection.
      if (typeof updates.setupScriptsComplete === "boolean") {
        const prevEnv = state.environments.find((e) => e.id === environmentId);
        const prevComplete = prevEnv?.setupScriptsComplete ?? false;
        if (prevComplete !== updates.setupScriptsComplete) {
          const setupCommandsResolved = new Set(state.setupCommandsResolved);
          const workspaceReadyEnvironments = new Set(state.workspaceReadyEnvironments);

          if (updates.setupScriptsComplete) {
            setupCommandsResolved.add(environmentId);
            workspaceReadyEnvironments.add(environmentId);
          } else {
            setupCommandsResolved.delete(environmentId);
            workspaceReadyEnvironments.delete(environmentId);
          }

          nextState.setupCommandsResolved = setupCommandsResolved;
          nextState.workspaceReadyEnvironments = workspaceReadyEnvironments;
        }
      }

      return nextState;
    }),

  updateEnvironmentStatus: (environmentId, status) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === environmentId ? { ...e, status } : e
      ),
    })),

  setEnvironmentPR: (environmentId, prUrl, prState, hasMergeConflicts) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === environmentId ? { ...e, prUrl, prState, hasMergeConflicts: hasMergeConflicts ?? null } : e
      ),
    })),

  reorderEnvironments: (projectId, environmentIds) =>
    set((state) => {
      // Keep environments from other projects as-is
      const otherProjectEnvs = state.environments.filter(
        (e) => e.projectId !== projectId
      );
      // Reorder environments for this project
      const reorderedEnvs = environmentIds
        .map((id, index) => {
          const env = state.environments.find(
            (e) => e.id === id && e.projectId === projectId
          );
          return env ? { ...env, order: index } : null;
        })
        .filter((e): e is Environment => e !== null);

      return {
        environments: [...otherProjectEnvs, ...reorderedEnvs],
      };
    }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  setWorkspaceReady: (environmentId, isReady) =>
    set((state) => {
      const newSet = new Set(state.workspaceReadyEnvironments);
      if (isReady) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { workspaceReadyEnvironments: newSet };
    }),

  setDeleting: (environmentId, isDeleting) =>
    set((state) => {
      const newSet = new Set(state.deletingEnvironments);
      if (isDeleting) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { deletingEnvironments: newSet };
    }),

  setPendingSetupCommands: (environmentId, commands) =>
    set((state) => {
      const newMap = new Map(state.pendingSetupCommands);
      newMap.set(environmentId, commands);
      return { pendingSetupCommands: newMap };
    }),

  consumePendingSetupCommands: (environmentId) => {
    const commands = get().pendingSetupCommands.get(environmentId);
    if (commands) {
      set((state) => {
        const newMap = new Map(state.pendingSetupCommands);
        newMap.delete(environmentId);
        return { pendingSetupCommands: newMap };
      });
    }
    return commands;
  },

  setSetupCommandsResolved: (environmentId, resolved) =>
    set((state) => {
      const isCurrentlyResolved = state.setupCommandsResolved.has(environmentId);

      // No-op when state is unchanged to avoid unnecessary rerenders.
      if (isCurrentlyResolved === resolved) {
        return state;
      }

      const newSet = new Set(state.setupCommandsResolved);
      if (resolved) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { setupCommandsResolved: newSet };
    }),

  setSetupScriptsRunning: (environmentId, isRunning) =>
    set((state) => {
      const isCurrentlyRunning = state.setupScriptsRunning.has(environmentId);
      if (isCurrentlyRunning === isRunning) {
        return state;
      }
      const newSet = new Set(state.setupScriptsRunning);
      if (isRunning) {
        newSet.add(environmentId);
      } else {
        newSet.delete(environmentId);
      }
      return { setupScriptsRunning: newSet };
    }),

  markSessionActivated: (environmentId) => {
    const alreadyActivated = get().sessionActivated.has(environmentId);
    if (alreadyActivated) return false;
    set((state) => {
      const newSet = new Set(state.sessionActivated);
      newSet.add(environmentId);
      return { sessionActivated: newSet };
    });
    return true;
  },

  // Selectors
  getEnvironmentById: (environmentId) =>
    get().environments.find((e) => e.id === environmentId),

  getEnvironmentsByProjectId: (projectId) =>
    sortByOrder(get().environments.filter((e) => e.projectId === projectId)),

  isWorkspaceReady: (environmentId) =>
    get().workspaceReadyEnvironments.has(environmentId),

  isDeleting: (environmentId) =>
    get().deletingEnvironments.has(environmentId),

  isSetupCommandsResolved: (environmentId) =>
    get().setupCommandsResolved.has(environmentId),

  isSetupScriptsRunning: (environmentId) =>
    get().setupScriptsRunning.has(environmentId),
}));

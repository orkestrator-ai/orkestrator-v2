// Hook for managing environment operations with Electron backend
import { useCallback, useEffect } from "react";
import { listen, type UnlistenFn } from "@/lib/native/events";
import { toast } from "sonner";
import { createSessionKey, useConfigStore, useEnvironmentStore, useErrorDialogStore, useTerminalSessionStore } from "@/stores";
import { useSessionStore } from "@/stores/sessionStore";
import * as backend from "@/lib/backend";
import type { Environment, EnvironmentType, NetworkAccessMode, PortMapping, PrState } from "@/types";

/**
 * Extract error message from various error types.
 * Electron errors can come as plain strings, Error objects, or objects with error info.
 */
function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return fallback;
}

/**
 * Truncate a message for display in toast notifications.
 * Full message can be shown via the Details dialog.
 */
function truncateForToast(message: string, maxLength = 50): string {
  return message.length > maxLength ? `${message.slice(0, maxLength)}...` : message;
}

/** Payload emitted when an environment is renamed in the background */
interface EnvironmentRenamedPayload {
  environment_id: string;
  new_name: string;
  new_branch: string;
}

interface EnvironmentSetupStartedPayload {
  environment_id: string;
  session_id: string;
  environment?: Environment;
}

interface EnvironmentSetupCompletePayload {
  environment_id: string;
  success: boolean;
  environment?: Environment;
  error?: string;
}

interface UseEnvironmentsOptions {
  listenForRenameEvents?: boolean;
}

interface LoadEnvironmentsOptions {
  /** Refresh store data without changing user-visible loading or error state. */
  silent?: boolean;
}

function bindSetupTerminalSession(environment: Environment, sessionId: string): void {
  const key = createSessionKey(environment.containerId ?? null, "default", environment.id);
  const store = useTerminalSessionStore.getState();
  const existing = store.sessions.get(key);
  console.info("[setup-terminal] binding setup session from environment hook", {
    environmentId: environment.id,
    environmentName: environment.name,
    environmentType: environment.environmentType,
    containerId: environment.containerId ?? null,
    key,
    previousSessionId: existing?.sessionId ?? null,
    nextSessionId: sessionId,
    hadSerializedBuffer: !!existing?.serializedBuffer,
    serializedBufferChars: existing?.serializedBuffer?.length ?? 0,
  });
  store.setSession(key, {
    ...existing,
    sessionId,
  });
}

function preserveCompletedSetupState(environmentId: string, environment: Environment): Environment {
  const current = useEnvironmentStore.getState().getEnvironmentById(environmentId);
  if (current?.setupScriptsComplete && environment.setupScriptsComplete === false) {
    return { ...environment, setupScriptsComplete: true };
  }
  return environment;
}

export function useEnvironments(
  projectId: string | null,
  options: UseEnvironmentsOptions = {}
) {
  const { listenForRenameEvents = true } = options;

  const {
    environments,
    isLoading,
    error,
    mergeEnvironmentsForProject,
    addEnvironment: addEnvironmentToStore,
    removeEnvironment: removeEnvironmentFromStore,
    updateEnvironment: updateEnvironmentInStore,
    updateEnvironmentStatus: updateStatusInStore,
    setEnvironmentPR: setPRInStore,
    reorderEnvironments: reorderEnvironmentsInStore,
    setLoading,
    setError,
    getEnvironmentsByProjectId,
    setDeleting,
    setPendingSetupCommands,
    consumePendingSetupCommands,
    setSetupCommandsResolved,
    setWorkspaceReady,
    setSetupScriptsRunning,
  } = useEnvironmentStore();

  const {
    disconnectEnvironmentSessions,
    deleteSessionsByEnvironment,
  } = useSessionStore();

  const { showError } = useErrorDialogStore();

  // Load environments when projectId changes
  useEffect(() => {
    if (projectId) {
      loadEnvironments(projectId);
    }
  }, [projectId]);

  // Listen for background environment rename events
  useEffect(() => {
    if (!listenForRenameEvents) {
      return;
    }

    let unlisten: UnlistenFn | null = null;

    const setupListener = async () => {
      unlisten = await listen<EnvironmentRenamedPayload>("environment-renamed", (event) => {
        console.log("[useEnvironments] Received environment-renamed event:", event.payload);
        const { environment_id, new_name, new_branch } = event.payload;

        // If the branch changed, clear stale PR state so monitoring starts
        // fresh for the new branch. Without this, a merged/closed PR from
        // the old branch would be preserved indefinitely.
        const currentEnv = useEnvironmentStore.getState().getEnvironmentById(environment_id);
        if (currentEnv && currentEnv.branch !== new_branch && currentEnv.prUrl) {
          console.log(
            `[useEnvironments] Branch changed (${currentEnv.branch} -> ${new_branch}), clearing stale PR state`
          );
          backend.clearEnvironmentPr(environment_id).catch((err) => {
            console.warn("[useEnvironments] Failed to clear PR state after branch rename:", err);
          });
          setPRInStore(environment_id, null, null, null);
        }

        // Update the environment in the store with the new name and branch
        updateEnvironmentInStore(environment_id, {
          name: new_name,
          branch: new_branch,
        });
      });
    };

    setupListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, [listenForRenameEvents, updateEnvironmentInStore, setPRInStore]);

  // Listen for backend-owned setup lifecycle events. Setup can run while the
  // terminal UI is unmounted, so these events are only incremental updates; the
  // persisted environment remains the source of truth on reload.
  useEffect(() => {
    let unlistenStarted: UnlistenFn | null = null;
    let unlistenComplete: UnlistenFn | null = null;

    const setupListeners = async () => {
      unlistenStarted = await listen<EnvironmentSetupStartedPayload>("environment-setup-started", (event) => {
        const { environment_id, session_id, environment } = event.payload;
        console.info("[setup-terminal] received environment-setup-started", {
          environmentId: environment_id,
          sessionId: session_id,
          hasEnvironment: !!environment,
          environmentType: environment?.environmentType ?? null,
          containerId: environment?.containerId ?? null,
        });
        if (environment) {
          updateEnvironmentInStore(environment_id, environment);
          bindSetupTerminalSession(environment, session_id);
        }
        consumePendingSetupCommands(environment_id);
        setSetupCommandsResolved(environment_id, true);
        setSetupScriptsRunning(environment_id, true);
        setWorkspaceReady(environment_id, false);
      });

      unlistenComplete = await listen<EnvironmentSetupCompletePayload>("environment-setup-complete", (event) => {
        const { environment_id, success, environment } = event.payload;
        console.info("[setup-terminal] received environment-setup-complete", {
          environmentId: environment_id,
          success,
          hasEnvironment: !!environment,
          setupScriptsComplete: environment?.setupScriptsComplete ?? null,
          error: event.payload.error ?? null,
        });
        if (environment) {
          updateEnvironmentInStore(environment_id, environment);
        }
        consumePendingSetupCommands(environment_id);
        setSetupCommandsResolved(environment_id, true);
        setSetupScriptsRunning(environment_id, false);
        if (success) {
          setWorkspaceReady(environment_id, true);
        }
      });
    };

    setupListeners();

    return () => {
      unlistenStarted?.();
      unlistenComplete?.();
    };
  }, [
    consumePendingSetupCommands,
    setSetupCommandsResolved,
    setSetupScriptsRunning,
    setWorkspaceReady,
    updateEnvironmentInStore,
  ]);

  const loadEnvironments = useCallback(
    async (pid: string, options: LoadEnvironmentsOptions = {}) => {
      const { silent = false } = options;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const envs = await backend.getEnvironments(pid);
        // Merge environments for this project (uses current store state, not stale closure)
        mergeEnvironmentsForProject(pid, envs);
      } catch (err) {
        const message = getErrorMessage(err, "Failed to load environments");
        if (silent) {
          console.warn(`[useEnvironments] Failed to refresh environments for project ${pid}:`, message);
        } else {
          setError(message);
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [mergeEnvironmentsForProject, setLoading, setError]
  );

  const createEnvironment = useCallback(
    async (pid: string, name?: string, networkAccessMode?: NetworkAccessMode, initialPrompt?: string, portMappings?: PortMapping[], environmentType?: EnvironmentType, namingPrompt?: string) => {
      setLoading(true);
      setError(null);
      try {
        const environment = await backend.createEnvironment(pid, name, networkAccessMode, initialPrompt, portMappings, environmentType, namingPrompt);
        addEnvironmentToStore(environment);
        useConfigStore.getState().setRepositoryLastEnvironmentType(pid, environment.environmentType);
        toast.success("Environment created");
        return environment;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to create environment");
        setError(message);
        toast.error("Failed to create environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to create environment", message),
          },
        });
        throw new Error(message);
      } finally {
        setLoading(false);
      }
    },
    [addEnvironmentToStore, setLoading, setError, showError]
  );

  const deleteEnvironment = useCallback(
    async (environmentId: string) => {
      setDeleting(environmentId, true);
      setError(null);
      try {
        // Delete all sessions for this environment first (cleans up buffer files too)
        await deleteSessionsByEnvironment(environmentId);

        await backend.deleteEnvironment(environmentId);
        removeEnvironmentFromStore(environmentId);
        toast.success("Environment deleted");
      } catch (err) {
        const message = getErrorMessage(err, "Failed to delete environment");
        setError(message);
        toast.error("Failed to delete environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to delete environment", message),
          },
        });
        throw new Error(message);
      } finally {
        setDeleting(environmentId, false);
      }
    },
    [removeEnvironmentFromStore, setError, deleteSessionsByEnvironment, setDeleting, showError]
  );

  const startEnvironment = useCallback(
    async (environmentId: string, initialPrompt?: string, options?: { silent?: boolean }) => {
      console.log("[useEnvironments] startEnvironment called:", environmentId);
      // Read from store directly to avoid stale closure over `environments`.
      // When called from handleCreateEnvironment, the useCallback closure may
      // capture an older environments array that doesn't include the new env.
      const existingEnv = useEnvironmentStore.getState().environments.find((env) => env.id === environmentId);
      if (!existingEnv) {
        console.warn("[useEnvironments] startEnvironment called for unknown environment:", environmentId);
      }
      if (existingEnv) {
        console.info("[useEnvironments] startEnvironment snapshot:", {
          environmentId,
          environmentType: existingEnv.environmentType,
          status: existingEnv.status,
          branch: existingEnv.branch,
          worktreePath: existingEnv.worktreePath,
          projectId: existingEnv.projectId,
        });
      }
      setError(null);

      // Block TerminalContainer init and prevent auto-resolve until the backend
      // returns the authoritative setup command plan.
      // by placing a placeholder in pendingSetupCommands BEFORE the async call.
      // This prevents the race where updateEnvironmentInStore (which sets worktreePath)
      // triggers isLocalEnvironmentReady=true and the auto-resolve fires before
      // real setup commands are stored.
      setWorkspaceReady(environmentId, false);
      setPendingSetupCommands(environmentId, []);
      setSetupCommandsResolved(environmentId, false);

      try {
        console.log("[useEnvironments] Setting status to creating...");
        updateStatusInStore(environmentId, "creating");
        console.log("[useEnvironments] Calling backend.startEnvironment...");
        const result = await backend.startEnvironment(environmentId);
        console.log("[useEnvironments] backend.startEnvironment completed, refreshing environment...", {
          setupCommands: result.setupCommands,
          setupManagedByBackend: result.setupManagedByBackend,
          setupStarted: result.setupStarted,
          setupSessionId: result.setupSessionId,
        });

        if (result.setupManagedByBackend) {
          consumePendingSetupCommands(environmentId);
        } else if (result.setupCommands && result.setupCommands.length > 0) {
          setPendingSetupCommands(environmentId, result.setupCommands);
        } else {
          consumePendingSetupCommands(environmentId);
        }

        // Refresh the full environment data (including containerId / worktreePath)
        const updatedEnv = await backend.getEnvironment(environmentId);
        let refreshedEnv: Environment | null = null;
        if (updatedEnv) {
          const safeUpdatedEnv = preserveCompletedSetupState(environmentId, updatedEnv);
          refreshedEnv = safeUpdatedEnv;
          console.log("[useEnvironments] Got updated environment:", safeUpdatedEnv);
          if (safeUpdatedEnv.environmentType === "local" && !safeUpdatedEnv.worktreePath) {
            console.warn("[useEnvironments] Local environment started without worktreePath:", {
              environmentId,
              status: safeUpdatedEnv.status,
              branch: safeUpdatedEnv.branch,
            });
          }
          updateEnvironmentInStore(environmentId, safeUpdatedEnv);
          if (result.setupSessionId) {
            bindSetupTerminalSession(safeUpdatedEnv, result.setupSessionId);
          }
        }

        if (result.setupManagedByBackend) {
          const store = useEnvironmentStore.getState();
          const setupComplete =
            refreshedEnv?.setupScriptsComplete === true ||
            store.getEnvironmentById(environmentId)?.setupScriptsComplete === true;
          const completionEventAlreadyHandled =
            !!result.setupStarted &&
            store.isSetupCommandsResolved(environmentId) &&
            !store.isSetupScriptsRunning(environmentId);

          if (setupComplete || store.isWorkspaceReady(environmentId)) {
            setSetupScriptsRunning(environmentId, false);
            setWorkspaceReady(environmentId, true);
          } else if (result.setupStarted && !completionEventAlreadyHandled) {
            setSetupScriptsRunning(environmentId, true);
            setWorkspaceReady(environmentId, false);
          } else {
            // Reached when either no setup ran (!setupStarted) or a completion
            // event was already handled while we awaited
            // (completionEventAlreadyHandled). Both mean setup is effectively
            // done, so mark the workspace ready. Forcing readiness to false here
            // (the old `!result.setupStarted`) stranded a just-completed env in a
            // "not running, not ready" state.
            setSetupScriptsRunning(environmentId, false);
            setWorkspaceReady(environmentId, true);
          }
        }

        setSetupCommandsResolved(environmentId, true);

        if (!options?.silent) {
          toast.success("Environment started");
        }
        return result.setupCommands;
      } catch (err) {
        // Unblock TerminalContainer on error so it doesn't hang
        setSetupCommandsResolved(environmentId, true);
        console.error("[useEnvironments] Error starting environment:", err);
        const message = getErrorMessage(err, "Failed to start environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        toast.error("Failed to start environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to start environment", message, initialPrompt),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, updateEnvironmentInStore, setError, showError, setPendingSetupCommands, consumePendingSetupCommands, setSetupCommandsResolved, setWorkspaceReady, setSetupScriptsRunning]
  );

  const stopEnvironment = useCallback(
    async (environmentId: string) => {
      console.log("[useEnvironments] stopEnvironment called:", environmentId);
      setError(null);
      try {
        // Immediately set status to stopping for user feedback
        console.log("[useEnvironments] Setting status to stopping...");
        updateStatusInStore(environmentId, "stopping");
        console.log("[useEnvironments] Calling backend.stopEnvironment...");
        await backend.stopEnvironment(environmentId);
        console.log("[useEnvironments] backend.stopEnvironment completed, updating status...");
        updateStatusInStore(environmentId, "stopped");
        console.log("[useEnvironments] Status updated to stopped");

        // Disconnect all sessions for this environment since container is stopped
        console.log("[useEnvironments] Disconnecting sessions for environment...");
        await disconnectEnvironmentSessions(environmentId);
        console.log("[useEnvironments] Sessions disconnected");
        toast.success("Environment stopped");
      } catch (err) {
        console.error("[useEnvironments] Error stopping environment:", err);
        const message = getErrorMessage(err, "Failed to stop environment");
        setError(message);
        // Revert to running if stop failed
        updateStatusInStore(environmentId, "running");
        toast.error("Failed to stop environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to stop environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, setError, disconnectEnvironmentSessions, showError]
  );

  const setEnvironmentPR = useCallback(
    async (environmentId: string, prUrl: string | null, prState: PrState | null) => {
      try {
        await setPRInStore(environmentId, prUrl, prState);
      } catch (err) {
        const message = getErrorMessage(err, "Failed to set PR URL");
        setError(message);
        toast.error("Failed to set PR URL", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to set PR URL", message),
          },
        });
        throw new Error(message);
      }
    },
    [setPRInStore, setError, showError]
  );

  const syncEnvironmentStatus = useCallback(
    async (environmentId: string) => {
      try {
        const updatedEnv = await backend.syncEnvironmentStatus(environmentId);
        updateEnvironmentInStore(environmentId, updatedEnv);
        return updatedEnv;
      } catch (err) {
        console.error("[useEnvironments] Error syncing environment status:", err);
        // Don't throw - just log the error
      }
    },
    [updateEnvironmentInStore]
  );

  const reorderEnvironments = useCallback(
    async (pid: string, environmentIds: string[]) => {
      // Optimistically update the store
      reorderEnvironmentsInStore(pid, environmentIds);
      try {
        // Persist to backend
        const reorderedEnvs = await backend.reorderEnvironments(pid, environmentIds);
        // Update with the server response (uses current store state, not stale closure)
        mergeEnvironmentsForProject(pid, reorderedEnvs);
      } catch (err) {
        // Reload from backend on error to restore correct state
        const message = getErrorMessage(err, "Failed to reorder environments");
        setError(message);
        toast.error("Failed to reorder environments", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to reorder environments", message),
          },
        });
        if (pid) {
          await loadEnvironments(pid);
        }
        throw new Error(message);
      }
    },
    [reorderEnvironmentsInStore, mergeEnvironmentsForProject, setError, loadEnvironments, showError]
  );

  const updatePortMappings = useCallback(
    async (environmentId: string, portMappings: PortMapping[]) => {
      try {
        const updated = await backend.updatePortMappings(environmentId, portMappings);
        updateEnvironmentInStore(environmentId, updated);
        return updated;
      } catch (err) {
        const message = getErrorMessage(err, "Failed to update port mappings");
        setError(message);
        toast.error("Failed to update port mappings", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to update port mappings", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateEnvironmentInStore, setError, showError]
  );

  const restartEnvironment = useCallback(
    async (environmentId: string) => {
      setError(null);
      try {
        // Stop the environment
        updateStatusInStore(environmentId, "stopping");
        await backend.stopEnvironment(environmentId);

        // Disconnect all sessions since container is stopped
        await disconnectEnvironmentSessions(environmentId);

        // Re-use startEnvironment which handles setup commands centrally.
        // Pass silent to suppress the "started" toast; we show "restarted" instead.
        await startEnvironment(environmentId, undefined, { silent: true });
        toast.success("Environment restarted");
      } catch (err) {
        console.error("[useEnvironments] Error restarting environment:", err);
        const message = getErrorMessage(err, "Failed to restart environment");
        setError(message);
        updateStatusInStore(environmentId, "error");
        toast.error("Failed to restart environment", {
          description: truncateForToast(message),
          action: {
            label: "Details",
            onClick: () => showError("Failed to restart environment", message),
          },
        });
        throw new Error(message);
      }
    },
    [updateStatusInStore, setError, disconnectEnvironmentSessions, startEnvironment, showError]
  );

  // Get environments for the current project
  const projectEnvironments = projectId ? getEnvironmentsByProjectId(projectId) : [];

  return {
    environments: projectEnvironments,
    allEnvironments: environments,
    isLoading,
    error,
    loadEnvironments,
    createEnvironment,
    deleteEnvironment,
    startEnvironment,
    stopEnvironment,
    restartEnvironment,
    setEnvironmentPR,
    syncEnvironmentStatus,
    reorderEnvironments,
    updateEnvironment: updateEnvironmentInStore,
    getEnvironmentsByProjectId,
    updatePortMappings,
  };
}

import { useEffect, useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { useFilesPanelStore, useConfigStore } from "@/stores";
import { useUIStore, useEnvironmentStore } from "@/stores";
import * as backend from "@/lib/backend";

// Auto-refresh interval in milliseconds (5 seconds)
const AUTO_REFRESH_INTERVAL = 5000;

/**
 * Hook for managing files panel data loading.
 * Loads git changes and file tree data from the active environment.
 * Supports both containerized (Docker) and local (worktree) environments.
 * Auto-refreshes every 5 seconds when the panel is open.
 */
export function useFilesPanel() {
  const { selectedEnvironmentId } = useUIStore();
  const { getEnvironmentById } = useEnvironmentStore();
  const { getRepositoryConfig } = useConfigStore();
  const {
    isOpen,
    activeTab,
    setChanges,
    setFileTree,
    setLoadingChanges,
    setLoadingTree,
    setTargetBranch,
  } = useFilesPanelStore();

  const selectedEnvironment = selectedEnvironmentId
    ? getEnvironmentById(selectedEnvironmentId)
    : null;

  // Detect environment type and get appropriate identifiers
  const isLocalEnvironment = selectedEnvironment?.environmentType === "local";
  const containerId = selectedEnvironment?.containerId ?? null;
  const worktreePath = selectedEnvironment?.worktreePath ?? null;
  const projectId = selectedEnvironment?.projectId ?? null;

  // Local environments are always "available" - they exist or don't exist
  // Container environments need to be running
  const isAvailable = isLocalEnvironment
    ? !!worktreePath
    : selectedEnvironment?.status === "running" && !!containerId;

  // Prefer the commit captured when the environment was created. Older
  // environments fall back to the repository PR base branch.
  const repoConfig = projectId ? getRepositoryConfig(projectId) : null;
  const comparisonRef = selectedEnvironment?.createdFromCommit || repoConfig?.prBaseBranch || "main";
  const environmentSnapshotKey = [
    selectedEnvironmentId ?? "",
    containerId ?? "",
    worktreePath ?? "",
    comparisonRef,
  ].join("\0");

  // Track loading state for changes and tree separately to allow concurrent loads
  // of different data types while preventing duplicate requests of the same type
  const loadingChangesRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const loadingTreeRef = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const activeSnapshotKeyRef = useRef(environmentSnapshotKey);
  activeSnapshotKeyRef.current = environmentSnapshotKey;
  const [fileActionPending, setFileActionPending] = useState<string | null>(null);

  // Store the target branch so other components can access it
  useEffect(() => {
    setTargetBranch(comparisonRef);
  }, [comparisonRef, setTargetBranch]);

  // Panel snapshots are global, so clear the previous environment immediately
  // and only allow requests for the current key to publish their result.
  useEffect(() => {
    setChanges([]);
    setFileTree([]);
    setLoadingChanges(false);
    setLoadingTree(false);
  }, [environmentSnapshotKey, setChanges, setFileTree, setLoadingChanges, setLoadingTree]);

  // Load git changes from environment (silent mode for auto-refresh)
  const loadChanges = useCallback((silent = false): Promise<void> => {
    if (!isAvailable) {
      setChanges([]);
      return Promise.resolve();
    }

    // Reuse an in-flight snapshot request instead of overlapping it.
    if (loadingChangesRef.current?.key === environmentSnapshotKey) {
      return loadingChangesRef.current.promise;
    }

    // Only show loading indicator on manual refresh, not auto-refresh
    if (!silent) {
      setLoadingChanges(true);
    }

    const request = (async () => {
      try {
        // Compare against the environment creation commit when available.
        let changes: backend.GitFileChange[] = [];
        if (isLocalEnvironment && worktreePath) {
          // Local environment - use local git status command
          changes = await backend.getLocalGitStatus(worktreePath, comparisonRef);
        } else if (containerId) {
          // Container environment - use container git status command
          changes = await backend.getGitStatus(containerId, comparisonRef);
        }
        if (activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setChanges(changes);
        }
      } catch (err) {
        console.error("Failed to load git changes:", err);
        // Only clear on non-silent (manual) refresh to avoid flickering
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setChanges([]);
        }
      } finally {
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setLoadingChanges(false);
        }
      }
    })();
    const inFlight = { key: environmentSnapshotKey, promise: request };
    loadingChangesRef.current = inFlight;
    void request.finally(() => {
      if (loadingChangesRef.current === inFlight) {
        loadingChangesRef.current = null;
      }
    });
    return request;
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, comparisonRef, environmentSnapshotKey, setChanges, setLoadingChanges]);

  // Load file tree from environment (silent mode for auto-refresh)
  const loadFileTree = useCallback((silent = false): Promise<void> => {
    if (!isAvailable) {
      setFileTree([]);
      return Promise.resolve();
    }

    // Reuse an in-flight snapshot request instead of overlapping it.
    if (loadingTreeRef.current?.key === environmentSnapshotKey) {
      return loadingTreeRef.current.promise;
    }

    if (!silent) {
      setLoadingTree(true);
    }

    const request = (async () => {
      try {
        let tree: backend.FileNode[] = [];
        if (isLocalEnvironment && worktreePath) {
          // Local environment - use local file tree command
          tree = await backend.getLocalFileTree(worktreePath);
        } else if (containerId) {
          // Container environment - use container file tree command
          tree = await backend.getFileTree(containerId);
        }
        if (activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setFileTree(tree);
        }
      } catch (err) {
        console.error("Failed to load file tree:", err);
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setFileTree([]);
        }
      } finally {
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          setLoadingTree(false);
        }
      }
    })();
    const inFlight = { key: environmentSnapshotKey, promise: request };
    loadingTreeRef.current = inFlight;
    void request.finally(() => {
      if (loadingTreeRef.current === inFlight) {
        loadingTreeRef.current = null;
      }
    });
    return request;
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, environmentSnapshotKey, setFileTree, setLoadingTree]);

  // Refresh data based on active tab (manual refresh shows loading indicator)
  const refresh = useCallback(() => {
    if (activeTab === "changes") {
      return loadChanges(false);
    } else {
      return Promise.all([loadFileTree(false), loadChanges(false)]).then(() => undefined);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  // Silent refresh for auto-refresh (no loading indicator)
  const silentRefresh = useCallback(() => {
    if (activeTab === "changes") {
      return loadChanges(true);
    } else {
      return Promise.all([loadFileTree(true), loadChanges(true)]).then(() => undefined);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  const refreshAllFilesData = useCallback(async () => {
    if (activeSnapshotKeyRef.current !== environmentSnapshotKey) return;
    // First wait for any snapshot that was already in flight when the mutation
    // began, then take a guaranteed post-mutation snapshot of both views.
    await Promise.all([loadChanges(true), loadFileTree(true)]);
    if (activeSnapshotKeyRef.current !== environmentSnapshotKey) return;
    await Promise.all([loadChanges(true), loadFileTree(true)]);
  }, [environmentSnapshotKey, loadChanges, loadFileTree]);

  const revertFile = useCallback(async (filePath: string) => {
    if (!isAvailable || !selectedEnvironmentId) {
      throw new Error("The selected environment is not available");
    }

    setFileActionPending(filePath);
    try {
      if (isLocalEnvironment && worktreePath) {
        await backend.revertLocalFile(selectedEnvironmentId, filePath, comparisonRef);
      } else if (containerId) {
        await backend.revertContainerFile(selectedEnvironmentId, filePath, comparisonRef);
      }
      await refreshAllFilesData();
      toast.success("File reverted", { description: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Failed to revert file", { description: message });
      throw error;
    } finally {
      setFileActionPending(null);
    }
  }, [isAvailable, selectedEnvironmentId, isLocalEnvironment, worktreePath, containerId, comparisonRef, refreshAllFilesData]);

  const deleteFile = useCallback(async (filePath: string) => {
    if (!isAvailable || !selectedEnvironmentId) {
      throw new Error("The selected environment is not available");
    }

    setFileActionPending(filePath);
    try {
      if (isLocalEnvironment && worktreePath) {
        await backend.deleteLocalFile(selectedEnvironmentId, filePath);
      } else if (containerId) {
        await backend.deleteContainerFile(selectedEnvironmentId, filePath);
      }
      await refreshAllFilesData();
      toast.success("File deleted", { description: filePath });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error("Failed to delete file", { description: message });
      throw error;
    } finally {
      setFileActionPending(null);
    }
  }, [isAvailable, selectedEnvironmentId, isLocalEnvironment, worktreePath, containerId, refreshAllFilesData]);

  // Load data when panel opens, tab changes, or environment changes
  useEffect(() => {
    if (isOpen && isAvailable) {
      refresh();
    }
  }, [isOpen, activeTab, isAvailable, containerId, worktreePath, refresh]);

  // Auto-refresh when panel is open and environment is available
  useEffect(() => {
    if (!isOpen || !isAvailable) {
      return;
    }

    const intervalId = setInterval(() => {
      silentRefresh();
    }, AUTO_REFRESH_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [isOpen, isAvailable, containerId, worktreePath, silentRefresh]);

  // Clear data when environment becomes unavailable
  useEffect(() => {
    if (!isAvailable) {
      setChanges([]);
      setFileTree([]);
    }
  }, [isAvailable, setChanges, setFileTree]);

  return {
    loadChanges,
    loadFileTree,
    refresh,
    isAvailable,
    containerId,
    worktreePath,
    isLocalEnvironment,
    environmentId: selectedEnvironmentId,
    revertFile,
    deleteFile,
    fileActionPending,
  };
}

import { useEffect, useCallback, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { useFilesPanelStore, useConfigStore } from "@/stores";
import { useUIStore, useEnvironmentStore } from "@/stores";
import * as backend from "@/lib/backend";
import { resolveComparisonRef } from "@/lib/diff-baseline";

// Auto-refresh interval in milliseconds (5 seconds)
const AUTO_REFRESH_INTERVAL = 5000;

/**
 * Hook for managing files panel data loading.
 * Loads git changes and file tree data from the active environment.
 * Supports both containerized (Docker) and local (worktree) environments.
 * Auto-refreshes every 5 seconds when the panel is open.
 */
export function useFilesPanel() {
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const { isOpen, activeTab } = useFilesPanelStore(
    useShallow((state) => ({ isOpen: state.isOpen, activeTab: state.activeTab }))
  );
  // Actions are stable references on the store.
  const {
    setChanges,
    setFileTree,
    setLoadingChanges,
    setLoadingTree,
    setTargetBranch,
  } = useFilesPanelStore(
    useShallow((state) => ({
      setChanges: state.setChanges,
      setFileTree: state.setFileTree,
      setLoadingChanges: state.setLoadingChanges,
      setLoadingTree: state.setLoadingTree,
      setTargetBranch: state.setTargetBranch,
    }))
  );

  const selectedEnvironment = useEnvironmentStore(
    (state) =>
      (selectedEnvironmentId
        ? state.environments.find((e) => e.id === selectedEnvironmentId)
        : null) ?? null
  );

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
  // environments fall back to the repository PR base branch, then its default
  // branch. Shared with the sidebar badge so both report the same numbers.
  // Selected narrowly: `config.repositories[id]` is a stored object with a
  // stable reference, so this only rerenders when that repo's config changes.
  const repoConfig = useConfigStore(
    (state) => (projectId ? state.config.repositories[projectId] : null) ?? null
  );
  const comparisonRef = resolveComparisonRef(selectedEnvironment?.createdFromCommit, repoConfig);
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

  // Digest of the last snapshot written to the store, per data type. The 5s
  // auto-refresh nearly always returns identical data; comparing a cheap digest
  // lets those ticks skip the store write (and the rerender it causes). The
  // skip is only taken while the store still holds exactly what we last wrote,
  // so an outside write to the store can never be masked by a stale digest.
  const changesDigestRef = useRef<{
    key: string;
    digest: string;
    written: backend.GitFileChange[];
  } | null>(null);
  const treeDigestRef = useRef<{
    key: string;
    digest: string;
    written: backend.FileNode[];
  } | null>(null);

  const publishChanges = useCallback(
    (key: string, changes: backend.GitFileChange[], serverDigest?: string) => {
      const digest = serverDigest ?? JSON.stringify(changes);
      const previous = changesDigestRef.current;
      if (
        previous?.key === key
        && previous.digest === digest
        && useFilesPanelStore.getState().changes === previous.written
      ) {
        return;
      }
      changesDigestRef.current = { key, digest, written: changes };
      setChanges(changes);
    },
    [setChanges]
  );

  const publishFileTree = useCallback(
    (key: string, tree: backend.FileNode[], serverDigest?: string) => {
      const digest = serverDigest ?? JSON.stringify(tree);
      const previous = treeDigestRef.current;
      if (
        previous?.key === key
        && previous.digest === digest
        && useFilesPanelStore.getState().fileTree === previous.written
      ) {
        return;
      }
      treeDigestRef.current = { key, digest, written: tree };
      setFileTree(tree);
    },
    [setFileTree]
  );


  // Store the target branch so other components can access it
  useEffect(() => {
    setTargetBranch(comparisonRef);
  }, [comparisonRef, setTargetBranch]);

  // Panel snapshots are global, so clear the previous environment immediately
  // and only allow requests for the current key to publish their result.
  useEffect(() => {
    publishChanges(environmentSnapshotKey, []);
    publishFileTree(environmentSnapshotKey, []);
    setLoadingChanges(false);
    setLoadingTree(false);
  }, [environmentSnapshotKey, publishChanges, publishFileTree, setLoadingChanges, setLoadingTree]);

  // Load git changes from environment (silent mode for auto-refresh)
  const loadChanges = useCallback((silent = false): Promise<void> => {
    if (!isAvailable) {
      publishChanges(environmentSnapshotKey, []);
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
        let snapshot: backend.ConditionalSnapshot<backend.GitFileChange[]> = {
          unchanged: false,
          digest: "",
          value: [],
        };
        const knownDigest = changesDigestRef.current?.key === environmentSnapshotKey
          ? changesDigestRef.current.digest
          : undefined;
        if (isLocalEnvironment && worktreePath) {
          snapshot = await backend.getLocalGitStatusSnapshot(
            worktreePath,
            comparisonRef,
            knownDigest,
          );
        } else if (containerId) {
          snapshot = await backend.getGitStatusSnapshot(
            containerId,
            comparisonRef,
            knownDigest,
          );
        }
        if (
          !snapshot.unchanged
          && snapshot.value
          && activeSnapshotKeyRef.current === environmentSnapshotKey
        ) {
          publishChanges(environmentSnapshotKey, snapshot.value, snapshot.digest);
        }
      } catch (err) {
        console.error("Failed to load git changes:", err);
        // Only clear on non-silent (manual) refresh to avoid flickering
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          publishChanges(environmentSnapshotKey, []);
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
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, comparisonRef, environmentSnapshotKey, publishChanges, setLoadingChanges]);

  // Load file tree from environment (silent mode for auto-refresh)
  const loadFileTree = useCallback((silent = false): Promise<void> => {
    if (!isAvailable) {
      publishFileTree(environmentSnapshotKey, []);
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
        let snapshot: backend.ConditionalSnapshot<backend.FileNode[]> = {
          unchanged: false,
          digest: "",
          value: [],
        };
        const knownDigest = treeDigestRef.current?.key === environmentSnapshotKey
          ? treeDigestRef.current.digest
          : undefined;
        if (isLocalEnvironment && worktreePath) {
          snapshot = await backend.getLocalFileTreeSnapshot(worktreePath, knownDigest);
        } else if (containerId) {
          snapshot = await backend.getFileTreeSnapshot(containerId, knownDigest);
        }
        if (
          !snapshot.unchanged
          && snapshot.value
          && activeSnapshotKeyRef.current === environmentSnapshotKey
        ) {
          publishFileTree(environmentSnapshotKey, snapshot.value, snapshot.digest);
        }
      } catch (err) {
        console.error("Failed to load file tree:", err);
        if (!silent && activeSnapshotKeyRef.current === environmentSnapshotKey) {
          publishFileTree(environmentSnapshotKey, []);
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
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, environmentSnapshotKey, publishFileTree, setLoadingTree]);

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
      publishChanges(environmentSnapshotKey, []);
      publishFileTree(environmentSnapshotKey, []);
    }
  }, [isAvailable, environmentSnapshotKey, publishChanges, publishFileTree]);

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

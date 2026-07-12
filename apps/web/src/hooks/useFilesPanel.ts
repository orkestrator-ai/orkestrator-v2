import { useEffect, useCallback, useRef } from "react";
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

  // Track loading state for changes and tree separately to allow concurrent loads
  // of different data types while preventing duplicate requests of the same type
  const loadingChangesRef = useRef(false);
  const loadingTreeRef = useRef(false);

  // Store the target branch so other components can access it
  useEffect(() => {
    setTargetBranch(comparisonRef);
  }, [comparisonRef, setTargetBranch]);

  // Load git changes from environment (silent mode for auto-refresh)
  const loadChanges = useCallback(async (silent = false) => {
    if (!isAvailable) {
      setChanges([]);
      return;
    }

    // Skip if already loading changes (prevents overlapping requests for same data)
    if (loadingChangesRef.current) return;

    loadingChangesRef.current = true;
    // Only show loading indicator on manual refresh, not auto-refresh
    if (!silent) {
      setLoadingChanges(true);
    }
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
      setChanges(changes);
    } catch (err) {
      console.error("Failed to load git changes:", err);
      // Only clear on non-silent (manual) refresh to avoid flickering
      if (!silent) {
        setChanges([]);
      }
    } finally {
      loadingChangesRef.current = false;
      if (!silent) {
        setLoadingChanges(false);
      }
    }
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, comparisonRef, setChanges, setLoadingChanges]);

  // Load file tree from environment (silent mode for auto-refresh)
  const loadFileTree = useCallback(async (silent = false) => {
    if (!isAvailable) {
      setFileTree([]);
      return;
    }

    // Skip if already loading tree (prevents overlapping requests for same data)
    if (loadingTreeRef.current) return;

    loadingTreeRef.current = true;
    if (!silent) {
      setLoadingTree(true);
    }
    try {
      let tree: backend.FileNode[] = [];
      if (isLocalEnvironment && worktreePath) {
        // Local environment - use local file tree command
        tree = await backend.getLocalFileTree(worktreePath);
      } else if (containerId) {
        // Container environment - use container file tree command
        tree = await backend.getFileTree(containerId);
      }
      setFileTree(tree);
    } catch (err) {
      console.error("Failed to load file tree:", err);
      if (!silent) {
        setFileTree([]);
      }
    } finally {
      loadingTreeRef.current = false;
      if (!silent) {
        setLoadingTree(false);
      }
    }
  }, [isAvailable, isLocalEnvironment, worktreePath, containerId, setFileTree, setLoadingTree]);

  // Refresh data based on active tab (manual refresh shows loading indicator)
  const refresh = useCallback(() => {
    if (activeTab === "changes") {
      loadChanges(false);
    } else {
      loadFileTree(false);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  // Silent refresh for auto-refresh (no loading indicator)
  const silentRefresh = useCallback(() => {
    if (activeTab === "changes") {
      loadChanges(true);
    } else {
      loadFileTree(true);
    }
  }, [activeTab, loadChanges, loadFileTree]);

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
  };
}

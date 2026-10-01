import { useEffect, useCallback, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { toast } from "sonner";
import { useFilesPanelStore, useConfigStore, usePaneLayoutStore } from "@/stores";
import { useUIStore, useEnvironmentStore, useProjectStore } from "@/stores";
import * as backend from "@/lib/backend";
import { resolveComparisonRef } from "@/lib/diff-baseline";
import { useCoordinatedRead } from "@/hooks/useCoordinatedRead";
import { useWorktreeSnapshotRevisions } from "@/hooks/useWorktreeSnapshotRevisions";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import type { WorktreeReadStamp } from "@orkestrator/protocol/worktree-snapshots";
import type { Environment } from "@/types";

// Auto-refresh interval in milliseconds (5 seconds)
const AUTO_REFRESH_INTERVAL = 5000;
export const MAX_EXTERNAL_FILE_DROP_BYTES = 8 * 1024 * 1024;
export const MAX_EXTERNAL_FILE_DROP_COUNT = 20;

/** What the panel last applied for one view, per environment snapshot key. */
type AppliedView = { key: string; stamp: WorktreeReadStamp };

/**
 * Whether the backend has announced a newer file list or tree than the one
 * the panel holds. Only comparable when the panel's last read was served by
 * the same owner generation; otherwise polling remains the only trigger.
 */
export function isAnnouncedNewer(
  announced: { targetGeneration: number; revision: number },
  ownerGeneration: string | null,
  applied: WorktreeReadStamp | undefined,
): boolean {
  if (!applied || !ownerGeneration) return false;
  if (applied.generation !== ownerGeneration) return true;
  if (applied.targetGeneration !== announced.targetGeneration) return true;
  return announced.revision > applied.revision;
}

function sameStamp(a: WorktreeReadStamp | undefined, b: WorktreeReadStamp): boolean {
  return (
    a !== undefined &&
    a.generation === b.generation &&
    a.environmentId === b.environmentId &&
    a.targetGeneration === b.targetGeneration &&
    a.revision === b.revision &&
    a.freshness === b.freshness &&
    a.watched === b.watched
  );
}

/** Omits the options argument entirely for an ordinary read (older call shape). */
function readOptionArgs(
  options: backend.SnapshotReadOptions | undefined,
): [] | [backend.SnapshotReadOptions] {
  return options?.refresh ? [options] : [];
}

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

export function encodeBytesAsBase64(bytes: Uint8Array): string {
  const chunkSize = 32 * 1024;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Raised when a batch file action could only be applied to part of its inputs.
 * `remainingPaths` are the paths that still need to be retried; callers use
 * them to narrow the pending action instead of re-running already-applied work.
 */
export class FileBatchActionError extends Error {
  readonly remainingPaths: string[];
  readonly completedPaths: string[];

  constructor(message: string, options: { remainingPaths: string[]; completedPaths: string[] }) {
    super(message);
    this.name = "FileBatchActionError";
    this.remainingPaths = options.remainingPaths;
    this.completedPaths = options.completedPaths;
  }
}

function workspaceBasename(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

/**
 * Mirror the backend's `resolveWorkspaceFileMove`
 * (`path.posix.join(directory, basename(source))`) so a batch that maps two
 * sources onto one destination fails closed before the first backend call. The
 * backend renames with RENAME_NOREPLACE, so the first move would otherwise
 * succeed and leave the user with a half-applied selection.
 */
export function findWorkspaceMoveConflicts(
  sourcePaths: readonly string[],
  destinationDirectory: string,
): string[] {
  const prefix = destinationDirectory === "." ? "" : `${destinationDirectory.replace(/\/+$/, "")}/`;
  const sourceSet = new Set(sourcePaths);
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const source of sourcePaths) {
    const destination = `${prefix}${workspaceBasename(source)}`;
    if (seen.has(destination) || (sourceSet.has(destination) && destination !== source)) {
      conflicts.add(destination);
    }
    seen.add(destination);
  }
  return [...conflicts];
}

/** Pseudo target id used for the project root before its home environment exists. */
export function projectRootFilesTargetId(projectId: string): string {
  return `project-root:${projectId}`;
}

/**
 * Returns the project's home environment, creating it on first use, and makes
 * it visible in the environment store. File mutations on the project root go
 * through it, because every backend file mutation is authorised by an
 * environment record.
 */
const pendingHomeEnsures = new Map<string, Promise<Environment>>();
export function ensureProjectHomeInStore(projectId: string): Promise<Environment> {
  const key = `${projectId}\0${useProjectStore.getState().projects.find((project) => project.id === projectId)?.localPath ?? ""}`;
  const pending = pendingHomeEnsures.get(key);
  if (pending) return pending;
  const task = reconcileHomeInStore(projectId).finally(() => {
    if (pendingHomeEnsures.get(key) === task) pendingHomeEnsures.delete(key);
  });
  pendingHomeEnsures.set(key, task);
  return task;
}
async function reconcileHomeInStore(projectId: string): Promise<Environment> {
  const configuredPath = useProjectStore
    .getState()
    .projects.find((project) => project.id === projectId)?.localPath;
  const environment = await backend.ensureProjectHomeEnvironment(projectId);
  if (
    useProjectStore.getState().projects.find((project) => project.id === projectId)?.localPath !==
    configuredPath
  ) {
    throw new Error("The project checkout changed; try the file action again");
  }
  const store = useEnvironmentStore.getState();
  if (store.environments.some((candidate) => candidate.id === environment.id)) {
    store.updateEnvironment(environment.id, environment);
  } else {
    store.addEnvironment(environment);
  }
  return environment;
}

function formatBatchFailure(completed: number, total: number, message: string): string {
  if (completed <= 0) return message;
  return `${completed} of ${total} files were changed before the failure: ${message}`;
}

/**
 * Hook for managing files panel data loading.
 * Loads git changes and file tree data from the active environment.
 * Supports both containerized (Docker) and local (worktree) environments.
 *
 * With a project selected and no environment (the project board, e.g.
 * Coordinator), the panel targets the project's own checkout. Reads go
 * straight to `Project.localPath`; mutations (drops, moves, reverts, deletes,
 * new folders) are applied through the project home environment, which is
 * created on the first mutation, so a dropped file lands in the root checkout
 * and is reported as a change like any other edit.
 * Auto-refreshes every 5 seconds when the panel is open and the document is
 * visible (scheduled by the shared read coordinator).
 *
 * On a current backend the panel also subscribes to the worktree snapshot
 * revisions (subscribe before hydrating, bounded; see
 * `useWorktreeSnapshotRevisions`) and re-reads the file list or tree as soon
 * as the backend announces a revision newer than the one it shows — including
 * list changes that leave the diff counts identical. The 5 s poll stays: it is
 * the only trigger for legacy backends and unwatched targets (containers), and
 * the backend answers it for a quiet watched worktree from valid watched state
 * without rescanning.
 */
export function useFilesPanel() {
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const { isOpen, activeTab } = useFilesPanelStore(
    useShallow((state) => ({ isOpen: state.isOpen, activeTab: state.activeTab })),
  );
  // Actions are stable references on the store.
  const { setChanges, setFileTree, setLoadingChanges, setLoadingTree, setTargetBranch } =
    useFilesPanelStore(
      useShallow((state) => ({
        setChanges: state.setChanges,
        setFileTree: state.setFileTree,
        setLoadingChanges: state.setLoadingChanges,
        setLoadingTree: state.setLoadingTree,
        setTargetBranch: state.setTargetBranch,
      })),
    );

  const selectedEnvironment = useEnvironmentStore(
    (state) =>
      (selectedEnvironmentId
        ? state.environments.find((e) => e.id === selectedEnvironmentId)
        : null) ?? null,
  );

  // Project scope: a project is selected without an environment, so the panel
  // shows that project's own checkout.
  const rootProject = useProjectStore((state) =>
    !selectedEnvironmentId && selectedProjectId
      ? (state.projects.find((project) => project.id === selectedProjectId) ?? null)
      : null,
  );
  const isProjectScope = !selectedEnvironmentId && !!rootProject;
  const projectHomeEnvironment = useEnvironmentStore((state) =>
    isProjectScope && rootProject
      ? (state.environments.find(
          (environment) =>
            environment.projectId === rootProject.id &&
            environment.projectHome === true &&
            !environment.deletionRequestedAt,
        ) ?? null)
      : null,
  );
  // The environment whose snapshots and tabs describe what the panel shows.
  const snapshotEnvironmentId = isProjectScope
    ? projectHomeEnvironment?.worktreePath === rootProject?.localPath?.trim()
      ? (projectHomeEnvironment?.id ?? null)
      : null
    : selectedEnvironmentId;
  // Identifies the panel's target even before a project home exists.
  const targetId = isProjectScope
    ? projectRootFilesTargetId(rootProject!.id)
    : selectedEnvironmentId;

  // Detect environment type and get appropriate identifiers
  const isLocalEnvironment = isProjectScope || selectedEnvironment?.environmentType === "local";
  const containerId = isProjectScope ? null : (selectedEnvironment?.containerId ?? null);
  // Always follow the configured checkout; cached home records may name an old path.
  const worktreePath = isProjectScope
    ? rootProject?.localPath?.trim() || null
    : (selectedEnvironment?.worktreePath ?? null);
  const projectId = isProjectScope ? rootProject!.id : (selectedEnvironment?.projectId ?? null);

  // Local environments are always "available" - they exist or don't exist
  // Container environments need to be running
  const isAvailable = isLocalEnvironment
    ? !!worktreePath
    : selectedEnvironment?.status === "running" && !!containerId;

  // The environment id that authorises a file mutation. In project scope the
  // project home is created on demand.
  const resolveMutationEnvironmentId = useCallback(async (): Promise<string> => {
    if (!isProjectScope) {
      if (!selectedEnvironmentId) throw new Error("The selected environment is not available");
      return selectedEnvironmentId;
    }
    const currentPath = useProjectStore
      .getState()
      .projects.find((project) => project.id === projectId)
      ?.localPath?.trim();
    if (!currentPath || currentPath !== worktreePath)
      throw new Error("The project checkout changed; try the file action again");
    return (await ensureProjectHomeInStore(projectId!)).id;
  }, [isProjectScope, selectedEnvironmentId, projectId, worktreePath]);

  // Prefer the commit captured when the environment was created. Older
  // environments fall back to the repository PR base branch, then its default
  // branch. Shared with the sidebar badge so both report the same numbers.
  // Selected narrowly: `config.repositories[id]` is a stored object with a
  // stable reference, so this only rerenders when that repo's config changes.
  const repoConfig = useConfigStore(
    (state) => (projectId ? state.config.repositories[projectId] : null) ?? null,
  );
  const comparisonRef = resolveComparisonRef(
    isProjectScope
      ? projectHomeEnvironment?.createdFromCommit
      : selectedEnvironment?.createdFromCommit,
    repoConfig,
  );
  const environmentSnapshotKey = [
    targetId ?? "",
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
  // Owner stamps of the list and tree the panel last applied (state, so an
  // announcement that raced an in-flight read is re-checked when it lands).
  const [appliedChangesView, setAppliedChangesView] = useState<AppliedView | null>(null);
  const [appliedTreeView, setAppliedTreeView] = useState<AppliedView | null>(null);
  const recordView = useCallback(
    (view: "changes" | "tree", key: string, stamp: WorktreeReadStamp | undefined) => {
      if (!stamp) return;
      const update = (previous: AppliedView | null) =>
        previous?.key === key && sameStamp(previous.stamp, stamp) ? previous : { key, stamp };
      if (view === "changes") setAppliedChangesView(update);
      else setAppliedTreeView(update);
    },
    [],
  );

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
        previous?.key === key &&
        previous.digest === digest &&
        useFilesPanelStore.getState().changes === previous.written
      ) {
        return;
      }
      changesDigestRef.current = { key, digest, written: changes };
      setChanges(changes);
    },
    [setChanges],
  );

  const publishFileTree = useCallback(
    (key: string, tree: backend.FileNode[], serverDigest?: string) => {
      const digest = serverDigest ?? JSON.stringify(tree);
      const previous = treeDigestRef.current;
      if (
        previous?.key === key &&
        previous.digest === digest &&
        useFilesPanelStore.getState().fileTree === previous.written
      ) {
        return;
      }
      treeDigestRef.current = { key, digest, written: tree };
      setFileTree(tree);
    },
    [setFileTree],
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
  const loadChanges = useCallback(
    (silent = false, options?: backend.SnapshotReadOptions): Promise<void> => {
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
          const knownDigest =
            changesDigestRef.current?.key === environmentSnapshotKey
              ? changesDigestRef.current.digest
              : undefined;
          if (isLocalEnvironment && worktreePath) {
            snapshot = await backend.getLocalGitStatusSnapshot(
              worktreePath,
              comparisonRef,
              knownDigest,
              ...readOptionArgs(options),
            );
          } else if (containerId) {
            snapshot = await backend.getGitStatusSnapshot(
              containerId,
              comparisonRef,
              knownDigest,
              ...readOptionArgs(options),
            );
          }
          if (activeSnapshotKeyRef.current === environmentSnapshotKey) {
            recordView("changes", environmentSnapshotKey, snapshot.view);
          }
          if (
            !snapshot.unchanged &&
            snapshot.value &&
            activeSnapshotKeyRef.current === environmentSnapshotKey
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
    },
    [
      isAvailable,
      isLocalEnvironment,
      worktreePath,
      containerId,
      comparisonRef,
      environmentSnapshotKey,
      publishChanges,
      recordView,
      setLoadingChanges,
    ],
  );

  // Load file tree from environment (silent mode for auto-refresh)
  const loadFileTree = useCallback(
    (silent = false, options?: backend.SnapshotReadOptions): Promise<void> => {
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
          const knownDigest =
            treeDigestRef.current?.key === environmentSnapshotKey
              ? treeDigestRef.current.digest
              : undefined;
          if (isLocalEnvironment && worktreePath) {
            snapshot = await backend.getLocalFileTreeSnapshot(
              worktreePath,
              knownDigest,
              ...readOptionArgs(options),
            );
          } else if (containerId) {
            snapshot = await backend.getFileTreeSnapshot(
              containerId,
              knownDigest,
              ...readOptionArgs(options),
            );
          }
          if (activeSnapshotKeyRef.current === environmentSnapshotKey) {
            recordView("tree", environmentSnapshotKey, snapshot.view);
          }
          if (
            !snapshot.unchanged &&
            snapshot.value &&
            activeSnapshotKeyRef.current === environmentSnapshotKey
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
    },
    [
      isAvailable,
      isLocalEnvironment,
      worktreePath,
      containerId,
      environmentSnapshotKey,
      publishFileTree,
      recordView,
      setLoadingTree,
    ],
  );

  // Load data for the active tab, showing the loading indicator. Joins an
  // equivalent snapshot request already in flight.
  const loadVisible = useCallback(
    (options?: backend.SnapshotReadOptions) => {
      if (activeTab === "changes") {
        return loadChanges(false, options);
      } else {
        return Promise.all([loadFileTree(false, options), loadChanges(false, options)]).then(
          () => undefined,
        );
      }
    },
    [activeTab, loadChanges, loadFileTree],
  );

  // Silent refresh for auto-refresh (no loading indicator)
  const silentRefresh = useCallback(() => {
    if (activeTab === "changes") {
      return loadChanges(true);
    } else {
      return Promise.all([loadFileTree(true), loadChanges(true)]).then(() => undefined);
    }
  }, [activeTab, loadChanges, loadFileTree]);

  // The 5 s auto-refresh is owned by the shared read coordinator: one timer
  // per environment/tab key, paused while the document is hidden,
  // reconciled once on return. The store is global, so equivalent mounts
  // share one read. The open/tab/target read below and post-mutation reads
  // stay direct.
  const filesRead = useCoordinatedRead({
    key: { resource: "files-panel", target: environmentSnapshotKey, options: activeTab },
    enabled: isAvailable,
    readOnSubscribe: false,
    demand: { active: isOpen && isAvailable, intervalMs: AUTO_REFRESH_INTERVAL },
    read: async (context) => {
      if (!context.explicit) return silentRefresh();
      // An explicit refresh needs a post-click observation, so it must not
      // join a snapshot request that started earlier — here or in the
      // backend, which the refresh flag asks for a scan after the click.
      await Promise.all([loadingChangesRef.current?.promise, loadingTreeRef.current?.promise]);
      return loadVisible({ refresh: true });
    },
  });
  const refreshExplicitly = filesRead.refresh;
  // Manual refresh shows the loading indicator and always reads afresh.
  const refresh = useCallback(async () => {
    await refreshExplicitly();
  }, [refreshExplicitly]);

  const refreshAllFilesData = useCallback(async () => {
    if (activeSnapshotKeyRef.current !== environmentSnapshotKey) return;
    // First wait for any snapshot that was already in flight when the mutation
    // began, then take a guaranteed post-mutation snapshot of both views.
    await Promise.all([loadChanges(true), loadFileTree(true)]);
    if (activeSnapshotKeyRef.current !== environmentSnapshotKey) return;
    await Promise.all([loadChanges(true), loadFileTree(true)]);
  }, [environmentSnapshotKey, loadChanges, loadFileTree]);

  const revertFile = useCallback(
    async (filePath: string) => {
      if (!isAvailable || !targetId) {
        throw new Error("The selected environment is not available");
      }

      setFileActionPending(filePath);
      try {
        const environmentId = await resolveMutationEnvironmentId();
        if (isLocalEnvironment && worktreePath) {
          await backend.revertLocalFile(environmentId, filePath, comparisonRef);
        } else if (containerId) {
          await backend.revertContainerFile(environmentId, filePath, comparisonRef);
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
    },
    [
      isAvailable,
      targetId,
      resolveMutationEnvironmentId,
      isLocalEnvironment,
      worktreePath,
      containerId,
      comparisonRef,
      refreshAllFilesData,
    ],
  );

  const deleteFile = useCallback(
    async (filePath: string | string[]) => {
      if (!isAvailable || !targetId) {
        throw new Error("The selected environment is not available");
      }

      const paths = Array.isArray(filePath) ? [...new Set(filePath)] : [filePath];
      if (paths.length === 0) return;

      setFileActionPending(paths[0]!);
      const completedPaths: string[] = [];
      const failures: Array<{ path: string; message: string }> = [];
      try {
        const environmentId = await resolveMutationEnvironmentId().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          toast.error(paths.length === 1 ? "Failed to delete file" : "Failed to delete files", {
            description: message,
          });
          throw error;
        });
        // Attempt every path even if one fails, so a single collision cannot
        // abandon the rest of the selection and a retry only has to target the
        // paths that actually failed.
        for (const path of paths) {
          try {
            if (isLocalEnvironment && worktreePath) {
              await backend.deleteLocalFile(environmentId, path);
            } else if (containerId) {
              await backend.deleteContainerFile(environmentId, path);
            }
            completedPaths.push(path);
          } catch (error) {
            failures.push({
              path,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (completedPaths.length > 0) {
          await refreshAllFilesData();
        }

        if (failures.length === 0) {
          if (paths.length === 1) {
            toast.success("File deleted", { description: paths[0] });
          } else {
            toast.success("Files deleted", { description: `${paths.length} files` });
          }
          return;
        }

        const message = formatBatchFailure(
          completedPaths.length,
          paths.length,
          failures[0]!.message,
        );
        toast.error(paths.length === 1 ? "Failed to delete file" : "Failed to delete files", {
          description: message,
        });
        throw new FileBatchActionError(message, {
          remainingPaths: failures.map((failure) => failure.path),
          completedPaths,
        });
      } finally {
        setFileActionPending(null);
      }
    },
    [
      isAvailable,
      targetId,
      resolveMutationEnvironmentId,
      isLocalEnvironment,
      worktreePath,
      containerId,
      refreshAllFilesData,
    ],
  );

  const moveFile = useCallback(
    async (sourcePath: string | string[], destinationDirectory: string) => {
      if (!isAvailable || !targetId) {
        throw new Error("The selected environment is not available");
      }

      const sourcePaths = Array.isArray(sourcePath) ? [...new Set(sourcePath)] : [sourcePath];
      if (sourcePaths.length === 0) return;

      const openTabs = snapshotEnvironmentId
        ? usePaneLayoutStore.getState().getAllTabs(snapshotEnvironmentId)
        : [];
      const openPaths = sourcePaths.filter((path) =>
        openTabs.some((tab) => tab.type === "file" && tab.fileData?.filePath === path),
      );
      if (openPaths.length > 0) {
        const error = new Error(
          openPaths.length === 1
            ? "Close the file's editor tab before moving it"
            : "Close the selected files' editor tabs before moving them",
        );
        toast.error(
          openPaths.length === 1 ? "Cannot move an open file" : "Cannot move open files",
          {
            description: error.message,
          },
        );
        throw error;
      }

      const conflicts = findWorkspaceMoveConflicts(sourcePaths, destinationDirectory);
      if (conflicts.length > 0) {
        const error = new Error(
          `Two or more selected files would be moved to ${conflicts.join(", ")}. Rename or deselect one before moving.`,
        );
        toast.error("Cannot move files", { description: error.message });
        throw error;
      }

      setFileActionPending(sourcePaths[0]!);
      const destinations: string[] = [];
      const completedPaths: string[] = [];
      const failures: Array<{ path: string; message: string }> = [];
      try {
        const environmentId = await resolveMutationEnvironmentId().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          toast.error(sourcePaths.length === 1 ? "Failed to move file" : "Failed to move files", {
            description: message,
          });
          throw error;
        });
        // Attempt every path even if one fails so a retry targets only the
        // paths that did not move.
        for (const path of sourcePaths) {
          try {
            const destination =
              isLocalEnvironment && worktreePath
                ? await backend.moveLocalFile(environmentId, path, destinationDirectory)
                : await backend.moveContainerFile(environmentId, path, destinationDirectory);
            destinations.push(destination);
            completedPaths.push(path);
          } catch (error) {
            failures.push({
              path,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (completedPaths.length > 0) {
          await refreshAllFilesData();
        }

        if (failures.length === 0) {
          if (sourcePaths.length === 1) {
            toast.success("File moved", { description: destinations[0] });
          } else {
            toast.success("Files moved", { description: `${sourcePaths.length} files` });
          }
          return;
        }

        const message = formatBatchFailure(
          completedPaths.length,
          sourcePaths.length,
          failures[0]!.message,
        );
        toast.error(sourcePaths.length === 1 ? "Failed to move file" : "Failed to move files", {
          description: message,
        });
        throw new FileBatchActionError(message, {
          remainingPaths: failures.map((failure) => failure.path),
          completedPaths,
        });
      } finally {
        setFileActionPending(null);
      }
    },
    [
      isAvailable,
      targetId,
      snapshotEnvironmentId,
      resolveMutationEnvironmentId,
      isLocalEnvironment,
      worktreePath,
      refreshAllFilesData,
    ],
  );

  const createFolder = useCallback(
    async (parentDirectory: string, folderName: string) => {
      if (!isAvailable || !targetId) {
        throw new Error("The selected environment is not available");
      }

      const pendingKey = `${parentDirectory}\0${folderName}`;
      setFileActionPending(pendingKey);
      try {
        const environmentId = await resolveMutationEnvironmentId();
        const created =
          isLocalEnvironment && worktreePath
            ? await backend.createLocalFolder(environmentId, parentDirectory, folderName)
            : await backend.createContainerFolder(environmentId, parentDirectory, folderName);
        await refreshAllFilesData();
        toast.success("Folder created", { description: created });
        return created;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error("Failed to create folder", { description: message });
        throw error;
      } finally {
        setFileActionPending(null);
      }
    },
    [
      isAvailable,
      targetId,
      resolveMutationEnvironmentId,
      isLocalEnvironment,
      worktreePath,
      refreshAllFilesData,
    ],
  );

  const copyExternalFiles = useCallback(
    async (files: File[], destinationDirectory: string) => {
      if (!isAvailable || !targetId) {
        const error = new Error("The selected environment is not available");
        toast.error(files.length === 1 ? "Failed to copy file" : "Failed to copy files", {
          description: error.message,
        });
        throw error;
      }
      if (files.length === 0) return;
      if (files.length > MAX_EXTERNAL_FILE_DROP_COUNT) {
        const error = new Error(`Drop up to ${MAX_EXTERNAL_FILE_DROP_COUNT} files at a time`);
        toast.error("Too many files", { description: error.message });
        throw error;
      }
      const oversized = files.find((file) => file.size > MAX_EXTERNAL_FILE_DROP_BYTES);
      if (oversized) {
        const error = new Error(`${oversized.name} exceeds the 8 MB file limit`);
        toast.error("File too large", { description: error.message });
        throw error;
      }

      setFileActionPending(`copy\0${destinationDirectory}`);
      const completedPaths: string[] = [];
      const failures: Array<{ name: string; message: string }> = [];
      try {
        // In project scope this lands in the root checkout via its home.
        const environmentId = await resolveMutationEnvironmentId().catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          toast.error(files.length === 1 ? "Failed to copy file" : "Failed to copy files", {
            description: message,
          });
          throw error;
        });
        for (const file of files) {
          try {
            const contents = new Uint8Array(await file.arrayBuffer());
            const destination = await backend.copyExternalFile(
              environmentId,
              destinationDirectory,
              file.name,
              encodeBytesAsBase64(contents),
            );
            completedPaths.push(destination);
          } catch (error) {
            failures.push({
              name: file.name,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }

        if (completedPaths.length > 0) {
          await refreshAllFilesData();
        }
        if (failures.length === 0) {
          toast.success(files.length === 1 ? "File copied" : "Files copied", {
            description: files.length === 1 ? completedPaths[0] : `${completedPaths.length} files`,
          });
          return;
        }

        const message = formatBatchFailure(
          completedPaths.length,
          files.length,
          failures[0]!.message,
        );
        toast.error(files.length === 1 ? "Failed to copy file" : "Failed to copy files", {
          description: message,
        });
        throw new FileBatchActionError(message, {
          remainingPaths: failures.map((failure) => failure.name),
          completedPaths,
        });
      } finally {
        setFileActionPending(null);
      }
    },
    [isAvailable, targetId, resolveMutationEnvironmentId, refreshAllFilesData],
  );

  // Announced revisions: subscribe (and hydrate) only while the panel is open.
  useWorktreeSnapshotRevisions({ enabled: isOpen });
  const announced = useWorktreeSnapshotStore((state) =>
    snapshotEnvironmentId ? state.entries.get(snapshotEnvironmentId) : undefined,
  );
  const ownerGeneration = useWorktreeSnapshotStore((state) => state.generation);

  // Re-read exactly the view whose announced revision is newer than what the
  // panel shows. A hidden document skips this: the coordinator reconciles once
  // on return. Revisions for a different baseline are ignored until the
  // panel's own comparison ref catches up.
  useEffect(() => {
    if (!isOpen || !isAvailable || !announced || documentHidden()) return;
    if (announced.comparisonRef !== comparisonRef) return;
    const changesView =
      appliedChangesView?.key === environmentSnapshotKey ? appliedChangesView.stamp : undefined;
    if (
      isAnnouncedNewer(
        { targetGeneration: announced.targetGeneration, revision: announced.fileListRevision },
        ownerGeneration,
        changesView,
      )
    ) {
      void loadChanges(true);
    }
    if (activeTab === "changes") return;
    const treeView =
      appliedTreeView?.key === environmentSnapshotKey ? appliedTreeView.stamp : undefined;
    if (
      isAnnouncedNewer(
        { targetGeneration: announced.targetGeneration, revision: announced.treeRevision },
        ownerGeneration,
        treeView,
      )
    ) {
      void loadFileTree(true);
    }
  }, [
    announced,
    ownerGeneration,
    appliedChangesView,
    appliedTreeView,
    isOpen,
    isAvailable,
    activeTab,
    comparisonRef,
    environmentSnapshotKey,
    loadChanges,
    loadFileTree,
  ]);

  // Load data when panel opens, tab changes, or environment changes
  useEffect(() => {
    if (isOpen && isAvailable) {
      void loadVisible();
    }
  }, [isOpen, activeTab, isAvailable, containerId, worktreePath, loadVisible]);

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
    /** Target identity: the selected environment, or the project root pseudo id. */
    environmentId: targetId,
    /** Set when the panel shows a project's root checkout instead of an environment. */
    projectScopeProjectId: isProjectScope ? projectId : null,
    revertFile,
    deleteFile,
    moveFile,
    createFolder,
    copyExternalFiles,
    fileActionPending,
  };
}

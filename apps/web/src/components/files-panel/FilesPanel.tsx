import { useCallback, useState } from "react";
import { toast } from "sonner";
import { FilesPanelHeader } from "./FilesPanelHeader";
import { ChangesView } from "./ChangesView";
import { AllFilesView } from "./AllFilesView";
import { FilesPanelPullRequests } from "./FilesPanelPullRequests";
import { FileActionDialog, type PendingFileAction } from "./FileActionDialog";
import { DiffBaseDialog } from "./DiffBaseDialog";
import { DiffBaseNotice } from "./DiffBaseNotice";
import { useFilesPanelStore, useUIStore } from "@/stores";
import { isFilesPanelFileTab } from "@/stores/filesPanelStore";
import { useFilesPanel, FileBatchActionError } from "@/hooks";
import { ensureProjectHomeInStore } from "@/hooks/useFilesPanel";
import { errorText } from "@/components/settings/machines/machine-ui";
import type { CreateFileTabOptions } from "@/contexts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { revealInFileManager } from "@/lib/backend";
import { useWorktreeSnapshotStore } from "@/stores/worktreeSnapshotStore";
import { hydrationFreshnessNotice, remoteFreshnessNotice } from "@/lib/view-freshness";
import { FreshnessIndicator } from "@/components/freshness/FreshnessIndicator";

function resolveLocalFilePath(worktreePath: string, filePath: string): string {
  const separator = worktreePath.includes("\\") && !worktreePath.includes("/") ? "\\" : "/";
  return `${worktreePath.replace(/[\\/]+$/, "")}${separator}${filePath.replace(/^[\\/]+/, "")}`;
}

export function FilesPanel() {
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const targetBranch = useFilesPanelStore((state) => state.targetBranch);
  const [pendingAction, setPendingAction] = useState<PendingFileAction | null>(null);
  const [diffBaseDialogOpen, setDiffBaseDialogOpen] = useState(false);

  // Initialize the files panel data loading
  const {
    refresh,
    revertFile,
    deleteFile,
    moveFile,
    renameFile,
    createFolder,
    copyExternalFiles,
    fileActionPending,
    environmentId,
    projectScopeProjectId,
    changeEnvironmentId,
    isLocalEnvironment,
    worktreePath,
  } = useFilesPanel();

  // The project root has no editor panes of its own. Opening a file there
  // moves to the project home — the environment working in the same
  // checkout — and opens the file once its panes are mounted.
  const openInProjectHome = useCallback(
    (filePath: string, options?: CreateFileTabOptions) => {
      if (!projectScopeProjectId) return;
      void ensureProjectHomeInStore(projectScopeProjectId)
        .then((home) => {
          useFilesPanelStore
            .getState()
            .requestFileOpen({ environmentId: home.id, filePath, options });
          const ui = useUIStore.getState();
          ui.selectProjectAndEnvironment(projectScopeProjectId, home.id);
          ui.setProjectBoardTab("home");
        })
        .catch((error: unknown) => {
          toast.error("Could not open the project home", {
            description: errorText(error),
          });
        });
    },
    [projectScopeProjectId],
  );
  const onOpenFile = projectScopeProjectId ? openInProjectHome : undefined;

  // Freshness of the announced revisions the lists refresh from, and of a
  // container's remote-tracking baseline.
  const snapshotSyncStatus = useWorktreeSnapshotStore((state) => state.syncStatus);
  const remoteFreshness = useWorktreeSnapshotStore((state) =>
    changeEnvironmentId ? state.entries.get(changeEnvironmentId)?.remote : undefined,
  );
  const comparisonRef = useWorktreeSnapshotStore((state) =>
    changeEnvironmentId ? state.entries.get(changeEnvironmentId)?.comparisonRef : undefined,
  );
  const syncNotice = hydrationFreshnessNotice(snapshotSyncStatus, "the file lists", {
    polled: true,
  });
  const remoteNotice =
    activeTab === "changes" && comparisonRef
      ? remoteFreshnessNotice(remoteFreshness, comparisonRef)
      : null;

  const moveFileInTree = useCallback(
    (sourcePaths: string[], destinationDirectory: string) => {
      void moveFile(sourcePaths, destinationDirectory).catch(() => undefined);
    },
    [moveFile],
  );

  const copyFilesIntoTree = useCallback(
    (files: File[], destinationDirectory: string) => {
      void copyExternalFiles(files, destinationDirectory).catch(() => undefined);
    },
    [copyExternalFiles],
  );

  // A pending action belongs to the environment it was requested in.
  const [actionEnvironmentId, setActionEnvironmentId] = useState(environmentId);
  if (environmentId !== actionEnvironmentId) {
    setActionEnvironmentId(environmentId);
    setPendingAction(null);
  }

  const requestFileAction = (kind: PendingFileAction["kind"], path: string | string[]) => {
    const paths = Array.isArray(path) ? path : [path];
    if (!environmentId || paths.length === 0) return;
    setPendingAction({ environmentId, kind, paths });
  };

  const revealFile = useCallback(
    (filePath: string) => {
      if (!isLocalEnvironment || !worktreePath) return;
      void revealInFileManager(resolveLocalFilePath(worktreePath, filePath)).catch((error) => {
        toast.error("Failed to reveal file", {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    },
    [isLocalEnvironment, worktreePath],
  );

  const confirmFileAction = async () => {
    if (!pendingAction || pendingAction.environmentId !== environmentId) {
      setPendingAction(null);
      return;
    }
    try {
      if (pendingAction.kind === "revert") {
        await revertFile(pendingAction.paths[0]!);
      } else {
        await deleteFile(pendingAction.paths);
      }
      setPendingAction(null);
    } catch (error) {
      // The hook reports the failure. A partial batch narrows the pending
      // action to the paths that still need to run so a retry cannot get stuck
      // re-applying already-processed paths.
      if (error instanceof FileBatchActionError && error.remainingPaths.length > 0) {
        setPendingAction((current) =>
          current ? { ...current, paths: error.remainingPaths } : current,
        );
      }
    }
  };

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <FilesPanelHeader
        onRefresh={refresh}
        changeEnvironmentId={changeEnvironmentId}
        targetId={environmentId}
        onChooseDiffBase={() => setDiffBaseDialogOpen(true)}
      />
      {!isFilesPanelFileTab(activeTab) ? (
        <FilesPanelPullRequests targetId={environmentId} />
      ) : (
        <>
          {syncNotice && <FreshnessIndicator notice={syncNotice} variant="strip" />}
          {remoteNotice && <FreshnessIndicator notice={remoteNotice} variant="strip" />}
          {activeTab === "changes" && (
            <DiffBaseNotice
              environmentId={changeEnvironmentId}
              onChange={() => setDiffBaseDialogOpen(true)}
            />
          )}
          <ScrollArea className="min-h-0 flex-1">
            {activeTab === "changes" ? (
              <ChangesView
                environmentId={changeEnvironmentId}
                onReveal={isLocalEnvironment && worktreePath ? revealFile : undefined}
                onRevert={(path) => requestFileAction("revert", path)}
                onDelete={(path) => requestFileAction("delete", path)}
                onOpenFile={onOpenFile}
              />
            ) : (
              <AllFilesView
                key={JSON.stringify([environmentId, worktreePath])}
                onReveal={isLocalEnvironment && worktreePath ? revealFile : undefined}
                onRevert={(path) => requestFileAction("revert", path)}
                onDelete={(path) => requestFileAction("delete", path)}
                onMove={moveFileInTree}
                onCopyFiles={copyFilesIntoTree}
                onCreateFolder={createFolder}
                onRename={renameFile}
                movePending={fileActionPending !== null}
                onOpenFile={onOpenFile}
              />
            )}
          </ScrollArea>
        </>
      )}
      <DiffBaseDialog
        environmentId={changeEnvironmentId}
        open={diffBaseDialogOpen}
        onOpenChange={setDiffBaseDialogOpen}
      />
      <FileActionDialog
        action={pendingAction}
        targetRef={targetBranch}
        isPending={fileActionPending !== null}
        onCancel={() => setPendingAction(null)}
        onConfirm={confirmFileAction}
      />
    </div>
  );
}

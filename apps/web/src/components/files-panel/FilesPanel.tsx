import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { FilesPanelHeader } from "./FilesPanelHeader";
import { ChangesView } from "./ChangesView";
import { AllFilesView } from "./AllFilesView";
import { FileActionDialog, type PendingFileAction } from "./FileActionDialog";
import { useFilesPanelStore } from "@/stores";
import { useFilesPanel } from "@/hooks";
import { ScrollArea } from "@/components/ui/scroll-area";
import { revealInFileManager } from "@/lib/backend";

function resolveLocalFilePath(worktreePath: string, filePath: string): string {
  const separator = worktreePath.includes("\\") && !worktreePath.includes("/") ? "\\" : "/";
  return `${worktreePath.replace(/[\\/]+$/, "")}${separator}${filePath.replace(/^[\\/]+/, "")}`;
}

export function FilesPanel() {
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const targetBranch = useFilesPanelStore((state) => state.targetBranch);
  const [pendingAction, setPendingAction] = useState<PendingFileAction | null>(null);

  // Initialize the files panel data loading
  const {
    refresh,
    revertFile,
    deleteFile,
    fileActionPending,
    environmentId,
    isLocalEnvironment,
    worktreePath,
  } = useFilesPanel();

  useEffect(() => {
    setPendingAction(null);
  }, [environmentId]);

  const requestFileAction = (kind: PendingFileAction["kind"], path: string) => {
    if (!environmentId) return;
    setPendingAction({ environmentId, kind, path });
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
        await revertFile(pendingAction.path);
      } else {
        await deleteFile(pendingAction.path);
      }
      setPendingAction(null);
    } catch {
      // The hook reports the failure and leaves the dialog open for retry or cancellation.
    }
  };

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <FilesPanelHeader onRefresh={refresh} />
      <ScrollArea className="min-h-0 flex-1">
        {activeTab === "changes" ? (
          <ChangesView
            onReveal={isLocalEnvironment && worktreePath ? revealFile : undefined}
            onRevert={(path) => requestFileAction("revert", path)}
            onDelete={(path) => requestFileAction("delete", path)}
          />
        ) : (
          <AllFilesView
            onReveal={isLocalEnvironment && worktreePath ? revealFile : undefined}
            onRevert={(path) => requestFileAction("revert", path)}
            onDelete={(path) => requestFileAction("delete", path)}
          />
        )}
      </ScrollArea>
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

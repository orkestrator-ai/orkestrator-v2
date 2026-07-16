import { useState } from "react";
import { FilesPanelHeader } from "./FilesPanelHeader";
import { ChangesView } from "./ChangesView";
import { AllFilesView } from "./AllFilesView";
import { FileActionDialog, type PendingFileAction } from "./FileActionDialog";
import { useFilesPanelStore } from "@/stores";
import { useFilesPanel } from "@/hooks";
import { ScrollArea } from "@/components/ui/scroll-area";


export function FilesPanel() {
  const { activeTab, targetBranch } = useFilesPanelStore();
  const [pendingAction, setPendingAction] = useState<PendingFileAction | null>(null);

  // Initialize the files panel data loading
  const { refresh, revertFile, deleteFile, fileActionPending } = useFilesPanel();

  const confirmFileAction = async () => {
    if (!pendingAction) return;
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
            onRevert={(path) => setPendingAction({ kind: "revert", path })}
            onDelete={(path) => setPendingAction({ kind: "delete", path })}
          />
        ) : (
          <AllFilesView
            onRevert={(path) => setPendingAction({ kind: "revert", path })}
            onDelete={(path) => setPendingAction({ kind: "delete", path })}
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

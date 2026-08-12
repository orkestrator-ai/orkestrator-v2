import { useMemo } from "react";
import { useFilesPanelStore } from "@/stores";
import { useTerminalContext } from "@/contexts";
import { FileTreeNode } from "./FileTreeNode";
import { Loader2, FolderTree } from "lucide-react";
import { useMediaQuery } from "@/hooks";

interface AllFilesViewProps {
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
}

export function AllFilesView({ onReveal, onRevert, onDelete }: AllFilesViewProps = {}) {
  const fileTree = useFilesPanelStore((state) => state.fileTree);
  const changes = useFilesPanelStore((state) => state.changes);
  const isLoadingTree = useFilesPanelStore((state) => state.isLoadingTree);
  const closePanel = useFilesPanelStore((state) => state.closePanel);
  const { createFileTab } = useTerminalContext();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const changedPaths = useMemo(
    () => new Set(changes.map((change) => change.path)),
    [changes],
  );

  const handleFileClick = (path: string) => {
    if (!createFileTab) return;
    createFileTab(path);
    if (isMobile) closePanel();
  };

  if (isLoadingTree) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="mb-2 h-6 w-6 animate-spin" />
        <p className="text-sm">Loading files...</p>
      </div>
    );
  }

  if (fileTree.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <FolderTree className="mb-2 h-8 w-8 opacity-50" />
        <p className="text-sm">No files found</p>
      </div>
    );
  }

  return (
    <div className="p-2">
      {fileTree.map((node) => (
        <FileTreeNode
          key={node.path}
          item={node}
          depth={0}
          onFileClick={handleFileClick}
          onReveal={onReveal}
          changedPaths={changedPaths}
          onRevert={onRevert}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

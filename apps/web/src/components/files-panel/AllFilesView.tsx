import { useFilesPanelStore } from "@/stores";
import { useTerminalContext } from "@/contexts";
import { FileTreeNode } from "./FileTreeNode";
import { Loader2, FolderTree } from "lucide-react";

export function AllFilesView() {
  const { fileTree, isLoadingTree } = useFilesPanelStore();
  const { createFileTab } = useTerminalContext();

  const handleFileClick = (path: string) => {
    createFileTab?.(path);
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
        />
      ))}
    </div>
  );
}

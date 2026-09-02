import { useMemo, useState, type DragEvent } from "react";
import { useFilesPanelStore } from "@/stores";
import { useTerminalContext } from "@/contexts";
import {
  FILE_DRAG_TYPE,
  FileTreeNode,
  isWorkspaceFileDrag,
  workspaceParentDirectory,
} from "./FileTreeNode";
import { Loader2, Folder, FolderTree } from "lucide-react";
import { useMediaQuery } from "@/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FileNode } from "@/lib/backend";
import { cn } from "@/lib/utils";

function collectDirectories(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) =>
    node.isDirectory ? [node, ...collectDirectories(node.children ?? [])] : [],
  );
}

interface AllFilesViewProps {
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
  onMove?: (sourcePath: string, destinationDirectory: string) => void;
  movePending?: boolean;
}

export function AllFilesView({
  onReveal,
  onRevert,
  onDelete,
  onMove,
  movePending = false,
}: AllFilesViewProps = {}) {
  const fileTree = useFilesPanelStore((state) => state.fileTree);
  const changes = useFilesPanelStore((state) => state.changes);
  const isLoadingTree = useFilesPanelStore((state) => state.isLoadingTree);
  const closePanel = useFilesPanelStore((state) => state.closePanel);
  const { createFileTab } = useTerminalContext();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [moveSourcePath, setMoveSourcePath] = useState<string | null>(null);
  const [isRootDragOver, setIsRootDragOver] = useState(false);
  const changedPaths = useMemo(() => new Set(changes.map((change) => change.path)), [changes]);
  const directories = useMemo(() => collectDirectories(fileTree), [fileTree]);

  const handleFileClick = (path: string) => {
    if (!createFileTab) return;
    createFileTab(path);
    if (isMobile) closePanel();
  };

  const moveTo = (destinationDirectory: string) => {
    const sourcePath = moveSourcePath;
    setMoveSourcePath(null);
    if (!sourcePath || !onMove || workspaceParentDirectory(sourcePath) === destinationDirectory) {
      return;
    }
    onMove(sourcePath, destinationDirectory);
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsRootDragOver(false);
    if (!onMove || movePending) return;
    const sourcePath = event.dataTransfer.getData(FILE_DRAG_TYPE);
    if (!sourcePath || workspaceParentDirectory(sourcePath) === ".") return;
    event.preventDefault();
    onMove(sourcePath, ".");
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
    <>
      <div className="p-2">
        {onMove && (
          <div
            aria-label="Workspace root drop target"
            onDragEnter={(event) => {
              if (movePending || !isWorkspaceFileDrag(event)) return;
              event.preventDefault();
              setIsRootDragOver(true);
            }}
            onDragOver={(event) => {
              if (movePending || !isWorkspaceFileDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setIsRootDragOver(true);
            }}
            onDragLeave={() => setIsRootDragOver(false)}
            onDrop={handleRootDrop}
            className={cn(
              "mb-1 flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs text-muted-foreground",
              isRootDragOver && "bg-primary/15 ring-1 ring-inset ring-primary/60",
            )}
          >
            <Folder className="h-3.5 w-3.5" />
            Workspace root
          </div>
        )}
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
            onMove={onMove}
            onRequestMove={onMove ? setMoveSourcePath : undefined}
            movePending={movePending}
          />
        ))}
      </div>
      <Dialog
        open={moveSourcePath !== null}
        onOpenChange={(open) => !open && setMoveSourcePath(null)}
      >
        <DialogContent className="max-h-[min(32rem,calc(100vh-2rem))] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Move file</DialogTitle>
            <DialogDescription>
              Choose a destination for {moveSourcePath?.split("/").at(-1)}.
            </DialogDescription>
          </DialogHeader>
          <div
            className="max-h-80 space-y-1 overflow-y-auto"
            role="listbox"
            aria-label="Destination folder"
          >
            <button
              type="button"
              role="option"
              aria-selected="false"
              disabled={moveSourcePath ? workspaceParentDirectory(moveSourcePath) === "." : true}
              onClick={() => moveTo(".")}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40"
            >
              <Folder className="h-4 w-4" />
              Workspace root
            </button>
            {directories.map((directory) => (
              <button
                key={directory.path}
                type="button"
                role="option"
                aria-selected="false"
                disabled={
                  moveSourcePath
                    ? workspaceParentDirectory(moveSourcePath) === directory.path
                    : true
                }
                onClick={() => moveTo(directory.path)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40"
              >
                <Folder className="h-4 w-4" />
                {directory.path}
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

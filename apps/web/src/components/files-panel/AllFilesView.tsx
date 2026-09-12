import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from "react";
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
import { BoundedPathList } from "./BoundedPathList";
import {
  collectAllFilePaths,
  collectVisibleFilePaths,
  decodeWorkspaceFileDrag,
  resolveFileSelection,
} from "./file-selection";

function collectDirectories(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) =>
    node.isDirectory ? [node, ...collectDirectories(node.children ?? [])] : [],
  );
}

interface AllFilesViewProps {
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (paths: string[]) => void;
  onMove?: (sourcePaths: string[], destinationDirectory: string) => void;
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
  const expandedFolders = useFilesPanelStore((state) => state.expandedFolders);
  const closePanel = useFilesPanelStore((state) => state.closePanel);
  const { createFileTab } = useTerminalContext();
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [moveSourcePaths, setMoveSourcePaths] = useState<string[] | null>(null);
  const [isRootDragOver, setIsRootDragOver] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const changedPaths = useMemo(() => new Set(changes.map((change) => change.path)), [changes]);
  const directories = useMemo(() => collectDirectories(fileTree), [fileTree]);
  const visibleFilePaths = useMemo(
    () => collectVisibleFilePaths(fileTree, expandedFolders),
    [fileTree, expandedFolders],
  );
  const selectedPathSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  useEffect(() => {
    const existing = new Set(collectAllFilePaths(fileTree));
    setSelectedPaths((current) => {
      const next = current.filter((path) => existing.has(path));
      return next.length === current.length ? current : next;
    });
    setAnchorPath((current) => (current && existing.has(current) ? current : null));
  }, [fileTree]);

  const handleFileClick = (path: string, event: MouseEvent<HTMLButtonElement>) => {
    const result = resolveFileSelection(
      path,
      {
        shiftKey: event.shiftKey,
        metaKey: event.metaKey || event.ctrlKey,
      },
      visibleFilePaths,
      anchorPath,
      selectedPaths,
    );

    if (result.type === "range") {
      event.preventDefault();
      setSelectedPaths(result.paths);
      if (!anchorPath) setAnchorPath(path);
      return;
    }

    if (result.type === "add") {
      event.preventDefault();
      setSelectedPaths((current) => (current.includes(path) ? current : [...current, path]));
      if (!anchorPath) setAnchorPath(path);
      return;
    }

    if (result.type === "remove") {
      event.preventDefault();
      setSelectedPaths((current) => current.filter((selected) => selected !== path));
      setAnchorPath((current) => (current === path ? null : current));
      return;
    }

    setSelectedPaths([path]);
    setAnchorPath(path);
    if (!createFileTab) return;
    createFileTab(path);
    if (isMobile) closePanel();
  };

  const handleContextSelect = (path: string) => {
    if (selectedPathSet.has(path)) return;
    setSelectedPaths([path]);
    setAnchorPath(path);
  };

  const moveTo = (destinationDirectory: string) => {
    const sourcePaths = (moveSourcePaths ?? []).filter(
      (sourcePath) => workspaceParentDirectory(sourcePath) !== destinationDirectory,
    );
    setMoveSourcePaths(null);
    if (sourcePaths.length === 0 || !onMove) {
      return;
    }
    onMove(sourcePaths, destinationDirectory);
  };

  const handleRootDrop = (event: DragEvent<HTMLDivElement>) => {
    setIsRootDragOver(false);
    if (!onMove || movePending) return;
    const sourcePaths = decodeWorkspaceFileDrag(event.dataTransfer.getData(FILE_DRAG_TYPE)).filter(
      (sourcePath) => workspaceParentDirectory(sourcePath) !== ".",
    );
    if (sourcePaths.length === 0) return;
    event.preventDefault();
    onMove(sourcePaths, ".");
  };

  const destinationDisabled = (destinationDirectory: string) =>
    !moveSourcePaths?.some(
      (sourcePath) => workspaceParentDirectory(sourcePath) !== destinationDirectory,
    );

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

  const moveCount = moveSourcePaths?.length ?? 0;
  const moveSubject =
    moveCount === 1 ? moveSourcePaths?.[0]?.split("/").at(-1) : `${moveCount} files`;

  return (
    <>
      <div className="select-none p-2">
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
            selectedPaths={selectedPathSet}
            onContextSelect={handleContextSelect}
            onRevert={onRevert}
            onDelete={onDelete}
            onMove={onMove}
            onRequestMove={onMove ? setMoveSourcePaths : undefined}
            movePending={movePending}
          />
        ))}
      </div>
      <Dialog
        open={moveSourcePaths !== null}
        onOpenChange={(open) => !open && setMoveSourcePaths(null)}
      >
        <DialogContent className="max-h-[min(32rem,calc(100vh-2rem))] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{moveCount > 1 ? "Move files" : "Move file"}</DialogTitle>
            <DialogDescription>
              Choose a destination for {moveSubject}.
              {moveCount > 1 && <BoundedPathList paths={moveSourcePaths ?? []} />}
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
              disabled={destinationDisabled(".")}
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
                disabled={destinationDisabled(directory.path)}
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

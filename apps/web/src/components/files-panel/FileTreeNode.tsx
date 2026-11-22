import { memo, useState, type DragEvent, type MouseEvent } from "react";
import {
  ChevronRight,
  Copy,
  FilePlus,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Pencil,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { useFilesPanelStore } from "@/stores";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { FileNode } from "@/lib/backend";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { copyFilePath } from "./copy-file-path";
import {
  isDroppedDirectoryEntry,
  type DroppedDirectoryEntry,
  type ExternalFileDrop,
} from "@/lib/external-file-drop";
import {
  decodeWorkspaceFileDrag,
  encodeWorkspaceFileDrag,
  pathsForFileAction,
} from "./file-selection";

const EMPTY_CHANGED_PATHS: ReadonlySet<string> = new Set();
const EMPTY_SELECTED_PATHS: ReadonlySet<string> = new Set();
export const FILE_DRAG_TYPE = "application/x-orkestrator-workspace-file";
export const EXTERNAL_FILE_DRAG_TYPE = "Files";

export function isWorkspaceFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(FILE_DRAG_TYPE);
}

export function isExternalFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(EXTERNAL_FILE_DRAG_TYPE);
}

/**
 * Split an operating-system drop into loose files and whole folders. Must run
 * inside the drop event: the browser empties the `DataTransfer` afterwards.
 * Folder entries stay readable later, when the copy walks them.
 */
export function externalFilesFromDataTransfer(dataTransfer: DataTransfer): ExternalFileDrop {
  const items = Array.from(dataTransfer.items);
  if (items.length === 0) {
    return { files: Array.from(dataTransfer.files), folders: [] };
  }

  const files: File[] = [];
  const folders: DroppedDirectoryEntry[] = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => unknown }
    ).webkitGetAsEntry?.();
    if (isDroppedDirectoryEntry(entry)) {
      folders.push(entry);
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }

  if (folders.length === 0 && files.length === 0) {
    return { files: Array.from(dataTransfer.files), folders: [] };
  }
  return { files, folders };
}

export function workspaceParentDirectory(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "." : filePath.slice(0, separator);
}

function stopContextMenuPropagation(event: { stopPropagation(): void }): void {
  event.stopPropagation();
}

interface FileTreeNodeProps {
  item: FileNode;
  depth: number;
  onFileClick?: (path: string, event: MouseEvent<HTMLButtonElement>) => void;
  onReveal?: (path: string) => void;
  changedPaths?: ReadonlySet<string>;
  selectedPaths?: ReadonlySet<string>;
  onContextSelect?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (paths: string[]) => void;
  /** Deletes a folder and everything in it. Folders are deleted one at a time. */
  onDeleteFolder?: (path: string) => void;
  onMove?: (sourcePaths: string[], destinationDirectory: string) => void;
  /** Copies files and whole folders dropped from the operating system. */
  onCopyFiles?: (drop: ExternalFileDrop, destinationDirectory: string) => void;
  onRequestMove?: (sourcePaths: string[]) => void;
  /** Asks to rename a file or folder in place; `isFolder` picks the dialog's wording. */
  onRequestRename?: (path: string, isFolder: boolean) => void;
  onCreateFolder?: (parentDirectory: string) => void;
  /** Asks for a new empty file in `parentDirectory`. */
  onCreateFile?: (parentDirectory: string) => void;
  movePending?: boolean;
}

export const FileTreeNode = memo(function FileTreeNode({
  item,
  depth,
  onFileClick,
  onReveal,
  changedPaths = EMPTY_CHANGED_PATHS,
  selectedPaths = EMPTY_SELECTED_PATHS,
  onContextSelect,
  onRevert,
  onDelete,
  onDeleteFolder,
  onMove,
  onCopyFiles,
  onRequestMove,
  onRequestRename,
  onCreateFolder,
  onCreateFile,
  movePending = false,
}: FileTreeNodeProps) {
  const expandedFolders = useFilesPanelStore((state) => state.expandedFolders);
  const setFolderExpanded = useFilesPanelStore((state) => state.setFolderExpanded);
  const isExpanded = expandedFolders.includes(item.path);
  const isLoadingContents = useFilesPanelStore((state) => state.loadingFolders.includes(item.path));
  const failedContents = useFilesPanelStore((state) => state.failedFolders.includes(item.path));
  const retryFolderLoad = useFilesPanelStore((state) => state.retryFolderLoad);
  const isFolder = item.isDirectory;
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const isSelected = selectedPaths.has(item.path);
  const actionPaths = pathsForFileAction(item.path, selectedPaths);

  const paddingLeft = depth * 12 + 8; // Indentation based on depth

  if (isFolder) {
    const folderRow = (
      <CollapsibleTrigger asChild>
        <button
          onDragEnter={(event) => {
            if (
              movePending ||
              ((!onMove || !isWorkspaceFileDrag(event)) &&
                (!onCopyFiles || !isExternalFileDrag(event)))
            ) {
              return;
            }
            event.preventDefault();
            setIsDragOver(true);
          }}
          onDragOver={(event) => {
            const workspaceDrag = Boolean(onMove) && isWorkspaceFileDrag(event);
            const externalDrag = Boolean(onCopyFiles) && isExternalFileDrag(event);
            if (movePending || (!workspaceDrag && !externalDrag)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = externalDrag ? "copy" : "move";
            setIsDragOver(true);
          }}
          onDragLeave={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            ) {
              return;
            }
            setIsDragOver(false);
          }}
          onDrop={(event) => {
            setIsDragOver(false);
            if (movePending) return;
            if (onMove && isWorkspaceFileDrag(event)) {
              const sourcePaths = decodeWorkspaceFileDrag(
                event.dataTransfer.getData(FILE_DRAG_TYPE),
              ).filter((sourcePath) => workspaceParentDirectory(sourcePath) !== item.path);
              if (sourcePaths.length === 0) return;
              event.preventDefault();
              setFolderExpanded(item.path, true);
              onMove(sourcePaths, item.path);
              return;
            }
            if (onCopyFiles && isExternalFileDrag(event)) {
              const drop = externalFilesFromDataTransfer(event.dataTransfer);
              if (drop.files.length === 0 && drop.folders.length === 0) return;
              event.preventDefault();
              setFolderExpanded(item.path, true);
              onCopyFiles(drop, item.path);
            }
          }}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors",
            isDragOver ? "bg-primary/15 ring-1 ring-inset ring-primary/60" : "hover:bg-hover",
          )}
          style={{ paddingLeft }}
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
              isExpanded && "rotate-90",
            )}
          />
          {isExpanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{item.name}</span>
        </button>
      </CollapsibleTrigger>
    );

    return (
      <Collapsible open={isExpanded} onOpenChange={(open) => setFolderExpanded(item.path, open)}>
        {onCreateFile || onCreateFolder || onDeleteFolder || onRequestRename ? (
          <ContextMenu>
            <ContextMenuTrigger
              asChild
              onPointerDown={stopContextMenuPropagation}
              onContextMenu={stopContextMenuPropagation}
            >
              <div>{folderRow}</div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              {onCreateFile && (
                <ContextMenuItem disabled={movePending} onSelect={() => onCreateFile(item.path)}>
                  <FilePlus />
                  New file
                </ContextMenuItem>
              )}
              {onCreateFolder && (
                <ContextMenuItem disabled={movePending} onSelect={() => onCreateFolder(item.path)}>
                  <FolderPlus />
                  New folder
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={() => void copyFilePath(item.path)}>
                <Copy />
                Copy path
              </ContextMenuItem>
              {onRequestRename && (
                <ContextMenuItem
                  disabled={movePending}
                  onSelect={() => onRequestRename(item.path, true)}
                >
                  <Pencil />
                  Rename…
                </ContextMenuItem>
              )}
              {onDeleteFolder && (
                <ContextMenuItem
                  variant="destructive"
                  disabled={movePending}
                  onSelect={() => onDeleteFolder(item.path)}
                >
                  <Trash2 />
                  Delete folder
                </ContextMenuItem>
              )}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          folderRow
        )}
        <CollapsibleContent>
          {(item.truncated || isLoadingContents || failedContents) && (
            <p
              className="py-1 pr-2 text-xs text-muted-foreground"
              style={{ paddingLeft: paddingLeft + 12 }}
            >
              {isLoadingContents ? (
                "Loading folder…"
              ) : failedContents ? (
                <>
                  <span role="status">Could not load folder.</span>{" "}
                  <button
                    type="button"
                    aria-label={`Retry loading ${item.path}`}
                    className="rounded text-foreground underline underline-offset-2 hover:text-primary focus-hairline focus-hairline-outset"
                    onClick={() => retryFolderLoad(item.path)}
                  >
                    Retry
                  </button>
                </>
              ) : (
                "Some folder contents are not shown."
              )}
            </p>
          )}
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onReveal={onReveal}
              changedPaths={changedPaths}
              selectedPaths={selectedPaths}
              onContextSelect={onContextSelect}
              onRevert={onRevert}
              onDelete={onDelete}
              onDeleteFolder={onDeleteFolder}
              onMove={onMove}
              onCopyFiles={onCopyFiles}
              onRequestMove={onRequestMove}
              onRequestRename={onRequestRename}
              onCreateFolder={onCreateFolder}
              onCreateFile={onCreateFile}
              movePending={movePending}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  const deleteLabel = actionPaths.length > 1 ? `Delete ${actionPaths.length} files` : "Delete file";
  const moveLabel =
    actionPaths.length > 1
      ? `Move ${actionPaths.length} files to another folder`
      : `Move ${item.name} to another folder`;

  // File node
  const fileRow = (
    <div className="group flex min-w-0 items-center">
      <button
        aria-pressed={isSelected}
        onClick={(event) => onFileClick?.(item.path, event)}
        onMouseDown={(event) => {
          if (event.shiftKey) event.preventDefault();
        }}
        onContextMenu={() => onContextSelect?.(item.path)}
        draggable={Boolean(onMove) && !movePending}
        onDragStart={(event) => {
          if (!onMove || movePending) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(FILE_DRAG_TYPE, encodeWorkspaceFileDrag(actionPaths));
          setIsDragging(true);
        }}
        onDragEnd={() => setIsDragging(false)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors",
          onMove && !movePending && "cursor-grab active:cursor-grabbing",
          isSelected ? "bg-accent" : "hover:bg-hover",
          isDragging && "opacity-50",
        )}
        style={{ paddingLeft: paddingLeft + 14 }} // Extra indent for files (no chevron)
      >
        <FileIcon filename={item.name} className="h-4 w-4 shrink-0" />
        <span className="truncate">{item.name}</span>
      </button>
      {onRequestMove && (
        <button
          type="button"
          aria-label={moveLabel}
          title="Move to…"
          disabled={movePending}
          onClick={() => onRequestMove(actionPaths)}
          className="mr-1 rounded p-1 text-muted-foreground opacity-70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        asChild
        onPointerDown={stopContextMenuPropagation}
        onContextMenu={stopContextMenuPropagation}
      >
        {fileRow}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onCreateFile && (
          <ContextMenuItem
            disabled={movePending}
            onSelect={() => onCreateFile(workspaceParentDirectory(item.path))}
          >
            <FilePlus />
            New file
          </ContextMenuItem>
        )}
        {onCreateFolder && (
          <ContextMenuItem
            disabled={movePending}
            onSelect={() => onCreateFolder(workspaceParentDirectory(item.path))}
          >
            <FolderPlus />
            New folder
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => void copyFilePath(item.path)}>
          <Copy />
          Copy path
        </ContextMenuItem>
        {onRequestRename && (
          <ContextMenuItem
            disabled={movePending}
            onSelect={() => onRequestRename(item.path, false)}
          >
            <Pencil />
            Rename…
          </ContextMenuItem>
        )}
        {onRequestMove && (
          <ContextMenuItem disabled={movePending} onSelect={() => onRequestMove(actionPaths)}>
            <FolderInput />
            Move to…
          </ContextMenuItem>
        )}
        {onReveal && (
          <ContextMenuItem onSelect={() => onReveal(item.path)}>
            <FolderOpen />
            Reveal in file manager
          </ContextMenuItem>
        )}
        {onRevert && changedPaths.has(item.path) && (
          <ContextMenuItem onSelect={() => onRevert(item.path)}>
            <RotateCcw />
            Revert
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(actionPaths)}>
            <Trash2 />
            {deleteLabel}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

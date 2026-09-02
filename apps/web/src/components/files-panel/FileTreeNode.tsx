import { memo, useState, type DragEvent } from "react";
import { ChevronRight, Folder, FolderInput, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
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

const EMPTY_CHANGED_PATHS: ReadonlySet<string> = new Set();
export const FILE_DRAG_TYPE = "application/x-orkestrator-workspace-file";

export function isWorkspaceFileDrag(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes(FILE_DRAG_TYPE);
}

export function workspaceParentDirectory(filePath: string): string {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "." : filePath.slice(0, separator);
}

interface FileTreeNodeProps {
  item: FileNode;
  depth: number;
  onFileClick?: (path: string) => void;
  onReveal?: (path: string) => void;
  changedPaths?: ReadonlySet<string>;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
  onMove?: (sourcePath: string, destinationDirectory: string) => void;
  onRequestMove?: (sourcePath: string) => void;
  movePending?: boolean;
}

export const FileTreeNode = memo(function FileTreeNode({
  item,
  depth,
  onFileClick,
  onReveal,
  changedPaths = EMPTY_CHANGED_PATHS,
  onRevert,
  onDelete,
  onMove,
  onRequestMove,
  movePending = false,
}: FileTreeNodeProps) {
  const expandedFolders = useFilesPanelStore((state) => state.expandedFolders);
  const setFolderExpanded = useFilesPanelStore((state) => state.setFolderExpanded);
  const isExpanded = expandedFolders.includes(item.path);
  const isFolder = item.isDirectory;
  const [isDragOver, setIsDragOver] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const paddingLeft = depth * 12 + 8; // Indentation based on depth

  if (isFolder) {
    return (
      <Collapsible open={isExpanded} onOpenChange={(open) => setFolderExpanded(item.path, open)}>
        <CollapsibleTrigger asChild>
          <button
            onDragEnter={(event) => {
              if (!onMove || movePending || !isWorkspaceFileDrag(event)) return;
              event.preventDefault();
              setIsDragOver(true);
            }}
            onDragOver={(event) => {
              if (!onMove || movePending || !isWorkspaceFileDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
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
              if (!onMove || movePending) return;
              const sourcePath = event.dataTransfer.getData(FILE_DRAG_TYPE);
              if (!sourcePath || workspaceParentDirectory(sourcePath) === item.path) return;
              event.preventDefault();
              setFolderExpanded(item.path, true);
              onMove(sourcePath, item.path);
            }}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors hover:bg-accent/50",
              isDragOver && "bg-primary/15 ring-1 ring-inset ring-primary/60",
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
        <CollapsibleContent>
          {item.children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              onReveal={onReveal}
              changedPaths={changedPaths}
              onRevert={onRevert}
              onDelete={onDelete}
              onMove={onMove}
              onRequestMove={onRequestMove}
              movePending={movePending}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // File node
  const fileRow = (
    <div className="group flex min-w-0 items-center">
      <button
        onClick={() => onFileClick?.(item.path)}
        draggable={Boolean(onMove) && !movePending}
        onDragStart={(event) => {
          if (!onMove || movePending) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(FILE_DRAG_TYPE, item.path);
          setIsDragging(true);
        }}
        onDragEnd={() => setIsDragging(false)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors hover:bg-accent/50",
          onMove && !movePending && "cursor-grab active:cursor-grabbing",
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
          aria-label={`Move ${item.name} to another folder`}
          title="Move to…"
          disabled={movePending}
          onClick={() => onRequestMove(item.path)}
          className="mr-1 rounded p-1 text-muted-foreground opacity-70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );

  if (!onReveal && !onDelete && !onRequestMove && !(onRevert && changedPaths.has(item.path))) {
    return fileRow;
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{fileRow}</ContextMenuTrigger>
      <ContextMenuContent>
        {onRequestMove && (
          <ContextMenuItem disabled={movePending} onSelect={() => onRequestMove(item.path)}>
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
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(item.path)}>
            <Trash2 />
            Delete file
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

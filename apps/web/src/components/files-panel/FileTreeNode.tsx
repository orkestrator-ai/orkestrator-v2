import { memo } from "react";
import { ChevronRight, Folder, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { useFilesPanelStore } from "@/stores";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { FileNode } from "@/lib/backend";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const EMPTY_CHANGED_PATHS: ReadonlySet<string> = new Set();

interface FileTreeNodeProps {
  item: FileNode;
  depth: number;
  onFileClick?: (path: string) => void;
  changedPaths?: ReadonlySet<string>;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
}

export const FileTreeNode = memo(function FileTreeNode({
  item,
  depth,
  onFileClick,
  changedPaths = EMPTY_CHANGED_PATHS,
  onRevert,
  onDelete,
}: FileTreeNodeProps) {
  const { expandedFolders, setFolderExpanded } = useFilesPanelStore();
  const isExpanded = expandedFolders.includes(item.path);
  const isFolder = item.isDirectory;

  const paddingLeft = depth * 12 + 8; // Indentation based on depth

  if (isFolder) {
    return (
      <Collapsible
        open={isExpanded}
        onOpenChange={(open) => setFolderExpanded(item.path, open)}
      >
        <CollapsibleTrigger asChild>
          <button
            className={cn(
              "flex w-full items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors hover:bg-accent/50"
            )}
            style={{ paddingLeft }}
          >
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                isExpanded && "rotate-90"
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
              changedPaths={changedPaths}
              onRevert={onRevert}
              onDelete={onDelete}
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // File node
  const fileButton = (
    <button
      onClick={() => onFileClick?.(item.path)}
      className={cn(
        "flex w-full items-center gap-1.5 rounded-sm py-1 text-sm text-foreground transition-colors hover:bg-accent/50"
      )}
      style={{ paddingLeft: paddingLeft + 14 }} // Extra indent for files (no chevron)
    >
      <FileIcon filename={item.name} className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.name}</span>
    </button>
  );

  if (!onDelete && !(onRevert && changedPaths.has(item.path))) return fileButton;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{fileButton}</ContextMenuTrigger>
      <ContextMenuContent>
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

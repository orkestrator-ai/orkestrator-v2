import { memo } from "react";
import { ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileIcon } from "./FileIcon";
import { useFilesPanelStore } from "@/stores";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { FileNode } from "@/lib/backend";

interface FileTreeNodeProps {
  item: FileNode;
  depth: number;
  onFileClick?: (path: string) => void;
}

export const FileTreeNode = memo(function FileTreeNode({
  item,
  depth,
  onFileClick,
}: FileTreeNodeProps) {
  const { collapsedFolders, toggleFolderCollapse } = useFilesPanelStore();
  const isCollapsed = collapsedFolders.includes(item.path);
  const isFolder = item.isDirectory;

  const paddingLeft = depth * 12 + 8; // Indentation based on depth

  if (isFolder) {
    return (
      <Collapsible
        open={!isCollapsed}
        onOpenChange={() => toggleFolderCollapse(item.path)}
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
                !isCollapsed && "rotate-90"
              )}
            />
            {isCollapsed ? (
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            ) : (
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
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
            />
          ))}
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // File node
  return (
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
});

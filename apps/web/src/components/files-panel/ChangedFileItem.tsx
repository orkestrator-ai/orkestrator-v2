import { cn } from "@/lib/utils";
import { TruncatedPath } from "@/components/ui/truncated-path";
import { FileIcon } from "./FileIcon";
import type { GitFileChange } from "@/lib/backend";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { FolderOpen, RotateCcw, Trash2 } from "lucide-react";

interface ChangedFileItemProps {
  change: GitFileChange;
  onClick?: (path: string) => void;
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
}

export function ChangedFileItem({ change, onClick, onReveal, onRevert, onDelete }: ChangedFileItemProps) {
  const reveal = change.status.startsWith("D") ? undefined : onReveal;
  const item = (
    <button
      onClick={() => onClick?.(change.path)}
      title={change.path}
      className={cn(
        "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        "hover:bg-accent/50"
      )}
    >
      <FileIcon filename={change.filename} className="h-4 w-4 shrink-0" />

      <TruncatedPath
        className="items-baseline text-left text-xs"
        directory={change.directory}
        filename={change.filename}
        directoryClassName="text-muted-foreground"
        filenameClassName="text-foreground"
      />

      <div className="ml-2 flex shrink-0 items-center justify-end gap-1.5 font-mono text-xs tabular-nums">
        {change.additions > 0 && (
          <span className="text-green-500">+{change.additions}</span>
        )}
        {change.deletions > 0 && (
          <span className="text-red-400">-{change.deletions}</span>
        )}
      </div>
    </button>
  );

  if (!reveal && !onRevert && !onDelete) return item;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
      <ContextMenuContent>
        {reveal && (
          <ContextMenuItem onSelect={() => reveal(change.path)}>
            <FolderOpen />
            Reveal in file manager
          </ContextMenuItem>
        )}
        {onRevert && (
          <ContextMenuItem onSelect={() => onRevert(change.path)}>
            <RotateCcw />
            Revert
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(change.path)}>
            <Trash2 />
            Delete file
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

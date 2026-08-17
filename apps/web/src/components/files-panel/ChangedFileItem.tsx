import { cn } from "@/lib/utils";
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

      <div className="flex min-w-0 items-baseline overflow-hidden text-left text-xs">
        {/* The RTL direction truncates the directory from its start, which is the
            uninteresting end of a path. The text itself has to stay in an LTR bidi
            isolate, or a leading neutral character — the dot of ".github" — is
            reordered to the visual end and renders as "github." instead. */}
        {change.directory && (
          <span className="min-w-0 shrink truncate text-left text-muted-foreground [direction:rtl]">
            <bdi dir="ltr">{change.directory}</bdi>
          </span>
        )}
        <span className="max-w-full min-w-0 shrink-0 truncate text-foreground">
          {change.directory && "/"}
          {change.filename}
        </span>
      </div>

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

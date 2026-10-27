import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeFileRow, ChangeFileStatus } from "@orkestrator/protocol/change-resources";
import { Copy, FolderOpen, RotateCcw, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TruncatedPath } from "@/components/ui/truncated-path";
import { changeReason, formatLineCount } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";
import { copyFilePath } from "./copy-file-path";
import { FileIcon } from "./FileIcon";

const STATUS_LETTERS: Record<ChangeFileStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  "mode-changed": "T",
  "type-changed": "T",
  unknown: "?",
};

const STATUS_CLASSES: Record<ChangeFileStatus, string> = {
  added: "text-success",
  modified: "text-amber-400",
  deleted: "text-failure",
  renamed: "text-sky-400",
  copied: "text-sky-400",
  "mode-changed": "text-muted-foreground",
  "type-changed": "text-muted-foreground",
  unknown: "text-muted-foreground",
};

/** Git-style status letter, for consumers that still key on one. */
export function changeRowStatusLetter(status: ChangeFileStatus): string {
  return STATUS_LETTERS[status];
}

/** The worktree path a row's actions (open, revert, delete) apply to. */
export function changeRowPath(row: ChangeFileRow): string {
  return row.newPathDisplay ?? row.oldPathDisplay ?? row.pathId;
}

function splitPath(path: string): { directory: string; filename: string } {
  const index = path.lastIndexOf("/");
  return index < 0
    ? { directory: "", filename: path }
    : { directory: path.slice(0, index), filename: path.slice(index + 1) };
}

/** A complete zero is a recorded outcome; the row leaves it implicit, as before. */
function isExactZero(count: LineCount): boolean {
  return count.value === 0 && count.quality === "complete";
}

interface ChangeFileRowItemProps {
  row: ChangeFileRow;
  onClick?: (row: ChangeFileRow) => void;
  onReveal?: (path: string) => void;
  onRevert?: (path: string) => void;
  onDelete?: (path: string) => void;
}

/**
 * One row of a backend change projection. Status, rename pair, counts (with
 * their quality: unknown shows `?`, binary shows no counts) and reason text are
 * rendered exactly as the backend measured them.
 */
export function ChangeFileRowItem({
  row,
  onClick,
  onReveal,
  onRevert,
  onDelete,
}: ChangeFileRowItemProps) {
  const path = changeRowPath(row);
  const renamedFrom =
    (row.status === "renamed" || row.status === "copied") &&
    row.oldPathDisplay &&
    row.newPathDisplay &&
    row.oldPathDisplay !== row.newPathDisplay
      ? row.oldPathDisplay
      : null;
  const { directory, filename } = splitPath(path);
  const binary = row.fileKind === "binary";
  const plus = binary || isExactZero(row.additions) ? "" : formatLineCount("+", row.additions);
  const minus = binary || isExactZero(row.deletions) ? "" : formatLineCount("-", row.deletions);
  const reason = row.reasonKey ? changeReason(row.reasonKey) : null;
  const reveal = row.status === "deleted" ? undefined : onReveal;
  const title = [renamedFrom ? `${renamedFrom} → ${path}` : path, reason]
    .filter(Boolean)
    .join("\n");

  const item = (
    <button
      type="button"
      onClick={() => onClick?.(row)}
      title={title}
      data-testid="change-file-row"
      data-row-id={row.rowId}
      className={cn(
        "grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
        "hover:bg-accent/50",
      )}
    >
      <span
        className={cn("w-3 shrink-0 text-center font-mono text-[10px]", STATUS_CLASSES[row.status])}
        aria-label={row.status}
        title={row.status}
      >
        {STATUS_LETTERS[row.status]}
      </span>
      <FileIcon filename={filename} className="h-4 w-4 shrink-0" />
      <span className="flex min-w-0 flex-col text-left">
        <TruncatedPath
          className="items-baseline text-left text-xs"
          directory={directory}
          filename={filename}
          directoryClassName="text-muted-foreground"
          filenameClassName="text-foreground"
        />
        {renamedFrom && (
          <span
            className="truncate text-[10px] text-muted-foreground"
            data-testid="change-row-renamed-from"
          >
            from {renamedFrom}
          </span>
        )}
        {reason && (
          <span
            className="truncate text-[10px] text-muted-foreground"
            data-testid="change-row-reason"
          >
            {reason}
          </span>
        )}
      </span>
      <span
        className="ml-2 flex shrink-0 items-center justify-end gap-1.5 font-mono text-xs tabular-nums"
        data-testid="change-row-counts"
      >
        {binary ? (
          <span className="text-muted-foreground">binary</span>
        ) : (
          <>
            {plus && <span className="text-success">{plus}</span>}
            {minus && <span className="text-failure">{minus}</span>}
          </>
        )}
      </span>
    </button>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void copyFilePath(path)}>
          <Copy />
          Copy path
        </ContextMenuItem>
        {reveal && (
          <ContextMenuItem onSelect={() => reveal(path)}>
            <FolderOpen />
            Reveal in file manager
          </ContextMenuItem>
        )}
        {onRevert && (
          <ContextMenuItem onSelect={() => onRevert(path)}>
            <RotateCcw />
            Revert
          </ContextMenuItem>
        )}
        {onDelete && (
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(path)}>
            <Trash2 />
            Delete file
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

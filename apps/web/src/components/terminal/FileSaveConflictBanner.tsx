import { AlertTriangle, Columns2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileSaveConflict } from "@/stores/fileDirtyStore";

interface FileSaveConflictBannerProps {
  filePath: string;
  conflict: FileSaveConflict;
  comparing: boolean;
  isSaving: boolean;
  onToggleCompare: () => void;
  onKeepMine: () => void;
  onRecreate: () => void;
  onRetry: () => void;
  onUseTheirs: () => void;
}

/**
 * The editor's conflict state: the file changed on disk (an agent, a
 * terminal, another window) while this buffer had unsaved edits. Both versions
 * are kept until the user picks one; nothing here writes without a click.
 */
export function FileSaveConflictBanner({
  filePath,
  conflict,
  comparing,
  isSaving,
  onToggleCompare,
  onKeepMine,
  onRecreate,
  onUseTheirs,
  onRetry,
}: FileSaveConflictBannerProps) {
  const changed = conflict.kind === "changed";
  const missing = conflict.kind === "missing";
  return (
    <div
      role="alert"
      aria-label="File changed on disk"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-chrome px-4 py-2 text-xs"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-failure" aria-hidden />
        <p className="min-w-0 text-foreground">
          <span className="font-medium">
            {changed
              ? "Changed on disk."
              : missing
                ? "File is missing."
                : "File could not be read."}
          </span>{" "}
          <span className="text-muted-foreground">
            {changed ? (
              <>
                <span className="font-mono">{filePath}</span> was changed since you opened it. Your
                edits are kept.
              </>
            ) : (
              <>
                <span className="font-mono">{filePath}</span> can no longer be read. Your edits are
                kept.
              </>
            )}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {isSaving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {changed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={comparing}
            onClick={onToggleCompare}
          >
            <Columns2 className="h-3.5 w-3.5" aria-hidden />
            {comparing ? "Close comparison" : "Compare"}
          </Button>
        )}
        {changed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={onUseTheirs}
          >
            Use theirs
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          disabled={isSaving}
          onClick={changed ? onKeepMine : missing ? onRecreate : onRetry}
        >
          {changed ? "Keep mine" : missing ? "Recreate file" : "Retry save"}
        </Button>
      </div>
    </div>
  );
}

import { cn } from "@/lib/utils";

const DEFAULT_MAX_VISIBLE = 8;

interface BoundedPathListProps {
  paths: readonly string[];
  maxVisible?: number;
  className?: string;
}

/**
 * Renders a capped, scrollable list of workspace paths for confirmation and
 * destination dialogs. A large multi-file selection must not stretch the
 * dialog past a usable height or bury its action buttons.
 */
export function BoundedPathList({
  paths,
  maxVisible = DEFAULT_MAX_VISIBLE,
  className,
}: BoundedPathListProps) {
  const visible = paths.slice(0, maxVisible);
  const hiddenCount = paths.length - visible.length;

  return (
    <span
      className={cn(
        "mt-2 block max-h-32 overflow-y-auto rounded-sm border border-border/60 bg-background/40 px-2 py-1",
        className,
      )}
    >
      {visible.map((path) => (
        <span key={path} className="block break-all text-foreground">
          {path}
        </span>
      ))}
      {hiddenCount > 0 && (
        <span className="mt-1 block text-muted-foreground">+{hiddenCount} more</span>
      )}
    </span>
  );
}

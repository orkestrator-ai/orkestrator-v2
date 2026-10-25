import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeProjection } from "@orkestrator/protocol/change-resources";
import { formatFileCount, formatLineCount, projectionTitle } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";

/**
 * Renders a backend projection's badge exactly as the backend decided it:
 * visibility and mode come from `projection.badge`; counts keep their
 * quality (partial, unknown, not applicable). Nothing is computed here.
 */
export function ChangeCountBadge({
  projection,
  className,
  testId = "change-count-badge",
}: {
  projection: ChangeProjection | undefined;
  className?: string;
  testId?: string;
}) {
  if (!projection || !projection.badge.visible) return null;
  const title = projectionTitle(projection);
  const dimmed = projection.state !== "ready";
  if (projection.badge.mode === "files-only" || projection.badge.mode === "unknown") {
    const contentLines = projection.labelArgs.contentLines;
    return (
      <span
        data-testid={testId}
        data-badge-mode={projection.badge.mode}
        title={title}
        className={cn(
          "flex items-center gap-1 shrink-0 font-mono text-muted-foreground",
          dimmed && "opacity-70",
          className,
        )}
      >
        {typeof contentLines === "number"
          ? `${contentLines} line${contentLines === 1 ? "" : "s"}`
          : projection.badge.mode === "unknown"
            ? "changes ?"
            : formatFileCount(projection.counters.changedFiles)}
      </span>
    );
  }
  return (
    <LineCountPair
      additions={projection.counters.additions}
      deletions={projection.counters.deletions}
      title={title}
      className={cn(dimmed && "opacity-70", className)}
      testId={testId}
    />
  );
}

export function LineCountPair({
  additions,
  deletions,
  title,
  className,
  testId,
}: {
  additions: LineCount;
  deletions: LineCount;
  title?: string;
  className?: string;
  testId?: string;
}) {
  const plus = formatLineCount("+", additions);
  const minus = formatLineCount("-", deletions);
  if (!plus && !minus) return null;
  return (
    <span
      data-testid={testId}
      title={title}
      className={cn("flex items-center gap-1 shrink-0 font-mono", className)}
    >
      {plus && <span className="text-success">{plus}</span>}
      {minus && <span className="text-failure">{minus}</span>}
    </span>
  );
}

import { Fragment, useMemo, type ReactNode } from "react";
import type {
  ChangeDiffFileBody,
  ChangeDiffHunk,
  ChangeDiffLine,
} from "@orkestrator/protocol/change-resources";
import { changeReason } from "@/lib/changes/labels";
import { cn } from "@/lib/utils";

/**
 * Renders backend-prepared hunks. Unified mode shows the rows as given;
 * split mode pairs each run of removals with the following run of additions
 * for side-by-side display. Both are layouts of the same rows — no diff is
 * computed in the client.
 *
 * A viewer that navigates between hunks passes `positionOffset` (each hunk
 * header then carries `data-hunk-position`, its place in the viewer's order),
 * the selected `activeHunkIndex`, and optional per-hunk actions.
 */

type SplitRow = { left: ChangeDiffLine | null; right: ChangeDiffLine | null };

function splitRows(hunk: ChangeDiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let removes: ChangeDiffLine[] = [];
  let adds: ChangeDiffLine[] = [];
  const flush = () => {
    const length = Math.max(removes.length, adds.length);
    for (let index = 0; index < length; index++)
      rows.push({ left: removes[index] ?? null, right: adds[index] ?? null });
    removes = [];
    adds = [];
  };
  for (const line of hunk.lines) {
    if (line.type === "remove") {
      if (adds.length > 0) flush();
      removes.push(line);
    } else if (line.type === "add") adds.push(line);
    else if (line.type === "no-newline") {
      // Attach the marker to whichever side it follows.
      if (adds.length > 0) adds.push(line);
      else if (removes.length > 0) removes.push(line);
      else rows.push({ left: line, right: line });
    } else {
      flush();
      rows.push({ left: line, right: line });
    }
  }
  flush();
  return rows;
}

function lineClass(line: ChangeDiffLine | null): string {
  if (!line) return "bg-muted/20";
  return cn(
    line.type === "add" && "bg-success/20 text-success",
    line.type === "remove" && "bg-failure/20 text-failure",
    line.type === "context" && "text-foreground/60",
    line.type === "no-newline" && "text-muted-foreground italic",
  );
}

function lineText(line: ChangeDiffLine | null): string {
  if (!line) return "";
  if (line.type === "no-newline") return "\\ No newline at end of file";
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
  return `${prefix}${line.text}`;
}

interface HunkNavigationProps {
  /** Navigation position of this file's first hunk; enables `data-hunk-position`. */
  positionOffset?: number;
  /** The hunk (index within this file) navigation has selected. */
  activeHunkIndex?: number | null;
  /** A hunk header was clicked. */
  onSelectHunk?: (hunkIndex: number) => void;
  /** Controls shown at the end of a hunk's header (stage, unstage). */
  renderHunkActions?: (hunk: ChangeDiffHunk, hunkIndex: number) => ReactNode;
}

function HunkHeader({
  hunk,
  hunkIndex,
  positionOffset,
  activeHunkIndex,
  onSelectHunk,
  renderHunkActions,
}: HunkNavigationProps & { hunk: ChangeDiffHunk; hunkIndex: number }) {
  const active = activeHunkIndex === hunkIndex;
  const actions = renderHunkActions?.(hunk, hunkIndex);
  return (
    <div
      data-testid="change-hunk-header"
      data-hunk-position={positionOffset !== undefined ? positionOffset + hunkIndex : undefined}
      aria-current={active ? "location" : undefined}
      onClick={onSelectHunk ? () => onSelectHunk(hunkIndex) : undefined}
      className={cn(
        "flex scroll-mt-1 items-center gap-2 bg-blue-500/10 px-3 py-0.5 text-blue-400",
        active && "bg-blue-500/20 ring-1 ring-inset ring-primary/60",
        onSelectHunk && "cursor-pointer",
      )}
    >
      <span className="min-w-0 flex-1 truncate">{hunk.header}</span>
      {actions && (
        <span
          className="flex shrink-0 items-center gap-1 font-sans"
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </span>
      )}
    </div>
  );
}

export function ChangeHunksView({
  file,
  mode = "unified",
  maxHeightClass = "max-h-64",
  ...navigation
}: {
  file: ChangeDiffFileBody;
  mode?: "unified" | "split";
  maxHeightClass?: string;
} & HunkNavigationProps) {
  const split = useMemo(
    () => (mode === "split" ? file.hunks.map(splitRows) : null),
    [file.hunks, mode],
  );
  const note =
    file.bodyAvailability !== "available"
      ? changeReason(file.reasonKey ?? `changes.body.${file.bodyAvailability}`)
      : file.reasonKey
        ? changeReason(file.reasonKey)
        : null;
  return (
    <div data-testid="change-hunks" className={cn("overflow-auto", maxHeightClass)}>
      {note && (
        <div role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
          {note}
        </div>
      )}
      {file.hunks.length === 0 && !note && (
        <div className="px-3 py-1.5 text-xs text-muted-foreground">No textual changes.</div>
      )}
      {mode === "unified" || !split ? (
        <pre className="text-xs font-mono">
          {file.hunks.map((hunk, hunkIndex) => (
            <Fragment key={hunkIndex}>
              <HunkHeader hunk={hunk} hunkIndex={hunkIndex} {...navigation} />
              {hunk.lines.map((line, index) => (
                <div
                  key={index}
                  className={cn("px-3 py-0.5 whitespace-pre-wrap break-all", lineClass(line))}
                >
                  {lineText(line)}
                </div>
              ))}
            </Fragment>
          ))}
        </pre>
      ) : (
        <div className="text-xs font-mono">
          {split.map((rows, hunkIndex) => (
            <Fragment key={hunkIndex}>
              <HunkHeader hunk={file.hunks[hunkIndex]!} hunkIndex={hunkIndex} {...navigation} />
              {rows.map((row, index) => (
                <div key={index} className="grid grid-cols-2">
                  <div
                    className={cn(
                      "px-3 py-0.5 whitespace-pre-wrap break-all border-r border-border/30",
                      lineClass(row.left),
                    )}
                  >
                    {row.left?.type === "add" ? "" : lineText(row.left)}
                  </div>
                  <div
                    className={cn(
                      "px-3 py-0.5 whitespace-pre-wrap break-all",
                      lineClass(row.right),
                    )}
                  >
                    {row.right?.type === "remove" ? "" : lineText(row.right)}
                  </div>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {file.truncated && (
        <div role="note" className="px-3 py-1.5 text-xs text-muted-foreground">
          The rendered body stops here; the counts above cover the whole change.
        </div>
      )}
    </div>
  );
}

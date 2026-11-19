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
 * A host can annotate the rows (`annotations`): a control beside each line
 * and hunk header, and content after them, such as review comments. Without
 * it the view is read-only.
 */

export interface ChangeHunksAnnotations {
  /** A control for one line, shown in the row's gutter. */
  lineAction?: (hunkIndex: number, line: ChangeDiffLine) => ReactNode;
  /** Content after a row; in split view one row carries up to two lines. */
  afterLines?: (hunkIndex: number, lines: readonly ChangeDiffLine[]) => ReactNode;
  /** A control on a hunk header. */
  hunkAction?: (hunkIndex: number) => ReactNode;
  /** Content after a hunk header. */
  afterHeader?: (hunkIndex: number) => ReactNode;
}

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

export function ChangeHunksView({
  file,
  mode = "unified",
  maxHeightClass = "max-h-64",
  annotations,
}: {
  file: ChangeDiffFileBody;
  mode?: "unified" | "split";
  maxHeightClass?: string;
  annotations?: ChangeHunksAnnotations;
}) {
  // Annotated rows leave a gutter for the line control.
  const gutterPadding = annotations?.lineAction ? "pl-7 pr-3" : "px-3";
  const hunkHeader = (header: string, hunkIndex: number) => (
    <div
      className={cn(
        "group/diff-line relative py-0.5 bg-blue-500/10 text-blue-400",
        annotations?.hunkAction ? "pl-7 pr-3" : "px-3",
      )}
    >
      {annotations?.hunkAction?.(hunkIndex)}
      {header}
    </div>
  );
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
              {hunkHeader(hunk.header, hunkIndex)}
              {annotations?.afterHeader?.(hunkIndex)}
              {hunk.lines.map((line, index) => (
                <Fragment key={index}>
                  <div
                    className={cn(
                      "group/diff-line relative py-0.5 whitespace-pre-wrap break-all",
                      gutterPadding,
                      lineClass(line),
                    )}
                  >
                    {annotations?.lineAction?.(hunkIndex, line)}
                    {lineText(line)}
                  </div>
                  {annotations?.afterLines?.(hunkIndex, [line])}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </pre>
      ) : (
        <div className="text-xs font-mono">
          {split.map((rows, hunkIndex) => (
            <Fragment key={hunkIndex}>
              {hunkHeader(file.hunks[hunkIndex]!.header, hunkIndex)}
              {annotations?.afterHeader?.(hunkIndex)}
              {rows.map((row, index) => {
                const left = row.left?.type === "add" ? null : row.left;
                const right = row.right?.type === "remove" ? null : row.right;
                // A context row shows one line on both sides; it is one line.
                const rowLines =
                  left && right && left === right
                    ? [left]
                    : [left, right].filter((line): line is ChangeDiffLine => line !== null);
                return (
                  <Fragment key={index}>
                    <div className="grid grid-cols-2">
                      <div
                        className={cn(
                          "group/diff-line relative py-0.5 whitespace-pre-wrap break-all border-r border-border/30",
                          gutterPadding,
                          lineClass(row.left),
                        )}
                      >
                        {left && left !== right && annotations?.lineAction?.(hunkIndex, left)}
                        {left ? lineText(left) : ""}
                      </div>
                      <div
                        className={cn(
                          "group/diff-line relative py-0.5 whitespace-pre-wrap break-all",
                          gutterPadding,
                          lineClass(row.right),
                        )}
                      >
                        {right && annotations?.lineAction?.(hunkIndex, right)}
                        {right ? lineText(right) : ""}
                      </div>
                    </div>
                    {annotations?.afterLines?.(hunkIndex, rowLines)}
                  </Fragment>
                );
              })}
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

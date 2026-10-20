/**
 * Bounded line diff for before/after text pairs.
 *
 * An edit tool that reports only the two sides of a change used to be shown
 * as "every old line removed, every new line added", which turns a one-line
 * edit in a long file into a whole-file replacement that looks exact. This
 * computes the minimal line edit script (Myers' O((N+M)·D) algorithm, after
 * trimming the common prefix and suffix) and groups it into unified hunks.
 *
 * The work is explicitly budgeted. Inputs with too many lines, an edit
 * distance beyond the budget, or more output than an inline view should hold
 * return a labelled `too-large` result instead of a coarse patch, so a caller
 * can show a summary and open its full diff viewer rather than invent one.
 *
 * Lines follow `splitTextLines`: a trailing newline terminates the last line
 * and does not create another one. Line text is compared exactly, so
 * whitespace and `\r` differences are real differences.
 */
import { splitTextLines } from "./tool-diff.js";

export interface LineDiffBudget {
  /** Lines per side above which no diff is attempted. */
  maxLinesPerSide: number;
  /** Largest edit distance (inserted + deleted lines) searched for. */
  maxEditDistance: number;
  /** Largest number of rendered hunk lines (context included). */
  maxOutputLines: number;
  /** Unchanged lines shown around each change. */
  contextLines: number;
}

export const DEFAULT_LINE_DIFF_BUDGET: LineDiffBudget = {
  maxLinesPerSide: 20_000,
  maxEditDistance: 1_000,
  maxOutputLines: 2_000,
  contextLines: 3,
};

export interface LineDiffLine {
  type: "context" | "add" | "remove";
  text: string;
}

export interface LineDiffHunk {
  /** One-based first old line (the preceding line when `oldLines` is 0). */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: LineDiffLine[];
}

export type LineDiffResult =
  | {
      kind: "diff";
      hunks: LineDiffHunk[];
      additions: number;
      deletions: number;
      oldLineCount: number;
      newLineCount: number;
    }
  | {
      kind: "too-large";
      reason: "line-count" | "edit-distance" | "output-lines";
      oldLineCount: number;
      newLineCount: number;
    };

type Edit = { type: "equal" | "insert" | "delete"; oldIndex: number; newIndex: number };

/**
 * Minimal edit script between `a` and `b`, or null when it needs more than
 * `maxD` insertions plus deletions. Memory is O(D²) for the trace.
 */
function myers(a: readonly string[], b: readonly string[], maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    // Snapshot of k ∈ [-d-1, d+1] before this step, indexed by k + d + 1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]!;
    const at = (k: number) => snapshot[k + d + 1]!;
    const k = x - y;
    if (d === 0) {
      while (x > 0 && y > 0) {
        x--;
        y--;
        edits.push({ type: "equal", oldIndex: x, newIndex: y });
      }
      break;
    }
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push({ type: "equal", oldIndex: x, newIndex: y });
    }
    if (x === prevX) {
      edits.push({ type: "insert", oldIndex: x, newIndex: prevY });
    } else {
      edits.push({ type: "delete", oldIndex: prevX, newIndex: y });
    }
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

/** Diff two texts by line within `budget`. */
export function diffLines(
  before: string,
  after: string,
  budget: Partial<LineDiffBudget> = {},
): LineDiffResult {
  const limits = { ...DEFAULT_LINE_DIFF_BUDGET, ...budget };
  const oldLines = splitTextLines(before);
  const newLines = splitTextLines(after);
  const counts = { oldLineCount: oldLines.length, newLineCount: newLines.length };
  if (oldLines.length > limits.maxLinesPerSide || newLines.length > limits.maxLinesPerSide) {
    return { kind: "too-large", reason: "line-count", ...counts };
  }

  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const middle = myers(
    oldLines.slice(prefix, oldLines.length - suffix),
    newLines.slice(prefix, newLines.length - suffix),
    limits.maxEditDistance,
  );
  if (!middle) return { kind: "too-large", reason: "edit-distance", ...counts };

  const edits: Edit[] = [];
  for (let index = 0; index < prefix; index++) {
    edits.push({ type: "equal", oldIndex: index, newIndex: index });
  }
  for (const edit of middle) {
    edits.push({ ...edit, oldIndex: edit.oldIndex + prefix, newIndex: edit.newIndex + prefix });
  }
  for (let index = 0; index < suffix; index++) {
    edits.push({
      type: "equal",
      oldIndex: oldLines.length - suffix + index,
      newIndex: newLines.length - suffix + index,
    });
  }

  let additions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === "insert") additions++;
    else if (edit.type === "delete") deletions++;
  }

  const hunks = groupHunks(edits, oldLines, newLines, limits.contextLines);
  const outputLines = hunks.reduce((total, hunk) => total + hunk.lines.length + 1, 0);
  if (outputLines > limits.maxOutputLines) {
    return { kind: "too-large", reason: "output-lines", ...counts };
  }
  return { kind: "diff", hunks, additions, deletions, ...counts };
}

function groupHunks(
  edits: readonly Edit[],
  oldLines: readonly string[],
  newLines: readonly string[],
  context: number,
): LineDiffHunk[] {
  const changeIndexes: number[] = [];
  edits.forEach((edit, index) => {
    if (edit.type !== "equal") changeIndexes.push(index);
  });
  if (changeIndexes.length === 0) return [];

  // Merge change runs whose context windows touch or overlap.
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(edits.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }

  return ranges.map(({ start, end }) => {
    const lines: LineDiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let firstOld: number | null = null;
    let firstNew: number | null = null;
    for (let index = start; index <= end; index++) {
      const edit = edits[index]!;
      if (edit.type === "equal") {
        firstOld ??= edit.oldIndex;
        firstNew ??= edit.newIndex;
        lines.push({ type: "context", text: oldLines[edit.oldIndex]! });
        oldCount++;
        newCount++;
      } else if (edit.type === "delete") {
        firstOld ??= edit.oldIndex;
        lines.push({ type: "remove", text: oldLines[edit.oldIndex]! });
        oldCount++;
      } else {
        firstNew ??= edit.newIndex;
        lines.push({ type: "add", text: newLines[edit.newIndex]! });
        newCount++;
      }
    }
    const first = edits[start]!;
    // Unified convention: an empty side names the line before the hunk.
    const oldStart = oldCount === 0 ? first.oldIndex : (firstOld ?? first.oldIndex) + 1;
    const newStart = newCount === 0 ? first.newIndex : (firstNew ?? first.newIndex) + 1;
    return { oldStart, oldLines: oldCount, newStart, newLines: newCount, lines };
  });
}

export function formatHunkHeader(hunk: LineDiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Unified hunks (no file header), one line per array entry. */
export function unifiedDiffLines(hunks: readonly LineDiffHunk[]): string[] {
  const output: string[] = [];
  for (const hunk of hunks) {
    output.push(formatHunkHeader(hunk));
    for (const line of hunk.lines) {
      output.push(`${line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}${line.text}`);
    }
  }
  return output;
}

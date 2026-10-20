/**
 * raw-lines-v1 text comparison over raw bytes.
 *
 * Tokens are LF-terminated byte runs that keep their terminator, compared as
 * exact bytes (CR included). A final unterminated line is a token of its own,
 * so adding a missing final LF changes that line, and a terminal LF never
 * produces a phantom empty line. Non-UTF-8 bytes are preserved: tokens are
 * compared in a 1:1 latin1 mapping and only decoded for display.
 *
 * Counts and hunks are separate budgets. The edit distance D of a Myers
 * forward pass alone gives exact totals (additions − deletions is fixed by
 * the two lengths), using O(N) memory, so a body too large to render can
 * still have complete counts. Hunk generation keeps the O(D²) trace and has
 * its own smaller budget. Every limit returns a labelled result; nothing
 * falls back to whole-input lengths.
 */

import type { ChangeDiffHunk, ChangeDiffLine } from "../../change-resources.js";

export interface RawLineDiffBudget {
  /** Combined old+new bytes above which no comparison is attempted. */
  maxInputBytes: number;
  /** Largest edit distance searched when only counting. */
  maxCountEditDistance: number;
  /** Largest edit distance for which hunks are produced. */
  maxHunkEditDistance: number;
  /** Wall-clock budget for one comparison, checked between Myers rounds. */
  cpuBudgetMs: number;
  /** Rendered hunk lines (context included) before the body is truncated. */
  maxOutputLines: number;
  contextLines: number;
}

export const DEFAULT_RAW_LINE_DIFF_BUDGET: RawLineDiffBudget = {
  maxInputBytes: 8 * 1024 * 1024,
  maxCountEditDistance: 200_000,
  maxHunkEditDistance: 2_000,
  cpuBudgetMs: 500,
  maxOutputLines: 4_000,
  contextLines: 3,
};

export type RawLineLimitReason = "input-bytes" | "edit-distance" | "cpu-budget";

export type RawLineCountResult =
  | {
      kind: "counted";
      additions: number;
      deletions: number;
      oldLineCount: number;
      newLineCount: number;
    }
  | { kind: "limit"; reason: RawLineLimitReason; oldLineCount: number; newLineCount: number };

export type RawLineDiffResult =
  | {
      kind: "diff";
      additions: number;
      deletions: number;
      hunks: ChangeDiffHunk[];
      /** The rendered body stopped at `maxOutputLines`; counts remain complete. */
      truncated: boolean;
    }
  | { kind: "counts-only"; additions: number; deletions: number; reason: RawLineLimitReason }
  | { kind: "limit"; reason: RawLineLimitReason };

const LF = 0x0a;
const NUL = 0x00;
const BINARY_SNIFF_BYTES = 8000;

/** Git's heuristic: a NUL byte in the first 8000 bytes marks binary content. */
export function isProbablyBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index++) if (bytes[index] === NUL) return true;
  return false;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Split into raw-lines-v1 tokens (latin1 strings, terminator retained). */
export function tokenizeRawLines(bytes: Uint8Array): string[] {
  const tokens: string[] = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === LF) {
      tokens.push(latin1(bytes, start, index + 1));
      start = index + 1;
    }
  }
  if (start < bytes.length) tokens.push(latin1(bytes, start, bytes.length));
  return tokens;
}

/** Count raw-lines-v1 tokens without materializing them. */
export function countRawLines(bytes: Uint8Array): number {
  let lines = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === LF) lines++;
  if (bytes.length > 0 && bytes[bytes.length - 1] !== LF) lines++;
  return lines;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  const CHUNK = 8192;
  for (let index = start; index < end; index += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(index, Math.min(end, index + CHUNK)));
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Display text for a token: decoded UTF-8 without its LF terminator. */
export function displayToken(token: string): { text: string; terminated: boolean } {
  const terminated = token.endsWith("\n");
  const body = terminated ? token.slice(0, -1) : token;
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index++) bytes[index] = body.charCodeAt(index);
  return { text: decoder.decode(bytes), terminated };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

interface Trimmed {
  a: string[];
  b: string[];
  prefix: number;
  suffix: number;
  oldTokens: string[];
  newTokens: string[];
}

function trim(oldTokens: string[], newTokens: string[]): Trimmed {
  let prefix = 0;
  while (
    prefix < oldTokens.length &&
    prefix < newTokens.length &&
    oldTokens[prefix] === newTokens[prefix]
  ) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldTokens.length - prefix &&
    suffix < newTokens.length - prefix &&
    oldTokens[oldTokens.length - 1 - suffix] === newTokens[newTokens.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    a: oldTokens.slice(prefix, oldTokens.length - suffix),
    b: newTokens.slice(prefix, newTokens.length - suffix),
    prefix,
    suffix,
    oldTokens,
    newTokens,
  };
}

type Clock = () => number;
const defaultClock: Clock = () => performance.now();

/**
 * Myers forward pass returning the edit distance, or a limit reason. Memory
 * is O(N+M); nothing is retained for backtracking.
 */
function editDistance(
  a: readonly string[],
  b: readonly string[],
  maxD: number,
  deadline: number,
  clock: Clock,
): number | RawLineLimitReason {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return n + m;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  for (let d = 0; d <= limit; d++) {
    if ((d & 63) === 0 && clock() > deadline) return "cpu-budget";
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
      if (x >= n && y >= m) return d;
    }
  }
  return "edit-distance";
}

type Edit = { type: "equal" | "insert" | "delete"; oldIndex: number; newIndex: number };

function editScript(
  a: readonly string[],
  b: readonly string[],
  maxD: number,
  deadline: number,
  clock: Clock,
): Edit[] | RawLineLimitReason {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(maxD, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    if ((d & 31) === 0 && clock() > deadline) return "cpu-budget";
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
  return "edit-distance";
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
    if (x === prevX) edits.push({ type: "insert", oldIndex: x, newIndex: prevY });
    else edits.push({ type: "delete", oldIndex: prevX, newIndex: y });
    x = prevX;
    y = prevY;
  }
  return edits.reverse();
}

function countsFromDistance(d: number, n: number, m: number) {
  // additions + deletions = d; additions − deletions = m − n.
  return { additions: (d + (m - n)) / 2, deletions: (d - (m - n)) / 2 };
}

/** Exact raw-lines-v1 totals within budget, or a labelled limit. */
export function countRawLineChanges(
  before: Uint8Array,
  after: Uint8Array,
  budget: Partial<RawLineDiffBudget> = {},
  clock: Clock = defaultClock,
): RawLineCountResult {
  const limits = { ...DEFAULT_RAW_LINE_DIFF_BUDGET, ...budget };
  const oldLineCount = countRawLines(before);
  const newLineCount = countRawLines(after);
  if (before.length + after.length > limits.maxInputBytes) {
    return { kind: "limit", reason: "input-bytes", oldLineCount, newLineCount };
  }
  if (bytesEqual(before, after)) {
    return { kind: "counted", additions: 0, deletions: 0, oldLineCount, newLineCount };
  }
  const trimmed = trim(tokenizeRawLines(before), tokenizeRawLines(after));
  const deadline = clock() + limits.cpuBudgetMs;
  const d = editDistance(trimmed.a, trimmed.b, limits.maxCountEditDistance, deadline, clock);
  if (typeof d === "string") return { kind: "limit", reason: d, oldLineCount, newLineCount };
  return {
    kind: "counted",
    ...countsFromDistance(d, trimmed.a.length, trimmed.b.length),
    oldLineCount,
    newLineCount,
  };
}

export interface RawLineViewOptions {
  /**
   * Compare lines with all whitespace removed. This is a separate display
   * view over the same endpoints: its additions/deletions are view-local and
   * never replace a measurement's canonical counts.
   */
  ignoreWhitespace?: boolean;
}

const stripWhitespace = (token: string) => token.replace(/\s+/g, "");

/** Counts plus rendered hunks, each within its own budget. */
export function diffRawLines(
  before: Uint8Array,
  after: Uint8Array,
  budget: Partial<RawLineDiffBudget> = {},
  clock: Clock = defaultClock,
  view: RawLineViewOptions = {},
): RawLineDiffResult {
  const limits = { ...DEFAULT_RAW_LINE_DIFF_BUDGET, ...budget };
  if (before.length + after.length > limits.maxInputBytes) {
    return { kind: "limit", reason: "input-bytes" };
  }
  if (bytesEqual(before, after)) {
    return { kind: "diff", additions: 0, deletions: 0, hunks: [], truncated: false };
  }
  if (view.ignoreWhitespace) return diffIgnoringWhitespace(before, after, limits, clock);
  const trimmed = trim(tokenizeRawLines(before), tokenizeRawLines(after));
  const deadline = clock() + limits.cpuBudgetMs;
  const script = editScript(trimmed.a, trimmed.b, limits.maxHunkEditDistance, deadline, clock);
  if (typeof script === "string") {
    const d = editDistance(trimmed.a, trimmed.b, limits.maxCountEditDistance, deadline, clock);
    if (typeof d === "string") return { kind: "limit", reason: d };
    return {
      kind: "counts-only",
      ...countsFromDistance(d, trimmed.a.length, trimmed.b.length),
      reason: script,
    };
  }

  const edits: Edit[] = [];
  for (let index = 0; index < trimmed.prefix; index++) {
    edits.push({ type: "equal", oldIndex: index, newIndex: index });
  }
  for (const edit of script) {
    edits.push({
      ...edit,
      oldIndex: edit.oldIndex + trimmed.prefix,
      newIndex: edit.newIndex + trimmed.prefix,
    });
  }
  for (let index = 0; index < trimmed.suffix; index++) {
    edits.push({
      type: "equal",
      oldIndex: trimmed.oldTokens.length - trimmed.suffix + index,
      newIndex: trimmed.newTokens.length - trimmed.suffix + index,
    });
  }
  let additions = 0;
  let deletions = 0;
  for (const edit of edits) {
    if (edit.type === "insert") additions++;
    else if (edit.type === "delete") deletions++;
  }
  const { hunks, truncated } = groupHunks(
    edits,
    trimmed.oldTokens,
    trimmed.newTokens,
    limits.contextLines,
    limits.maxOutputLines,
  );
  return { kind: "diff", additions, deletions, hunks, truncated };
}

function diffIgnoringWhitespace(
  before: Uint8Array,
  after: Uint8Array,
  limits: RawLineDiffBudget,
  clock: Clock,
): RawLineDiffResult {
  const oldTokens = tokenizeRawLines(before);
  const newTokens = tokenizeRawLines(after);
  const deadline = clock() + limits.cpuBudgetMs;
  const script = editScript(
    oldTokens.map(stripWhitespace),
    newTokens.map(stripWhitespace),
    limits.maxHunkEditDistance,
    deadline,
    clock,
  );
  if (typeof script === "string") return { kind: "limit", reason: script };
  let additions = 0;
  let deletions = 0;
  for (const edit of script) {
    if (edit.type === "insert") additions++;
    else if (edit.type === "delete") deletions++;
  }
  const { hunks, truncated } = groupHunks(
    script,
    oldTokens,
    newTokens,
    limits.contextLines,
    limits.maxOutputLines,
  );
  return { kind: "diff", additions, deletions, hunks, truncated };
}

function groupHunks(
  edits: readonly Edit[],
  oldTokens: readonly string[],
  newTokens: readonly string[],
  context: number,
  maxOutputLines: number,
): { hunks: ChangeDiffHunk[]; truncated: boolean } {
  const ranges: Array<{ start: number; end: number }> = [];
  edits.forEach((edit, index) => {
    if (edit.type === "equal") return;
    const start = Math.max(0, index - context);
    const end = Math.min(edits.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  });

  const hunks: ChangeDiffHunk[] = [];
  let emitted = 0;
  for (const { start, end } of ranges) {
    if (emitted >= maxOutputLines) return { hunks, truncated: true };
    const lines: ChangeDiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    let firstOld: number | null = null;
    let firstNew: number | null = null;
    let cut = false;
    for (let index = start; index <= end; index++) {
      const edit = edits[index]!;
      const token = edit.type === "insert" ? newTokens[edit.newIndex]! : oldTokens[edit.oldIndex]!;
      const rows = displayToken(token).terminated ? 1 : 2;
      if (emitted + 1 + lines.length + rows > maxOutputLines) {
        cut = true;
        break;
      }

      if (edit.type === "equal") {
        firstOld ??= edit.oldIndex;
        firstNew ??= edit.newIndex;
        pushToken(
          lines,
          "context",
          oldTokens[edit.oldIndex]!,
          edit.oldIndex + 1,
          edit.newIndex + 1,
        );
        oldCount++;
        newCount++;
      } else if (edit.type === "delete") {
        firstOld ??= edit.oldIndex;
        pushToken(lines, "remove", oldTokens[edit.oldIndex]!, edit.oldIndex + 1, null);
        oldCount++;
      } else {
        firstNew ??= edit.newIndex;
        pushToken(lines, "add", newTokens[edit.newIndex]!, null, edit.newIndex + 1);
        newCount++;
      }
    }
    if (lines.length === 0) return { hunks, truncated: true };
    const first = edits[start]!;
    const oldStart = oldCount === 0 ? first.oldIndex : (firstOld ?? first.oldIndex) + 1;
    const newStart = newCount === 0 ? first.newIndex : (firstNew ?? first.newIndex) + 1;
    emitted += lines.length + 1;
    hunks.push({
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldLines: oldCount,
      newStart,
      newLines: newCount,
      lines,
    });
    if (cut) return { hunks, truncated: true };
  }
  return { hunks, truncated: false };
}

function pushToken(
  lines: ChangeDiffLine[],
  type: "context" | "add" | "remove",
  token: string,
  oldLine: number | null,
  newLine: number | null,
): void {
  const { text, terminated } = displayToken(token);
  lines.push({ type, text, oldLine, newLine });
  if (!terminated) lines.push({ type: "no-newline", text: "", oldLine: null, newLine: null });
}

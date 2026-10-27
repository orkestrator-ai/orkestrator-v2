/**
 * Hunk-aware unified patch parser (unified-patch-v1).
 *
 * One parser serves both the counts and the displayed hunks of a patch, so a
 * badge can never disagree with the body under it. File headers are only
 * recognised where the grammar allows them: inside a hunk the first byte is
 * an operation prefix, so a source line `++counter;` added by the patch reads
 * as `+++counter;` and is an addition, not a header.
 *
 * Malformed or truncated input is reported as incomplete rather than skipped.
 * Combined (merge) diffs are routed to an explicit unsupported result. Every
 * dimension is bounded: input bytes, files, hunks and rendered rows.
 */

import type { ChangeDiffHunk, ChangeDiffLine, ChangeFileStatus } from "../../change-resources.js";

export interface UnifiedPatchLimits {
  maxInputBytes: number;
  maxFiles: number;
  maxHunks: number;
  /** Rendered rows retained across all files; counting continues beyond it. */
  maxOutputLines: number;
}

export const DEFAULT_UNIFIED_PATCH_LIMITS: UnifiedPatchLimits = {
  maxInputBytes: 8 * 1024 * 1024,
  maxFiles: 2_000,
  maxHunks: 20_000,
  maxOutputLines: 4_000,
};

export type PatchIssueCode =
  | "input-too-large"
  | "too-many-files"
  | "too-many-hunks"
  | "malformed-hunk-header"
  | "truncated-hunk"
  | "unexpected-line"
  | "content-outside-hunk"
  | "combined-diff-unsupported"
  | "empty";

export interface PatchIssue {
  code: PatchIssueCode;
  line: number;
}

export interface ParsedPatchFile {
  oldPath: string | null;
  newPath: string | null;
  status: ChangeFileStatus;
  oldMode: string | null;
  newMode: string | null;
  binary: boolean;
  similarity: number | null;
  additions: number;
  deletions: number;
  hunks: ChangeDiffHunk[];
  /** A hunk in this file ended before its declared line counts were met. */
  incomplete: boolean;
}

export interface ParsedPatch {
  kind: "parsed";
  files: ParsedPatchFile[];
  additions: number;
  deletions: number;
  /** True only when every hunk satisfied its declared counts and no issue arose. */
  complete: boolean;
  /** Rendered hunks were cut at the output budget; counts remain complete. */
  bodyTruncated: boolean;
  issues: PatchIssue[];
}

export type PatchParseResult =
  ParsedPatch | { kind: "unsupported"; reason: "combined-diff" | "input-too-large" | "empty" };

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const COMBINED_HEADER = /^@@@+ /;

/** Decode a Git C-style quoted path (`"a\tb"`), leaving unquoted paths alone. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte);
      continue;
    }
    const next = body[++index];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(index, index + 3);
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      index += octal.length - 1;
      continue;
    }
    const escapes: Record<string, number> = {
      n: 0x0a,
      t: 0x09,
      r: 0x0d,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      v: 0x0b,
      '"': 0x22,
      "\\": 0x5c,
    };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function stripPrefix(path: string): string | null {
  const unquoted = unquoteGitPath(path.trim());
  if (unquoted === "/dev/null") return null;
  // Header paths may carry a trailing tab and timestamp (`--- a/x\t2024-…`).
  const tab = unquoted.indexOf("\t");
  const clean = tab >= 0 ? unquoted.slice(0, tab) : unquoted;
  if (clean.startsWith("a/") || clean.startsWith("b/")) return clean.slice(2);
  return clean;
}

function parseDiffGitPaths(rest: string): { oldPath: string | null; newPath: string | null } {
  // `diff --git a/x b/x`, possibly quoted. Split on the " b/" boundary when
  // both sides are unquoted and equal-length paths cannot be distinguished.
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    const first = rest.slice(0, end + 1);
    const second = rest.slice(end + 2);
    return { oldPath: stripPrefix(first), newPath: stripPrefix(second) };
  }
  const match = /^a\/(.*) b\/(.*)$/.exec(rest);
  if (match) return { oldPath: match[1]!, newPath: match[2]! };
  const space = rest.indexOf(" ");
  if (space < 0) return { oldPath: null, newPath: null };
  return {
    oldPath: stripPrefix(rest.slice(0, space)),
    newPath: stripPrefix(rest.slice(space + 1)),
  };
}

function newFile(): ParsedPatchFile {
  return {
    oldPath: null,
    newPath: null,
    status: "modified",
    oldMode: null,
    newMode: null,
    binary: false,
    similarity: null,
    additions: 0,
    deletions: 0,
    hunks: [],
    incomplete: false,
  };
}

function finishStatus(file: ParsedPatchFile, explicit: ChangeFileStatus | null): void {
  if (explicit) file.status = explicit;
  else if (file.oldPath === null && file.newPath !== null) file.status = "added";
  else if (file.newPath === null && file.oldPath !== null) file.status = "deleted";
  else if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath) {
    file.status = "renamed";
  } else if (
    file.hunks.length === 0 &&
    !file.binary &&
    file.oldMode !== null &&
    file.newMode !== null &&
    file.oldMode !== file.newMode
  ) {
    file.status = "mode-changed";
  }
}

/**
 * Parse a unified patch (Git extended headers or plain `---`/`+++` pairs).
 * Lines beginning with `+`/`-` are only counted inside a hunk whose declared
 * extent they fall within.
 */
export function parseUnifiedPatch(
  text: string,
  limits: Partial<UnifiedPatchLimits> = {},
): PatchParseResult {
  const bounds = { ...DEFAULT_UNIFIED_PATCH_LIMITS, ...limits };
  if (text.length === 0) return { kind: "unsupported", reason: "empty" };
  if (text.length > bounds.maxInputBytes) return { kind: "unsupported", reason: "input-too-large" };

  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const issues: PatchIssue[] = [];
  const files: ParsedPatchFile[] = [];
  let file: ParsedPatchFile | null = null;
  let explicitStatus: ChangeFileStatus | null = null;
  let hunk: ChangeDiffHunk | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let oldLine = 0;
  let newLine = 0;
  let hunkCount = 0;
  let renderedRows = 0;
  let bodyTruncated = false;
  let stopped = false;

  const closeHunk = (lineNumber: number) => {
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      issues.push({ code: "truncated-hunk", line: lineNumber });
      if (file) file.incomplete = true;
    }
    hunk = null;
    oldRemaining = 0;
    newRemaining = 0;
  };
  const closeFile = (lineNumber: number) => {
    closeHunk(lineNumber);
    if (file) {
      finishStatus(file, explicitStatus);
      files.push(file);
    }
    file = null;
    explicitStatus = null;
  };
  const openFile = (): ParsedPatchFile | null => {
    if (files.length + 1 > bounds.maxFiles) {
      issues.push({ code: "too-many-files", line: 0 });
      stopped = true;
      return null;
    }
    file = newFile();
    return file;
  };
  const record = (row: ChangeDiffLine) => {
    if (!hunk) return;
    if (renderedRows >= bounds.maxOutputLines) {
      bodyTruncated = true;
      return;
    }
    hunk.lines.push(row);
    renderedRows++;
  };

  for (let index = 0; index < lines.length && !stopped; index++) {
    const line = lines[index]!;
    const lineNumber = index + 1;

    // Inside a hunk with lines still owed, the first byte is an operation.
    if (hunk && (oldRemaining > 0 || newRemaining > 0)) {
      const op = line[0];
      const body = line.slice(1);
      const current: ParsedPatchFile = file!;
      if (op === "+" && newRemaining > 0) {
        current.additions++;
        newRemaining--;
        record({ type: "add", text: body, oldLine: null, newLine: newLine++ });
        continue;
      }
      if (op === "-" && oldRemaining > 0) {
        current.deletions++;
        oldRemaining--;
        record({ type: "remove", text: body, oldLine: oldLine++, newLine: null });
        continue;
      }
      if ((op === " " || line === "") && oldRemaining > 0 && newRemaining > 0) {
        oldRemaining--;
        newRemaining--;
        record({ type: "context", text: body, oldLine: oldLine++, newLine: newLine++ });
        continue;
      }
      if (op === "\\") {
        record({ type: "no-newline", text: "", oldLine: null, newLine: null });
        continue;
      }
      // Anything else ends the hunk early.
      closeHunk(lineNumber);
    } else if (hunk && line.startsWith("\\")) {
      // "\ No newline at end of file" after the final counted line.
      record({ type: "no-newline", text: "", oldLine: null, newLine: null });
      continue;
    } else if (hunk) {
      hunk = null;
    }

    if (
      COMBINED_HEADER.test(line) ||
      line.startsWith("diff --cc ") ||
      line.startsWith("diff --combined ")
    ) {
      return { kind: "unsupported", reason: "combined-diff" };
    }
    if (line.startsWith("diff --git ")) {
      closeFile(lineNumber);
      const opened = openFile();
      if (!opened) break;
      const paths = parseDiffGitPaths(line.slice("diff --git ".length));
      opened.oldPath = paths.oldPath;
      opened.newPath = paths.newPath;
      continue;
    }
    if (line.startsWith("--- ") && lines[index + 1]?.startsWith("+++ ")) {
      // A plain header pair starts a new file unless it completes a
      // `diff --git` block that has not seen hunks yet.
      const current = file as ParsedPatchFile | null;
      if (!current || current.hunks.length > 0) {
        closeFile(lineNumber);
        if (!openFile()) break;
      }
      const target = file as ParsedPatchFile | null;
      if (!target) break;
      target.oldPath = stripPrefix(line.slice(4));
      target.newPath = stripPrefix(lines[index + 1]!.slice(4));
      index++;
      continue;
    }
    const match = HUNK_HEADER.exec(line);
    if (match) {
      if (!file) {
        if (!openFile()) break;
      }
      if (++hunkCount > bounds.maxHunks) {
        issues.push({ code: "too-many-hunks", line: lineNumber });
        break;
      }
      const oldStart = Number(match[1]);
      const oldLines = match[2] === undefined ? 1 : Number(match[2]);
      const newStart = Number(match[3]);
      const newLines = match[4] === undefined ? 1 : Number(match[4]);
      if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)) {
        issues.push({ code: "malformed-hunk-header", line: lineNumber });
        continue;
      }
      hunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      (file as unknown as ParsedPatchFile).hunks.push(hunk);
      oldRemaining = oldLines;
      newRemaining = newLines;
      oldLine = oldStart === 0 ? 1 : oldStart;
      newLine = newStart === 0 ? 1 : newStart;
      continue;
    }
    if (line.startsWith("@@")) {
      issues.push({ code: "malformed-hunk-header", line: lineNumber });
      continue;
    }
    if (file) {
      const current = file as ParsedPatchFile;
      if (line.startsWith("new file mode ")) {
        current.newMode = line.slice(14).trim();
        current.oldPath = null;
        explicitStatus = "added";
        continue;
      }
      if (line.startsWith("deleted file mode ")) {
        current.oldMode = line.slice(18).trim();
        current.newPath = null;
        explicitStatus = "deleted";
        continue;
      }
      if (line.startsWith("old mode ")) {
        current.oldMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith("new mode ")) {
        current.newMode = line.slice(9).trim();
        continue;
      }
      if (line.startsWith("rename from ")) {
        current.oldPath = unquoteGitPath(line.slice(12));
        explicitStatus = "renamed";
        continue;
      }
      if (line.startsWith("rename to ")) {
        current.newPath = unquoteGitPath(line.slice(10));
        explicitStatus = "renamed";
        continue;
      }
      if (line.startsWith("copy from ")) {
        current.oldPath = unquoteGitPath(line.slice(10));
        explicitStatus = "copied";
        continue;
      }
      if (line.startsWith("copy to ")) {
        current.newPath = unquoteGitPath(line.slice(8));
        explicitStatus = "copied";
        continue;
      }
      if (line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) {
        const value = Number.parseInt(line.replace(/^\D+/, ""), 10);
        current.similarity = Number.isFinite(value) ? value : null;
        continue;
      }
      if (line.startsWith("index ")) continue;
      if (line.startsWith("Binary files ") || line === "GIT binary patch") {
        current.binary = true;
        continue;
      }
    }
    if (line.length === 0) continue;
    if (line[0] === "+" || line[0] === "-") {
      issues.push({ code: "content-outside-hunk", line: lineNumber });
      continue;
    }
    // Diagnostic prose around a patch is not evidence; it is ignored but noted
    // only when it appears inside a file block.
    if (file) issues.push({ code: "unexpected-line", line: lineNumber });
  }
  closeFile(lines.length);

  if (files.length === 0) return { kind: "unsupported", reason: "empty" };
  let additions = 0;
  let deletions = 0;
  for (const parsed of files) {
    additions += parsed.additions;
    deletions += parsed.deletions;
  }
  const countIssues = issues.filter((issue) => issue.code !== "unexpected-line");
  return {
    kind: "parsed",
    files,
    additions,
    deletions,
    complete: countIssues.length === 0 && files.every((parsed) => !parsed.incomplete),
    bodyTruncated,
    issues: issues.slice(0, 64),
  };
}

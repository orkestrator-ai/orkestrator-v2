/**
 * Reading the per-change payload app-server supplies on a `fileChange` item.
 *
 * `v2/FileUpdateChange.diff` is not one format. Codex fills it from the patch
 * it applied (`codex-rs` app-server, `format_file_change_diff`):
 *
 * - `add`: the new file's whole content;
 * - `delete`: the removed file's whole content;
 * - `update`: unified hunks without file headers (`@@ -a,b +c,d @@` …),
 *   followed by `\n\nMoved to: <path>` when the patch also renames the file.
 *
 * This is the only faithful record of an edit. The worktree is not: by the
 * time a row is rendered again the file may hold later edits, so nothing here
 * reads the disk.
 */
import { isAbsolute, join, relative } from "node:path";
import type { FileUpdateChange } from "../codex-item-types.js";

const MOVED_TO_SUFFIX = /\n\nMoved to: ([^\n]+)\n?$/;
const UNIFIED_START = /^(?:@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|--- |diff --git )/;

export type SuppliedFileChange =
  | {
      kind: "update";
      /** The hunks as supplied, rename suffix removed. */
      hunks: string;
      /** True when `hunks` is unified-diff text (or empty, for a pure rename). */
      unified: boolean;
      movePath?: string;
    }
  | { kind: "add" | "delete"; content: string };

/**
 * The payload a change carries, decoded by kind. Undefined when the source
 * supplied none: the change is then known by path and kind only.
 */
export function suppliedFileChange(change: FileUpdateChange): SuppliedFileChange | undefined {
  if (change.diff === undefined) return undefined;
  if (change.kind === "add" || change.kind === "delete") {
    return { kind: change.kind, content: change.diff };
  }
  let hunks = change.diff;
  let movePath = change.move_path;
  // A unified-diff body line starts with ` `, `+`, `-`, `@` or `\`, so a
  // trailing "Moved to:" line can only be app-server's rename note.
  const moved = MOVED_TO_SUFFIX.exec(hunks);
  if (moved) {
    hunks = hunks.slice(0, moved.index);
    movePath ??= moved[1]!.trim() || undefined;
  }
  return {
    kind: "update",
    hunks,
    unified: hunks.length === 0 || UNIFIED_START.test(hunks),
    ...(movePath ? { movePath } : {}),
  };
}

function headerPath(cwd: string, path: string): string {
  return isAbsolute(path) ? relative(cwd, path) || path : path;
}

/** Content lines, each keeping no terminator; a terminal LF adds no line. */
function contentLines(content: string): { lines: string[]; finalNewline: boolean } {
  if (content.length === 0) return { lines: [], finalNewline: true };
  const finalNewline = content.endsWith("\n");
  const lines = (finalNewline ? content.slice(0, -1) : content).split("\n");
  return { lines, finalNewline };
}

/**
 * The legacy transcript diff for one supplied change: a headed unified diff
 * the existing renderer shows, built from app-server's payload alone. An
 * update's hunks are kept verbatim; an add or delete becomes one hunk over
 * the supplied content. Undefined when there is nothing to show (an empty
 * file, a pure rename) or the payload is not a diff.
 */
export function legacyUnifiedDiff(
  cwd: string,
  change: FileUpdateChange,
  supplied: SuppliedFileChange,
): string | undefined {
  const oldPath = headerPath(cwd, change.path);
  if (supplied.kind === "update") {
    if (!supplied.unified || supplied.hunks.length === 0) return undefined;
    if (!supplied.hunks.startsWith("@@")) return supplied.hunks;
    const newPath = headerPath(cwd, supplied.movePath ?? change.path);
    return `--- a/${oldPath}\n+++ b/${newPath}\n${supplied.hunks}`;
  }
  const { lines, finalNewline } = contentLines(supplied.content);
  if (lines.length === 0) return undefined;
  const sign = supplied.kind === "add" ? "+" : "-";
  const header =
    supplied.kind === "add"
      ? `--- /dev/null\n+++ b/${oldPath}\n@@ -0,0 +1,${lines.length} @@`
      : `--- a/${oldPath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@`;
  const body = lines.map((line) => `${sign}${line}`);
  if (!finalNewline) body.push("\\ No newline at end of file");
  return [header, ...body].join("\n");
}

/** Absolute location of a change's path, for `toolDiff.filePath`. */
export function resolvedChangePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

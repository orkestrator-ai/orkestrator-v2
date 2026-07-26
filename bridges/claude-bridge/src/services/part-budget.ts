/**
 * Memory budget for the normalized parts a session retains.
 *
 * `session.messages` is the authoritative transcript and is never trimmed —
 * dropping messages would break the rehydration contract the UI depends on.
 * What *is* bounded is how much any single part may carry, because two fields
 * are unbounded by construction:
 *
 *   toolDiff.after  — for `Write`, the entire file being written
 *   toolOutput      — whatever the tool returned, including MCP results
 *
 * A session that writes a handful of large files therefore holds those files
 * in memory for as long as it lives, and re-serializes them into every SSE
 * frame that carries the part.
 *
 * The caps are deliberately generous: Claude Code's own tools already truncate
 * (Bash output, Read line counts), so anything hitting these limits is a
 * payload nobody was going to read in full anyway. Normal turns are untouched.
 */
import type { ToolDiffMetadata } from "../types/index.js";

/** Per-field cap for tool output and error text. */
export const MAX_TOOL_TEXT_BYTES = 1024 * 1024;

/** Per-field cap for the before/after sides of an edit. */
export const MAX_DIFF_SIDE_BYTES = 512 * 1024;

export const TRUNCATED_NOTICE = "\n… truncated (payload too large to retain)";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Truncate to a byte budget without splitting a UTF-8 sequence.
 *
 * Slicing by code units and hoping is how you get a lone surrogate in the
 * middle of a JSON frame, so the cut is made on the encoded buffer and any
 * partial trailing character is dropped by the lossy decode.
 */
function capText(value: string | undefined, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (byteLength(value) <= maxBytes) return value;

  // Keep the head: for output and for file content alike, the beginning is
  // what carries the meaning.
  const head = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  // A lossy decode of a split sequence yields U+FFFD at the tail; drop it so
  // the transcript does not gain a replacement character it never had.
  const trimmed = head.endsWith("�") ? head.slice(0, -1) : head;
  return `${trimmed}${TRUNCATED_NOTICE}`;
}

/** Bound the before/after sides of an edit, leaving the file path intact. */
export function applyDiffBudget(
  metadata: ToolDiffMetadata | undefined,
): ToolDiffMetadata | undefined {
  if (!metadata) return metadata;

  const before = capText(metadata.before, MAX_DIFF_SIDE_BYTES);
  const after = capText(metadata.after, MAX_DIFF_SIDE_BYTES);
  if (before === metadata.before && after === metadata.after) return metadata;

  return { ...metadata, before, after };
}

/** Bound the text a completed tool result contributes to the transcript. */
export function applyToolResultBudget(result: {
  output?: string;
  error?: string;
}): { output?: string; error?: string } {
  return {
    output: capText(result.output, MAX_TOOL_TEXT_BYTES),
    error: capText(result.error, MAX_TOOL_TEXT_BYTES),
  };
}

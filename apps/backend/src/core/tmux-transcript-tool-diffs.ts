import { filePathFromToolInput, toolDiffFromToolInput } from "@orkestrator/protocol/tool-diff";

/** Diff sides for one transcript tool call: path and payload sides, never counts. */
export interface TranscriptToolDiff {
  filePath?: string;
  before?: string;
  after?: string;
}

/** Tools whose input is whole-file content: the file's prior state is not in the payload. */
const WRITE_LIKE_TOOL_NAMES = new Set(["write", "create_file"]);

/**
 * Map each `tool_use` block on a Claude Code transcript line to the diff
 * sides its input carries, keyed by tool use id, so the tmux renderer never
 * interprets provider tool names or inputs itself (the backend is the
 * adapter for transcripts it reads).
 *
 * Sides and path only: line counts are a backend measurement of these sides
 * (docs/architecture/change-tracking.md). A write-like tool's prior file
 * state is unknown (absent), never an empty file. A tool this mapping does
 * not recognise still surfaces the path it touched.
 */
export function transcriptToolDiffs(line: unknown): Record<string, TranscriptToolDiff> | null {
  if (!line || typeof line !== "object") return null;
  const record = line as { message?: { content?: unknown }; content?: unknown };
  const content = record.message?.content ?? record.content;
  if (!Array.isArray(content)) return null;
  let result: Record<string, TranscriptToolDiff> | null = null;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const { type, id, name, input } = block as {
      type?: unknown;
      id?: unknown;
      name?: unknown;
      input?: unknown;
    };
    if (type !== "tool_use" || typeof id !== "string") continue;
    const toolName = typeof name === "string" ? name : undefined;
    const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const diff = toolDiffFor(toolName, args);
    if (!diff) continue;
    result ??= {};
    result[id] = diff;
  }
  return result;
}

function toolDiffFor(
  toolName: string | undefined,
  input: Record<string, unknown>,
): TranscriptToolDiff | undefined {
  const sides = toolDiffFromToolInput(toolName, input);
  if (sides) {
    const writeLike = WRITE_LIKE_TOOL_NAMES.has(toolName?.toLowerCase() ?? "");
    const before = writeLike ? undefined : sides.before;
    return {
      ...(sides.filePath !== undefined ? { filePath: sides.filePath } : {}),
      ...(before !== undefined ? { before } : {}),
      ...(sides.after !== undefined ? { after: sides.after } : {}),
    };
  }
  const filePath = filePathFromToolInput(input);
  return filePath ? { filePath } : undefined;
}

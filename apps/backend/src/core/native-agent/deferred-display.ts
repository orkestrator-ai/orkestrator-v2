/**
 * Which display-only bodies a projected row carries as a preview, with the
 * whole value behind a detail reference fetched when the row is expanded.
 *
 * Tool output, errors and diffs are always deferred (`projectionPart`). This
 * covers the other bulk a collapsed row never shows: the file contents and
 * replacement strings in a settled tool call's input, and finished reasoning,
 * so a session that writes large files does not fill a byte-bounded page
 * with bodies nobody has expanded.
 *
 * Only values the collapsed row does not read are deferred: header fields
 * (`command`, `file_path`, `pattern`, `description`), agent prompts, mail
 * bodies, plan text and task lists stay inline, because their cards draw them
 * without being expanded.
 */
import { isPlanMarkdownPath } from "@orkestrator/protocol/agent-interactions";

/** Values up to this many UTF-8 bytes stay inline: a reference would cost about as much. */
export const NATIVE_DEFERRED_DISPLAY_MIN_BYTES = 1024;
/** Characters of deferred reasoning kept inline: the collapsed row's whole preview. */
export const NATIVE_DEFERRED_THINKING_PREVIEW_CHARS = 400;
/** Characters of a deferred tool input value kept inline; no collapsed row shows them. */
export const NATIVE_DEFERRED_TOOL_ARG_PREVIEW_CHARS = 200;

/**
 * Top-level tool input fields that hold file contents or replacement text
 * across providers (Claude, Codex, OpenCode, Cursor, Pi, ACP).
 */
const DEFERRABLE_TOOL_ARG_FIELDS: ReadonlySet<string> = new Set([
  "content",
  "contents",
  "file_text",
  "fileText",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "oldText",
  "newText",
  "new_source",
]);

const PATH_ARG_FIELDS = ["file_path", "filePath", "path"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function heavy(value: unknown): value is string {
  // Byte length is at least the UTF-16 length, so short strings skip the encode.
  if (typeof value !== "string") return false;
  if (value.length * 3 <= NATIVE_DEFERRED_DISPLAY_MIN_BYTES) return false;
  if (value.length > NATIVE_DEFERRED_DISPLAY_MIN_BYTES) return true;
  return Buffer.byteLength(value) > NATIVE_DEFERRED_DISPLAY_MIN_BYTES;
}

/** The start of `value`, never splitting a surrogate pair, marked as cut. */
export function deferredDisplayPreview(value: string, chars: number): string {
  if (value.length <= chars) return value;
  let end = chars;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}…`;
}

/**
 * The input a collapsed tool row is sent, or undefined when nothing in it is
 * deferred. A call still running keeps its whole input: providers stream it,
 * and a reference minted for a partial value would be stale at once. A plan
 * file write keeps its contents, which the plan approval card reads directly.
 */
export function deferredToolArgsPreview(
  part: Record<string, unknown>,
  args: unknown,
): Record<string, unknown> | undefined {
  if (part.type !== "tool-invocation") return undefined;
  if (part.toolState !== "success" && part.toolState !== "failure") return undefined;
  if (!isRecord(args)) return undefined;
  if (PATH_ARG_FIELDS.some((key) => typeof args[key] === "string" && isPlanMarkdownPath(args[key])))
    return undefined;
  let preview: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(args)) {
    if (!DEFERRABLE_TOOL_ARG_FIELDS.has(key) || !heavy(value)) continue;
    preview ??= { ...args };
    preview[key] = deferredDisplayPreview(value, NATIVE_DEFERRED_TOOL_ARG_PREVIEW_CHARS);
  }
  return preview;
}

/**
 * The preview a reasoning part is sent, or undefined when it stays whole.
 * Only reasoning the row has moved past is deferred (`settled`): a later part
 * in the same model response means the reasoning stopped streaming.
 */
export function deferredThinkingPreview(
  part: Record<string, unknown>,
  settled: boolean,
): string | undefined {
  if (!settled || part.type !== "thinking" || !heavy(part.content)) return undefined;
  return deferredDisplayPreview(part.content, NATIVE_DEFERRED_THINKING_PREVIEW_CHARS);
}

/**
 * How the native projection treats a file or image part's inline data URL.
 *
 * A leaf module on purpose: OpenCode's window estimate (`opencode-snapshots.ts`)
 * has to predict a row's projected size with the very rule `projectionPart`
 * applies, and the projection's shared module sits above the providers.
 */

/**
 * Ceiling for a deferred inline image's data URL.
 *
 * An attachment is capped at 8 MiB decoded, which is roughly 10.7 MiB once
 * base64 encoded, so this covers every image the composer can produce with
 * headroom for the JSON envelope. It is deliberately larger than the tool
 * detail cap: a tool result is one row among many, whereas an image is content
 * the user explicitly attached and expects to see.
 */
export const NATIVE_FILE_DETAIL_MAX_BYTES = 16 * 1024 * 1024;

/**
 * What the native projection does with a file or image part's inline data URL
 * (`projectionPart`): `drop` it when the part also names a readable path,
 * `defer` an image that fits the detail cache behind a reference, and keep any
 * other payload `inline`. Undefined when the part has no inline data URL.
 *
 * A window estimate that has to predict a row's projected size (OpenCode's)
 * reads the same rule, so the two cannot disagree about which bytes stay on
 * screen: an estimate that assumed a PDF was deferred let the projection drop
 * the head of a window whose provider cursor then named nothing on screen.
 */
export function inlineFileUrlDisposition(
  part: Record<string, unknown>,
): "drop" | "defer" | "inline" | undefined {
  if (part.type !== "file" && part.type !== "image") return undefined;
  const url = part.fileUrl;
  if (typeof url !== "string" || !url.startsWith("data:")) return undefined;
  const content = typeof part.content === "string" ? part.content : "";
  if (content.startsWith("/") || content.startsWith("file://") || /^[A-Za-z]:[\\/]/.test(content)) {
    return "drop";
  }
  return url.startsWith("data:image/") &&
    Buffer.byteLength(url) <= NATIVE_FILE_DETAIL_MAX_BYTES - 256
    ? "defer"
    : "inline";
}

/**
 * The display name the projection substitutes when a part with an inline data
 * URL also carries it as `content` (OpenCode falls back to the URL when an
 * attachment has no filename). Undefined when `content` is kept.
 */
export function inlineFileContentLabel(part: Record<string, unknown>): string | undefined {
  if (inlineFileUrlDisposition(part) === undefined) return undefined;
  if (typeof part.content !== "string" || !part.content.startsWith("data:")) return undefined;
  const filename = typeof part.filename === "string" ? part.filename.trim() : "";
  return filename || (part.type === "image" ? "image" : "Attached file");
}

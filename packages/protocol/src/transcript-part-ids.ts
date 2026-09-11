/**
 * Identifiers a bridge stamps on the transcript parts it synthesizes.
 *
 * A bridge that returns the bytes of an image a tool looked at emits a
 * first-class `image` part beside the tool call that produced it. The renderer
 * recovers a preview for every other platform from the read's path argument,
 * and has to recognise the calls that already carry one so the same picture is
 * not shown twice.
 *
 * The link between the two is this identifier, so the format lives here rather
 * than being built in a bridge and re-parsed by a regular expression in the
 * web app. Drifting the two apart silently produced duplicate previews.
 */

const TOOL_RESULT_IMAGE_PREFIX = "image:";

/**
 * The `sourcePartId` for the `index`-th image a tool call returned.
 *
 * The index is part of the key because one call can return several images, and
 * a bridge may re-emit a settled call: keying on the pair lets the append be
 * skipped instead of duplicating the part.
 */
export function toolResultImagePartId(toolUseId: string, index: number): string {
  return `${TOOL_RESULT_IMAGE_PREFIX}${toolUseId}:${index}`;
}

/**
 * The tool call a `toolResultImagePartId` refers to, or `null`.
 *
 * The tool call id may itself contain colons, so the trailing index is taken
 * from the end rather than splitting the whole string.
 */
export function toolUseIdFromImagePartId(sourcePartId: string | undefined): string | null {
  if (!sourcePartId?.startsWith(TOOL_RESULT_IMAGE_PREFIX)) return null;
  const body = sourcePartId.slice(TOOL_RESULT_IMAGE_PREFIX.length);
  const lastColon = body.lastIndexOf(":");
  if (lastColon <= 0) return null;
  if (!/^\d+$/.test(body.slice(lastColon + 1))) return null;
  return body.slice(0, lastColon);
}

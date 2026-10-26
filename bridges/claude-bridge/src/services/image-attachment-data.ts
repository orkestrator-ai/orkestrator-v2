export const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Matches the renderer's final image-attachment policy. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export function decodedBase64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function parseBase64ImageData(
  value: string,
): { data: string; mediaType?: "image/jpeg" | "image/png" | "image/gif" | "image/webp" } | null {
  let data = value;
  let mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | undefined;

  if (value.startsWith("data:")) {
    const match = /^data:([^;,]+);base64,([\s\S]+)$/.exec(value);
    if (!match || !SUPPORTED_IMAGE_MEDIA_TYPES.has(match[1])) {
      return null;
    }
    mediaType = match[1] as typeof mediaType;
    data = match[2];
  }

  const normalized = data.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) ||
    decodedBase64ByteLength(normalized) > MAX_IMAGE_ATTACHMENT_BYTES
  ) {
    return null;
  }

  return { data: normalized, mediaType };
}

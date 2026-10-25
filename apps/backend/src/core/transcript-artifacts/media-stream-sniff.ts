/**
 * Media type identification for streamed transcript media, from the bytes
 * only. A file name never decides what is served: an HTML file named `.mp4`
 * sniffs as nothing and is refused. Only audio, video and raster image
 * containers the shipped engines can play or decode are recognised; SVG,
 * HTML, PDF and everything else return null.
 */

/** Leading bytes the sniffer needs (Matroska's DocType sits within the EBML header). */
export const MEDIA_SNIFF_BYTES = 4096;

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (offset + signature.length > bytes.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function contains(bytes: Uint8Array, text: string, limit: number): boolean {
  const end = Math.min(bytes.length, limit) - text.length;
  for (let offset = 0; offset <= end; offset++) {
    if (ascii(bytes, offset, text)) return true;
  }
  return false;
}

/** ISO base media (`ftyp` box): MP4, M4A, QuickTime, AVIF. */
function sniffIsoBmff(bytes: Uint8Array): string | null {
  if (!ascii(bytes, 4, "ftyp") || bytes.length < 12) return null;
  const boxSize = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  if (boxSize < 8) return null;
  const brand = String.fromCharCode(...bytes.subarray(8, 12));
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (brand === "M4A " || brand === "M4B ") return "audio/mp4";
  if (brand === "qt  ") return "video/quicktime";
  // HEIF stills are not decodable in Chromium; refuse rather than mislabel.
  if (["heic", "heix", "heim", "heis", "mif1", "msf1"].includes(brand)) return null;
  return /^[\x20-\x7e]{4}$/.test(brand) ? "video/mp4" : null;
}

/** MPEG audio frame or ADTS AAC header at offset 0. */
function sniffMpegAudio(bytes: Uint8Array): string | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || (bytes[1]! & 0xe0) !== 0xe0) return null;
  const layer = (bytes[1]! >> 1) & 0x03;
  if (layer === 0) {
    // ADTS: syncword 0xFFF, layer 00, sampling index 0..12.
    return (bytes[1]! & 0xf6) === 0xf0 && ((bytes[2]! >> 2) & 0x0f) <= 12 ? "audio/aac" : null;
  }
  const version = (bytes[1]! >> 3) & 0x03;
  const bitrate = bytes[2]! >> 4;
  const sampleRate = (bytes[2]! >> 2) & 0x03;
  if (version === 1 || bitrate === 0x0f || sampleRate === 0x03) return null;
  return "audio/mpeg";
}

/**
 * The served MIME type of the leading bytes, or null when they are not a
 * recognised audio, video or raster image container.
 */
export function sniffServedMediaMime(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (
    ascii(bytes, 0, "BM") &&
    bytes.length >= 18 &&
    [12, 40, 52, 56, 108, 124].includes(
      bytes[14]! | (bytes[15]! << 8) | (bytes[16]! << 16) | (bytes[17]! << 24),
    )
  ) {
    return "image/bmp";
  }
  const iso = sniffIsoBmff(bytes);
  if (iso) return iso;
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    if (contains(bytes, "webm", 64)) return "video/webm";
    if (contains(bytes, "matroska", 64)) return "video/x-matroska";
    return null;
  }
  if (ascii(bytes, 0, "OggS")) {
    return contains(bytes, "\u0080theora", 512) ? "video/ogg" : "audio/ogg";
  }
  if (ascii(bytes, 0, "fLaC")) return "audio/flac";
  if (ascii(bytes, 0, "ID3")) return "audio/mpeg";
  return sniffMpegAudio(bytes);
}

/** Whether a sniffed type may be served on the content origin at all. */
export function isServedMediaMime(mimeType: string): boolean {
  return (
    (mimeType.startsWith("audio/") ||
      mimeType.startsWith("video/") ||
      mimeType.startsWith("image/")) &&
    mimeType !== "image/svg+xml"
  );
}

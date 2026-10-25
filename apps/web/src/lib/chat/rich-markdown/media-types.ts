/**
 * MIME identification and preview routing for transcript media and files.
 *
 * The preview route comes from trusted metadata (the declared type of a data
 * URL, else the file extension) and is checked against a safe inspection of
 * the first bytes once they are loaded. A mismatch becomes an
 * unsupported-preview state with download only. A file extension never
 * starts execution: HTML is shown as source, SVG only as an image resource.
 */

export type FilePreviewKind =
  | "image"
  | "svg"
  | "video"
  | "audio"
  | "pdf"
  | "markdown"
  | "json"
  | "csv"
  | "tsv"
  | "html"
  | "text"
  | "other";

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  pdf: "application/pdf",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  log: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  js: "text/plain",
  jsx: "text/plain",
  mjs: "text/plain",
  cjs: "text/plain",
  py: "text/plain",
  rs: "text/plain",
  go: "text/plain",
  java: "text/plain",
  sql: "text/plain",
  sh: "text/plain",
  bash: "text/plain",
  zsh: "text/plain",
  yaml: "text/plain",
  yml: "text/plain",
  toml: "text/plain",
  css: "text/plain",
  xml: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
  c: "text/plain",
  h: "text/plain",
  cpp: "text/plain",
  rb: "text/plain",
  swift: "text/plain",
  kt: "text/plain",
};

export function fileExtension(path: string): string {
  const name = path.split("?")[0]?.split("#")[0]?.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The declared MIME type of a data URL, if any. */
export function dataUrlMime(url: string | undefined): string | null {
  const match = url ? /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)[;,]/i.exec(url) : null;
  return match ? match[1]!.toLowerCase() : null;
}

/** MIME from trusted metadata: a data URL's declared type, else the extension. */
export function declaredMime(path: string, fileUrl?: string): string {
  return dataUrlMime(fileUrl) ?? EXTENSION_MIME[fileExtension(path)] ?? "application/octet-stream";
}

export function previewKindForMime(mime: string): FilePreviewKind {
  if (mime === "image/svg+xml") return "svg";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "markdown";
  if (mime === "application/json" || mime === "application/x-ndjson") return "json";
  if (mime === "text/csv") return "csv";
  if (mime === "text/tab-separated-values") return "tsv";
  if (mime === "text/html") return "html";
  if (mime.startsWith("text/")) return "text";
  return "other";
}

/** Sniffed family of the leading bytes, or null when not recognisable. */
export function sniffFamily(
  bytes: Uint8Array,
): "image" | "video" | "audio" | "pdf" | "binary" | "text" | null {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string) =>
    Array.from(text).every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  if (bytes.length === 0) return null;
  if (starts(0x89, 0x50, 0x4e, 0x47) || starts(0xff, 0xd8, 0xff) || ascii(0, "GIF8"))
    return "image";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image";
  if (ascii(4, "ftypavif") || ascii(4, "ftypheic")) return "image";
  if (starts(0x42, 0x4d) || starts(0x00, 0x00, 0x01, 0x00)) return "image";
  if (ascii(0, "%PDF-")) return "pdf";
  if (ascii(4, "ftyp")) return "video";
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return "video";
  if (
    ascii(0, "ID3") ||
    starts(0xff, 0xfb) ||
    starts(0xff, 0xf3) ||
    ascii(0, "fLaC") ||
    ascii(0, "OggS")
  ) {
    return "audio";
  }
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio";
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return "binary";
  return "text";
}

/**
 * Whether loaded bytes agree with the declared preview kind. Text kinds must
 * not be binary; media kinds must sniff as their own family (an unrecognised
 * header is tolerated for formats this sniffer does not know).
 */
export function bytesMatchPreviewKind(kind: FilePreviewKind, bytes: Uint8Array): boolean {
  const family = sniffFamily(bytes);
  switch (kind) {
    case "image":
      return family === "image" || family === null || family === "binary";
    case "svg":
      return family === "text";
    case "video":
      return family === "video" || family === "binary" || family === null;
    case "audio":
      return family === "audio" || family === "binary" || family === "video" || family === null;
    case "pdf":
      return family === "pdf";
    case "markdown":
    case "json":
    case "csv":
    case "tsv":
    case "html":
    case "text":
      return family === "text" || family === null;
    default:
      return true;
  }
}

/** Intrinsic dimensions from PNG/GIF/JPEG headers, without decoding pixels. */
export function imageDimensionsFromBytes(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const limit = Math.min(bytes.length, 512 * 1024);
    while (offset + 9 < limit) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      const length = view.getUint16(offset + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

export function base64Prefix(base64: string, byteCount: number): Uint8Array {
  const characters = Math.ceil(byteCount / 3) * 4;
  const binary = atob(base64.slice(0, characters).replace(/=+$/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Base64 payload of a data URL. */
export function dataUrlBase64(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(dataUrl.slice(0, comma))) return null;
  return dataUrl.slice(comma + 1);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Decoded size of a base64 payload. */
export function base64ByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

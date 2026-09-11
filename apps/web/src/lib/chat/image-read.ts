import { isReadTool } from "@/lib/tool-names";

/**
 * Extensions the shared image tile can preview.
 *
 * Kept in step with `FilePart`'s heuristic so a Read of `shot.avif` is treated
 * the same way a first-class image part of that file would be.
 */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "bmp",
  "ico",
  "tif",
  "tiff",
]);

const PATH_ARG_KEYS = ["file_path", "filePath", "path", "target_file", "file"] as const;

export interface ImageRead {
  /** Path the container-aware reader should open. */
  path: string;
  /** Basename shown on the tile. */
  filename: string;
  /** Same path, or the URL form when the argument already was one. */
  fileUrl: string;
}

/**
 * A file-read tool whose argument names an image.
 *
 * Codex already emits a first-class `image` part for `imageView`. Every other
 * platform reports the same action as a generic Read with a path, which is why
 * the renderer recovers the preview here rather than waiting for each bridge
 * to grow its own `imageView`.
 */
export function imageReadFromToolPart(part: {
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolTitle?: string;
  toolState?: string;
}): ImageRead | null {
  // An allowlist, not a denylist: a transcript whose stored state could not be
  // recognised arrives here as `undefined`, and a read whose outcome is unknown
  // must not open the file behind the user's back.
  if (!isReadTool(part.toolName) || part.toolState !== "success") {
    return null;
  }

  const path = readToolImagePath(part.toolArgs) ?? imagePathFromTitle(part.toolTitle);
  if (!path) return null;

  const filename = path.split(/[?#]/)[0]?.split(/[\\/]/).pop() || path;
  return { path, filename, fileUrl: path };
}

function readToolImagePath(args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  for (const key of PATH_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && looksLikeImagePath(value.trim())) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Cursor (and some ACP titles) put the path in `toolTitle` when arguments were
 * stripped. A display title like `Read screenshot.png` is not a path: it has
 * a space and no separator, so it stays a title.
 */
function imagePathFromTitle(title?: string): string | undefined {
  const trimmed = title?.trim();
  if (!trimmed || !looksLikeFilePath(trimmed) || !isImageFilePath(trimmed)) return undefined;
  return trimmed;
}

function looksLikeImagePath(value: string): boolean {
  return value.length > 0 && looksLikeFilePath(value) && isImageFilePath(value);
}

function looksLikeFilePath(value: string): boolean {
  if (/^(?:file|data|https?):/i.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.includes("/") || value.includes("\\")) return true;
  return !/\s/.test(value);
}

export function isImageFilePath(path: string): boolean {
  const clean = path.split(/[?#]/)[0] ?? path;
  const base = clean.split(/[\\/]/).pop() ?? clean;
  const lastDot = base.lastIndexOf(".");
  if (lastDot <= 0) return false;
  return IMAGE_EXTENSIONS.has(base.slice(lastDot + 1).toLowerCase());
}

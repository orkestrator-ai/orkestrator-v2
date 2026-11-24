/**
 * Files hosted by Linear (docs/architecture/tickets.md, "Linear files").
 *
 * A file added to a Linear issue is a link to `uploads.linear.app` in the
 * issue's Markdown, and that host answers 401 without the workspace's key.
 * This module only recognises such links. The backend, which holds the key,
 * reads them (`apps/backend/src/core/linear-files/`).
 *
 * Browser-safe.
 */

export const LINEAR_FILE_HOST = "uploads.linear.app";

/** The agent tool that downloads an issue's files into the caller's workspace. */
export const LINEAR_FILE_TOOL_NAME = "download_linear_files";

/** Where downloaded files go in a workspace; `.orkestrator` is Git-excluded. */
export const LINEAR_FILES_DIRECTORY = ".orkestrator/linear-files";

/** The most files downloaded in one agent batch. */
export const MAX_LINEAR_ISSUE_FILES = 50;

/** One file an issue links to. `url` never carries a signature. */
export interface LinearFileReference {
  url: string;
  /** The link's own text, which Linear sets to the file's name. */
  name?: string;
}

/**
 * The canonical form of a Linear file link: no query (so no signature) and no
 * fragment. Null for anything that is not a file on Linear's own host.
 */
export function linearFileUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== LINEAR_FILE_HOST) return null;
  if (url.port || url.username || url.password || url.pathname.length < 2) return null;
  return `https://${LINEAR_FILE_HOST}${url.pathname}`;
}

/** The final URL segment, decoded for display or for a confined filename. */
export function linearFilePathSegment(url: string): string {
  const segment = URL.parse(url)?.pathname.split("/").filter(Boolean).at(-1) ?? "";
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// A file link, and the Markdown link or image label before it when it has one.
// The label is bounded, so text full of brackets stays linear to scan.
const FILE_LINK =
  /(?:\[((?:\\.|[^[\]\\\n]){0,300})\]\(\s{0,4})?(<?)(https:\/\/uploads\.linear\.app(?::\d+)?\/)/gi;

/** Finds both forms of each link using the same Markdown boundaries. */
export function* linearFileLinks(text: string) {
  const starts = new RegExp(FILE_LINK);
  for (let match = starts.exec(text); match; match = starts.exec(text)) {
    const start = starts.lastIndex;
    const offset = start - match[3]!.length;
    const angled = match[2] === "<";
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      const character = text[end]!;
      if (/[\s<>]/.test(character)) break;
      if (angled) continue;
      if (character === "\\" && match[1] !== undefined && /[()]/.test(text[end + 1] ?? "")) {
        end += 1;
        continue;
      }
      if (/[[\]"'`\\]/.test(character)) break;
      if (character === "(") depth += 1;
      if (character === ")" && depth-- === 0) break;
    }
    starts.lastIndex = end;
    let raw = text.slice(offset, end);
    if (match[1] === undefined && !angled) {
      raw = raw.replace(/[.,;:!?*~|]+$/, "");
      const before = text.slice(Math.max(0, offset - 2), offset);
      const emphasis = before.endsWith("__") ? "__" : before.endsWith("_") ? "_" : "";
      if (emphasis && raw.endsWith(emphasis)) raw = raw.slice(0, -emphasis.length);
    }
    const link = raw.replace(/\\([()])/g, "$1");
    const url = linearFileUrl(link);
    if (!url) continue;
    const name = match[1]?.replace(/\\(.)/g, "$1").trim();
    yield { url, link, name, offset, length: raw.length };
  }
}

/** Strips credentials from Linear file links while preserving the Markdown. */
export function unsignedLinearFileMarkdown(text: string): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const { link, offset, length } of linearFileLinks(text)) {
    if (!link.includes("?") && !link.includes("#")) continue;
    parts.push(
      text.slice(cursor, offset),
      text.slice(offset, offset + length).split(/[?#]/, 1)[0]!,
    );
    cursor = offset + length;
  }
  return cursor === 0 ? text : parts.join("") + text.slice(cursor);
}

/** The Linear files a Markdown text links to, each once, in order. */
export function linearFileReferences(text: string): LinearFileReference[] {
  const found = new Map<string, LinearFileReference>();
  for (const { url, name } of linearFileLinks(text)) {
    const known = found.get(url);
    if (known) {
      if (!known.name && name) known.name = name;
    } else {
      found.set(url, { url, ...(name ? { name } : {}) });
    }
  }
  return Array.from(found.values());
}

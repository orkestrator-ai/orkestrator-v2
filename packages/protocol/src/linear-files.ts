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

/** The most files read from one issue. */
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

// A file link, and the Markdown link or image label before it when it has one.
// The label is bounded, so text full of brackets stays linear to scan.
const FILE_LINK =
  /(?:\[((?:\\.|[^[\]\\\n]){0,300})\]\(\s{0,4}<?)?(https:\/\/uploads\.linear\.app\/[^\s<>()[\]"'`\\]+)/gi;

/** The Linear files a Markdown text links to, each once, in order. */
export function linearFileReferences(text: string): LinearFileReference[] {
  const found = new Map<string, LinearFileReference>();
  for (const match of text.matchAll(FILE_LINK)) {
    const url = linearFileUrl(match[2]!.replace(/[.,;:!?*_~|]+$/, ""));
    if (!url) continue;
    const name = match[1]?.replace(/\\(.)/g, "$1").trim();
    const known = found.get(url);
    if (known) {
      if (!known.name && name) known.name = name;
    } else if (found.size < MAX_LINEAR_ISSUE_FILES) {
      found.set(url, { url, ...(name ? { name } : {}) });
    }
  }
  return Array.from(found.values());
}

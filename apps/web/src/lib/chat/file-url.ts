/**
 * Decode a `file://` URL into the local path it addresses.
 *
 * Shared by the renderer's attachment preview, which needs a readable path to
 * hand the backend, and by attachment de-duplication, which has to recognise
 * that `file:///workspace/a.png` and `/workspace/a.png` name the same file.
 * Returns `null` for anything that is not a parseable `file://` URL so callers
 * can fall back to the raw reference.
 */
export function parseLocalFilePathFromUrl(fileUrl: string): string | null {
  if (!fileUrl.startsWith("file://")) return null;

  try {
    const parsed = new URL(fileUrl);
    const pathname = decodeURIComponent(parsed.pathname);

    // UNC paths (e.g. file://server/share/path)
    if (parsed.host) {
      return `//${parsed.host}${pathname}`;
    }

    // Windows absolute paths are represented as /C:/path in file URLs.
    if (/^\/[a-z]:\//i.test(pathname)) {
      return pathname.slice(1);
    }

    return pathname;
  } catch {
    return null;
  }
}

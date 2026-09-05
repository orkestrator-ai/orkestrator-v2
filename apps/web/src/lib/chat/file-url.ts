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
  if (!/^file:\/\//i.test(fileUrl)) return null;

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

export interface LocalFileLinkTarget {
  filePath: string;
  lineNumber?: number;
  columnNumber?: number;
}

function positiveSafeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseColonLocation(reference: string): LocalFileLinkTarget | null {
  const lineAndColumnLocation = reference.match(/^(.*):(\d+):(\d+)$/s);
  const lineOnlyLocation = lineAndColumnLocation ? null : reference.match(/^(.*):(\d+)$/s);
  const location = lineAndColumnLocation ?? lineOnlyLocation;
  const lineNumber = positiveSafeInteger(location?.[2]);
  if (!location?.[1] || !lineNumber) return null;

  const columnNumber = positiveSafeInteger(lineAndColumnLocation?.[3]);
  return {
    filePath: location[1],
    lineNumber,
    ...(columnNumber !== undefined ? { columnNumber } : {}),
  };
}

/**
 * Parse the location formats coding agents commonly put in Markdown links.
 *
 * Both `path/to/file.ts:12:4` and `path/to/file.ts#L12C4` address line 12,
 * column 4. A line range fragment is accepted too, with navigation targeting
 * the range's first line. The location is deliberately removed before the
 * path reaches the backend so it can never become part of an `lstat` target.
 */
export function parseLocalFileLinkTarget(destination: string): LocalFileLinkTarget | null {
  const trimmed = destination.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

  const fragmentLocation = trimmed.match(/#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?$/i);
  const reference = fragmentLocation ? trimmed.slice(0, fragmentLocation.index) : trimmed;
  if (/^(?:javascript|vbscript|data):/i.test(reference)) return null;
  const colonLocation = parseColonLocation(reference);
  const pathReference = colonLocation?.filePath ?? reference;

  let filePath: string | null;
  if (/^file:/i.test(pathReference)) {
    filePath = parseLocalFilePathFromUrl(pathReference);
  } else {
    // A Windows drive prefix is a path, not a URI scheme.
    if (!/^[A-Za-z]:[\\/]/.test(pathReference) && /^[A-Za-z][A-Za-z\d+.-]*:/.test(pathReference)) {
      return null;
    }

    try {
      filePath = decodeURIComponent(pathReference);
    } catch {
      filePath = pathReference;
    }
  }

  if (!filePath) return null;

  const fragmentLine = positiveSafeInteger(fragmentLocation?.[1]);
  if (fragmentLine) {
    const columnNumber = positiveSafeInteger(fragmentLocation?.[2]);
    return {
      filePath,
      lineNumber: fragmentLine,
      ...(columnNumber !== undefined ? { columnNumber } : {}),
    };
  }

  if (!colonLocation) return { filePath };
  return { ...colonLocation, filePath };
}

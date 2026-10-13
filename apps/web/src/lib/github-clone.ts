/** Comparable `host/owner/name` form of a remote, ignoring protocol and `.git`. */
export function normalizeGitHubRemote(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d)/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function pathSeparator(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

/** Joins a directory and a child name using the directory's own separator. */
export function joinHostPath(directory: string, name: string): string {
  const separator = pathSeparator(directory);
  const trimmed = directory.replace(/[\\/]+$/, "");
  return `${trimmed || separator}${trimmed ? separator : ""}${name}`;
}

export function parentDirectory(path: string): string | null {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

/**
 * The folder most existing projects live in, used to pre-fill where a new
 * clone goes. Ties go to the folder seen first.
 */
export function suggestedCloneDirectory(
  localPaths: ReadonlyArray<string | null | undefined>,
): string | undefined {
  const counts = new Map<string, number>();
  let best: { directory: string; count: number } | undefined;
  for (const localPath of localPaths) {
    if (!localPath?.trim()) continue;
    const directory = parentDirectory(localPath);
    if (!directory) continue;
    const count = (counts.get(directory) ?? 0) + 1;
    counts.set(directory, count);
    if (!best || count > best.count) best = { directory, count };
  }
  return best?.directory;
}

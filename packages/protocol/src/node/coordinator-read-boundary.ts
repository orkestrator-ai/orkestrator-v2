import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/**
 * What a coordinator's turn may not read, however it asks: the backend's data
 * directory, with an allowance carved back out for what the turn is meant to
 * read. Shared by every bridge whose own gate sees a reading tool's path.
 *
 * The data directory holds the Control MCP operator credentials
 * (`control-mcp.json`), the provider secrets (`config.json` and its backups),
 * the database and every account's login. A coordinator runs as the same user,
 * so nothing but a check like this stops a read. The whole directory is denied
 * rather than a list of files, because a list goes stale silently whenever a
 * store adds a secret, while a missing allowance fails loudly.
 */
export interface ReadBoundary {
  deny: string[];
  allow: string[];
}

/** The path as the filesystem resolves it, with any not-yet-existing tail kept. */
export function canonicalPath(path: string): string {
  let existing = path;
  const tail: string[] = [];
  for (;;) {
    try {
      // `native` also settles letter case on a case-insensitive volume.
      return join(realpathSync.native(existing), ...tail.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path;
      tail.push(existing.slice(parent.length).replace(/^[/\\]+/, ""));
      existing = parent;
    }
  }
}

/** Every absolute path as named and as resolved, since a link and its target are one file. */
export function namedAndCanonicalPaths(paths: readonly (string | undefined)[]): string[] {
  const named = paths.flatMap((path) => (path?.trim() && isAbsolute(path) ? [path] : []));
  return [...new Set(named.flatMap((path) => [resolve(path), canonicalPath(path)]))];
}

function isWithin(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root === parse(root).root ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}

/**
 * The boundary for a protected data directory, or null when none is named.
 * Only allowances strictly inside the directory are kept: a checkout above it
 * must not re-open the whole directory, since an allowance wins over a denial.
 */
export function protectedDataDirBoundary(
  dataDir: string | undefined,
  allowances: readonly (string | undefined)[],
): ReadBoundary | null {
  const trimmed = dataDir?.trim();
  if (!trimmed || !isAbsolute(trimmed)) return null;
  const deny = namedAndCanonicalPaths([trimmed]);
  return {
    deny,
    allow: namedAndCanonicalPaths(allowances).filter(
      (path) => !deny.includes(path) && deny.some((root) => isWithin(root, path)),
    ),
  };
}

function deniedForm(boundary: ReadBoundary, path: string): boolean {
  return (
    boundary.deny.some((root) => isWithin(root, path)) &&
    !boundary.allow.some((root) => isWithin(root, path))
  );
}

function expandedHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? `${homedir()}${sep}${path.slice(2)}` : path;
}

/**
 * Whether reading `path` reaches a denied file. Both spellings have to pass: a
 * link inside an allowed directory can point into a denied one, and the other
 * way round. `traversal` is for a search or listing: one rooted above the
 * denied directory would walk into it.
 */
export function readBoundaryRefuses(
  boundary: ReadBoundary,
  path: string,
  cwd: string,
  options: { traversal?: boolean } = {},
): boolean {
  const expanded = expandedHome(path);
  // Preserve symlink/.. traversal for the filesystem; resolve() is lexical only.
  const raw = isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`;
  const lexical = resolve(raw);
  const real = canonicalPath(raw);
  if (deniedForm(boundary, lexical) || deniedForm(boundary, real)) return true;
  return (
    options.traversal === true &&
    boundary.deny.some((root) => isWithin(lexical, root) || isWithin(real, root))
  );
}

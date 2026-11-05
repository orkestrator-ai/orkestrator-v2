import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
} from "@orkestrator/protocol/coordinator";

/**
 * What a coordinator's turn may not read, however it asks.
 *
 * The backend's data directory holds the Control MCP operator credentials
 * (`control-mcp.json`, plaintext at 0600 by decision so Copy setup always
 * works), the provider secrets (`config.json` and its backups), the database,
 * and every account's login. A coordinator runs as the same user, so nothing
 * but this stops a read.
 *
 * The whole directory is denied rather than a list of files, because a list
 * goes stale silently whenever a store adds a secret, and a stale allowance
 * fails loudly instead. What the turn is meant to read is carved back out:
 * the conversation's own Claude home (saved tool results, memory; it never
 * holds a login, see `applyCoordinatorClaudeAccount`), its own attachments, the
 * skills it was given, the checkout, and the managed toolchains (executables
 * only, and a shell's `rg` execs the CLI from there). Only what lies inside the
 * directory is carved out, so nothing can re-open the rest.
 *
 * Two layers hold it. The OS sandbox covers commands; this module's check
 * covers the CLI's own tools, which run outside the sandbox, and is all that
 * stands behind commands on a host whose sandbox cannot run.
 */
export interface ReadBoundary {
  deny: string[];
  allow: string[];
}

/** The path as the filesystem resolves it, with any not-yet-existing tail kept. */
function canonical(path: string): string {
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

function namedAndCanonical(paths: readonly (string | undefined)[]): string[] {
  const named = paths.flatMap((path) => (path?.trim() && isAbsolute(path) ? [path] : []));
  return [...new Set(named.flatMap((path) => [resolve(path), canonical(path)]))];
}

/** The checkout as named and as resolved, since a symlink and its target are one directory. */
export function claudeReadOnlyWorkspacePaths(cwd: string): string[] {
  return [...new Set([cwd, canonical(cwd)])];
}

/** The boundary this process was launched under; null outside a coordinator. */
export function coordinatorReadBoundary(
  workspaces: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ReadBoundary | null {
  const dataDir = env[COORDINATOR_PROTECTED_DATA_DIR_ENV]?.trim();
  if (!dataDir || !isAbsolute(dataDir)) return null;
  const deny = namedAndCanonical([dataDir]);
  return {
    deny,
    // Only what lies strictly inside the denied directory. A checkout above it
    // must not re-open the whole directory, since an allowance wins over a denial.
    allow: namedAndCanonical([
      env.CLAUDE_CONFIG_DIR,
      env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT,
      env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV],
      join(dataDir, "toolchains"),
      ...workspaces,
    ]).filter((path) => !deny.includes(path) && deny.some((root) => isWithin(root, path))),
  };
}

function isWithin(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root === parse(root).root ? root : `${root}${sep}`;
  return path.startsWith(prefix);
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
 * denied directory would walk into it, which only the OS sandbox could stop.
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
  const real = canonical(raw);
  if (deniedForm(boundary, lexical) || deniedForm(boundary, real)) return true;
  return (
    options.traversal === true &&
    boundary.deny.some((root) => isWithin(lexical, root) || isWithin(real, root))
  );
}

/** The literal directory a glob pattern starts from, when it names one itself. */
function globRoot(pattern: string): string | undefined {
  if (!pattern.startsWith("/") && !pattern.startsWith("~") && !pattern.startsWith("..")) {
    return undefined;
  }
  const wildcard = pattern.search(/[*?[{]/);
  return wildcard < 0 ? pattern : pattern.slice(0, wildcard);
}

/** Whether one of the CLI's own reading tools would reach a denied file. */
export function readToolRefused(
  boundary: ReadBoundary,
  tool: string,
  input: Record<string, unknown>,
  cwd: string,
): boolean {
  const text = (key: string) => {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value : undefined;
  };
  if (tool === "Read") {
    const path = text("file_path");
    return path !== undefined && readBoundaryRefuses(boundary, path, cwd);
  }
  if (tool !== "Grep" && tool !== "Glob") return false;
  const roots = [text("path") ?? cwd];
  const pattern = tool === "Glob" ? text("pattern") : undefined;
  const root = pattern ? globRoot(pattern) : undefined;
  if (root) roots.push(root);
  return roots.some((path) => readBoundaryRefuses(boundary, path, cwd, { traversal: true }));
}

/**
 * Whether a vetted command names a denied path. Quoting, globs and substitution
 * are already refused, so what is written is what runs; an option can carry its
 * value attached (`--file=x`, `-fx`). Without a sandbox behind it
 * (`traversal`), a command rooted above the denied directory is refused too.
 */
export function shellCommandRefused(
  boundary: ReadBoundary,
  command: string,
  cwd: string,
  options: { traversal: boolean },
): boolean {
  const [program, ...tokens] = command.trim().split(/\s+/);
  if (options.traversal) {
    // A hook cannot constrain paths reached through descendant symlinks.
    // Refuse follow modes, including short-option clusters, before execution.
    if (
      (program === "grep" &&
        tokens.some(
          (token) =>
            /^-[^-]*[RS]/.test(token) ||
            (token.startsWith("--") && "--dereference-recursive".startsWith(token)),
        )) ||
      (program === "diff" &&
        tokens.some(
          (token) =>
            /^-[^-]*r/.test(token) || (token.startsWith("--") && "--recursive".startsWith(token)),
        )) ||
      ((program === "rg" ||
        program === "ag" ||
        program === "find" ||
        program === "fd" ||
        program === "du" ||
        program === "ls") &&
        tokens.some(
          (token) => token === "--follow" || token === "--dereference" || /^-[^-]*L/.test(token),
        ))
    )
      return true;
    const searches =
      program === "rg" ||
      program === "ag" ||
      program === "find" ||
      program === "fd" ||
      program === "du" ||
      program === "ls" ||
      program === "tree" ||
      program === "grep";
    if (searches && readBoundaryRefuses(boundary, cwd, cwd, options)) return true;
  }
  return tokens.some((token) => {
    const attached: string[] = [];
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals >= 0) attached.push(token.slice(equals + 1));
    } else if (token.startsWith("-")) {
      // A path-valued short option may follow other flags (-nFf/path).
      // Without a per-program grammar, conservatively check every possible
      // operand after a leading option letter, including relative paths.
      for (let index = 1; index < token.length && /[a-zA-Z0-9]/.test(token[index]!); index++) {
        attached.push(token.slice(index + 1));
      }
    }
    return [token, ...attached].some(
      (candidate) => candidate && readBoundaryRefuses(boundary, candidate, cwd, options),
    );
  });
}

import { join } from "node:path";
import {
  COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV,
  COORDINATOR_PROTECTED_DATA_DIR_ENV,
} from "@orkestrator/protocol/coordinator";
import {
  canonicalPath,
  protectedDataDirBoundary,
  readBoundaryRefuses,
  type ReadBoundary,
} from "@orkestrator/protocol/node/coordinator-read-boundary";

export { readBoundaryRefuses, type ReadBoundary };

/*
 * What a coordinator's turn may not read, however it asks: the data directory
 * (see `@orkestrator/protocol/node/coordinator-read-boundary`), with what the
 * turn is meant to read carved back out: the conversation's own Claude home
 * (saved tool results, memory; it never holds a login, see
 * `applyCoordinatorClaudeAccount`), its own attachments, the skills it was
 * given, the checkout, and the managed toolchains (executables only, and a
 * shell's `rg` execs the CLI from there).
 *
 * Two layers hold it. The OS sandbox covers commands; this module's check
 * covers the CLI's own tools, which run outside the sandbox, and is all that
 * stands behind commands on a host whose sandbox cannot run.
 */

/** The checkout as named and as resolved, since a symlink and its target are one directory. */
export function claudeReadOnlyWorkspacePaths(cwd: string): string[] {
  return [...new Set([cwd, canonicalPath(cwd)])];
}

/** The boundary this process was launched under; null outside a coordinator. */
export function coordinatorReadBoundary(
  workspaces: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ReadBoundary | null {
  const dataDir = env[COORDINATOR_PROTECTED_DATA_DIR_ENV]?.trim();
  return protectedDataDirBoundary(dataDir, [
    env.CLAUDE_CONFIG_DIR,
    env.ORKESTRATOR_BRIDGE_ATTACHMENT_ROOT,
    env[COORDINATOR_CLAUDE_USER_SKILLS_DIR_ENV],
    dataDir ? join(dataDir, "toolchains") : undefined,
    ...workspaces,
  ]);
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
    // These programs can take filenames from file contents or stdin; their
    // operands alone cannot prove which files they will open. Since a plain
    // pipe is admitted, stdin is the model's to write (`echo <hex> | xxd -r -p
    // | du --files0-from=-`), so a path never has to appear as a token. GNU
    // long options also accept unambiguous prefixes (including before '=').
    // find's `-files0-from` is a single-dash primary, matched exactly below.
    if (program === "find" && tokens.some((token) => /^--?files0-from(?:=|$)/.test(token))) {
      return true;
    }
    const indirectOption =
      program === "sort" || program === "wc" || program === "du"
        ? "--files0-from"
        : program === "file"
          ? "--files-from"
          : ["cksum", "md5sum", "sha1sum", "sha256sum"].includes(program ?? "")
            ? "--check"
            : undefined;
    if (
      indirectOption &&
      tokens.some((token) => {
        const option = token.split("=", 1)[0]!;
        return (
          (option.startsWith("--") && indirectOption.startsWith(option)) ||
          (program === "file" && /^-[^-]*f/.test(token)) ||
          (indirectOption === "--check" && /^-[^-]*c/.test(token))
        );
      })
    )
      return true;
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

/** Host-side write boundaries for disposable live MCP qualification. */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

type SourcePath = { displayPath: string };
export type WriteBoundary = { dataDir: string; worktree: string; flavor?: string };

/** Resolve existing ancestors too, so a missing file under a symlink cannot escape. */
function canonical(file: string): string {
  const absolute = path.resolve(file);
  if (lstatSync(absolute, { throwIfNoEntry: false })) return realpathSync(absolute);
  return path.join(canonical(path.dirname(absolute)), path.basename(absolute));
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function writableSourcePath(source: SourcePath, boundary: WriteBoundary): string | null {
  if (boundary.flavor !== "agent-test") return null;
  // Claude's local scope is a section of the same user file.
  const shown = source.displayPath.endsWith(" → projects[<worktree>]")
    ? source.displayPath.slice(0, -" → projects[<worktree>]".length)
    : source.displayPath;
  if (shown.includes(" → ")) return null;
  let file: string;
  if (shown.startsWith("<worktree>/")) file = path.join(boundary.worktree, shown.slice(11));
  else if (shown.startsWith("~/"))
    file = path.join(boundary.dataDir, "agent-credentials", "home", shown.slice(2));
  else if (path.isAbsolute(shown)) file = shown;
  else return null;
  try {
    const resolved = canonical(file);
    return within(resolved, canonical(boundary.dataDir)) ||
      within(resolved, canonical(boundary.worktree))
      ? resolved
      : null;
  } catch {
    return null;
  }
}

export function writeRefusal(source: SourcePath, boundary: WriteBoundary): string | null {
  return writableSourcePath(source, boundary)
    ? null
    : "the source does not resolve inside the isolated profile or test worktree";
}

/** Grant trust only in the profile's own Codex user config, never a host home or project file. */
export function grantCodexProjectTrust(
  source: SourcePath & { scope: string },
  boundary: WriteBoundary,
): boolean {
  const file = writableSourcePath(source, boundary);
  if (!file || source.scope !== "backend-user" || !within(file, canonical(boundary.dataDir)))
    return false;
  mkdirSync(path.dirname(file), { recursive: true });
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(
    file,
    `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}[projects.${JSON.stringify(boundary.worktree)}]\ntrust_level = "trusted"\n`,
    { mode: 0o600 },
  );
  return true;
}

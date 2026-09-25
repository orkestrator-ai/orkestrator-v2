import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Where a worktree's Git metadata actually lives.
 *
 * A main checkout keeps it in `<root>/.git`, below the watched root. A linked
 * worktree (`git worktree add`, which is how every local environment is
 * created) has a `.git` *file* pointing at `<common>/.git/worktrees/<name>`:
 * its index and HEAD live there, and the refs a comparison resolves through
 * (`refs/remotes/origin/<ref>`, `packed-refs`) live in the shared common dir.
 * None of those are below the worktree root, so a recursive watch of the root
 * alone cannot see `git add` or a fetch that moves the baseline.
 */
export interface WorktreeGitPaths {
  /** Per-worktree Git dir: holds `index` and `HEAD`. */
  gitDir: string;
  /** Shared Git dir: holds `refs/` and `packed-refs`. */
  commonDir: string;
  /** True when `gitDir` is outside the worktree root (a `.git` file). */
  linked: boolean;
}

export type TextFileReader = (filePath: string) => Promise<string | undefined>;

const readTextFile: TextFileReader = (filePath) =>
  fs.readFile(filePath, "utf8").then(
    (text) => text,
    () => undefined,
  );

const isDirectory = (filePath: string): Promise<boolean> =>
  fs.stat(filePath).then(
    (stat) => stat.isDirectory(),
    () => false,
  );

/**
 * Resolves the Git directories of a worktree the way Git does for a checkout
 * without `GIT_DIR`: `<root>/.git` is either the Git dir itself or a
 * `gitdir: <path>` pointer, and a Git dir with a `commondir` file shares refs
 * with that directory. Returns `undefined` when the root is not a checkout.
 *
 * Reads two small files at most; no process is spawned.
 */
export async function resolveWorktreeGitPaths(
  worktreePath: string,
  io: { read?: TextFileReader; isDirectory?: (filePath: string) => Promise<boolean> } = {},
): Promise<WorktreeGitPaths | undefined> {
  const read = io.read ?? readTextFile;
  const directory = io.isDirectory ?? isDirectory;
  const root = path.resolve(worktreePath);
  const dotGit = path.join(root, ".git");
  if (await directory(dotGit)) {
    return { gitDir: dotGit, commonDir: await commonDirOf(dotGit, read), linked: false };
  }
  const pointer = await read(dotGit);
  const match = pointer ? /^gitdir:\s*(.+?)\s*$/m.exec(pointer) : null;
  if (!match) return undefined;
  const gitDir = path.resolve(root, match[1]!);
  return { gitDir, commonDir: await commonDirOf(gitDir, read), linked: true };
}

async function commonDirOf(gitDir: string, read: TextFileReader): Promise<string> {
  const common = (await read(path.join(gitDir, "commondir")))?.trim();
  return common ? path.resolve(gitDir, common) : gitDir;
}

/** A full 40-hex SHA: resolving it never consults a ref. */
function isImmutableCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref.trim());
}

/**
 * The ref files, relative to the common dir, a comparison against
 * `comparisonRef` can resolve through. `resolveLocalGitBase` tries
 * `origin/<ref>` and then `<ref>`, and Git expands each short name with its
 * documented rules (`<name>`, `refs/<name>`, `refs/tags/<name>`,
 * `refs/heads/<name>`, `refs/remotes/<name>`, `refs/remotes/<name>/HEAD`).
 * `packed-refs` is always relevant, and is reported separately by
 * {@link isRelevantCommonDirChange}.
 */
export function relevantRefPaths(comparisonRef: string): string[] {
  const ref = comparisonRef.trim();
  if (!ref || isImmutableCommit(ref)) return [];
  const paths = new Set<string>();
  for (const name of [`origin/${ref}`, ref]) {
    for (const candidate of [
      `refs/${name}`,
      `refs/tags/${name}`,
      `refs/heads/${name}`,
      `refs/remotes/${name}`,
      `refs/remotes/${name}/HEAD`,
    ]) {
      paths.add(candidate);
    }
  }
  return [...paths];
}

function normalize(relative: string): string {
  return relative.split(path.sep).join("/");
}

/** `index` or `HEAD` inside a per-worktree Git dir (relative filename). */
export function isRelevantGitDirChange(relative: string | null): boolean {
  if (relative === null) return true;
  const name = normalize(relative);
  return name === "index" || name === "HEAD";
}

/**
 * A change inside the common dir that can move the comparison base:
 * `packed-refs` or one of {@link relevantRefPaths}. Lock files, objects, logs,
 * `FETCH_HEAD` and other branches cannot change what the diff reports.
 */
export function isRelevantCommonDirChange(
  relative: string | null,
  refs: readonly string[],
): boolean {
  if (relative === null) return true;
  const name = normalize(relative);
  return name === "packed-refs" || refs.includes(name);
}

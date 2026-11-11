import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { HARDENED_GIT_CONFIG } from "./git-fsmonitor.js";
import { CommandFailedError, runCommand } from "./shell.js";

/**
 * Which directories a worktree watcher may leave out, and what to watch instead.
 *
 * Bun's recursive `fs.watch` on Linux takes one inotify watch per directory and
 * walks all of `node_modules` to do it. A subtree is left out only when Git has
 * proved three things about it: it is called `node_modules`, it is ignored, and
 * it holds no tracked file. The name is part of the rule because the tree view
 * skips `node_modules` at every depth, so nothing a user sees depends on events
 * from it, while it does show other ignored directories such as `dist`.
 *
 * Git's answer is read here at most once per settled burst of changes that can
 * alter it, never per event. Anything that fails or is too large to plan keeps
 * the whole worktree watched: too many events are a cost, too few a wrong count.
 *
 * Linux also leaves out any other ignored, untracked directory whose subtree
 * holds more than {@link WATCH_PLAN_MAX_IGNORED_TREE_DIRECTORIES} directories,
 * because Bun walks a recursive watch's tree on the event loop to place its
 * inotify watches: one rootless Docker data root in a worktree cost a loaded host
 * about 35 s. The tree view does show such a directory, so a watcher that leaves
 * one out does not report qualified coverage, and its owner polls and serves the
 * tree on the unwatched age bound (docs/architecture/git-scan-caches.md, "A large
 * ignored tree").
 */

/** A directory to watch, relative to the worktree root (`""` is the root). */
export interface WatchTarget {
  relative: string;
  recursive: boolean;
}

/** The whole worktree under one watch: what every failure falls back to. */
export const WHOLE_WORKTREE: readonly WatchTarget[] = [{ relative: "", recursive: true }];

/** Excluded subtrees one worktree can have before it is watched whole. */
export const WATCH_PLAN_MAX_EXCLUDED = 256;

/** Watches one worktree can hold before it is watched whole. */
export const WATCH_PLAN_MAX_TARGETS = 1_024;

const EXCLUSION_READ_TIMEOUT_MS = 15_000;

/**
 * Directories an ignored tree other than `node_modules` may hold before Linux
 * leaves it unwatched. Bun placed watches at about 1 ms a directory on a loaded
 * host (30,000 in about 35 s on beelink2), so this bounds one attach's walk of
 * such a tree to a couple of seconds there, and to milliseconds on an idle one.
 */
export const WATCH_PLAN_MAX_IGNORED_TREE_DIRECTORIES = 2_000;

/** Ignored trees other than `node_modules` one plan measures; past it none are. */
export const WATCH_PLAN_MAX_IGNORED_CANDIDATES = 64;

/** Git's ignored, untracked directories, split by whether they are `node_modules`. */
export interface IgnoredTrees {
  /** `node_modules` trees that may always be left out. */
  dependencies: readonly string[];
  /** Every other one, which may be left out only at the cost of coverage. */
  others: readonly string[];
}

/** The file system and Git reads a plan needs, injectable for tests. */
export interface WorktreeWatchPlanIo {
  /**
   * Worktree-relative subtrees to leave out, without a trailing slash.
   * `undefined` means no answer, so nothing may be left out.
   */
  listExcluded(worktreePath: string): Promise<readonly string[] | undefined>;
  /** Real child directories, never symlinks. Rejects when `relative` is gone. */
  childDirectories(worktreePath: string, relative: string): Promise<readonly string[]>;
  /** Identifies the directory at `relative`; `null` when it is not a directory. */
  directoryIdentity(worktreePath: string, relative: string): Promise<string | null>;
  /**
   * Both kinds of ignored tree from one Git read. Where a recursive watch walks
   * its tree (Linux), the watcher uses this instead of `listExcluded` when
   * {@link exceedsDirectories} is present too. `undefined` means no answer.
   * So an io that wraps `listExcluded` but keeps another io's
   * `listIgnoredTrees` is bypassed on Linux: wrap both, or drop this one.
   */
  listIgnoredTrees?(worktreePath: string): Promise<IgnoredTrees | undefined>;
  /**
   * Whether the tree at `relative` holds more than `limit` directories, counting
   * ones that cannot be read. Reads at most `limit + 1` directories, off the
   * event loop.
   */
  exceedsDirectories?(worktreePath: string, relative: string, limit: number): Promise<boolean>;
}

function isDependencyTree(entry: string): boolean {
  return path.posix.basename(entry.slice(0, -1)) === "node_modules";
}

function splitNul(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

/**
 * The `node_modules` directories Git proves can be left out.
 *
 * `ls-files --directory` names a directory only when none of its contents are
 * tracked, which is the tracked half of the proof. It also names a directory
 * merely because everything in it happens to be ignored today, so `check-ignore`
 * then confirms the directory itself is matched and a new file there would be
 * too. Both run hardened: a worktree's config must not name a program for the
 * backend to run. A name that does not decode cleanly stays watched.
 */
export async function listIgnoredDependencyTrees(
  worktreePath: string,
): Promise<readonly string[] | undefined> {
  return (await readIgnoredTrees(worktreePath, false))?.dependencies;
}

/**
 * {@link listIgnoredDependencyTrees}, plus the other ignored, untracked
 * directories under the same proof. Past {@link WATCH_PLAN_MAX_IGNORED_CANDIDATES}
 * of those, none are returned, so none are measured or left out.
 */
export async function listIgnoredTrees(worktreePath: string): Promise<IgnoredTrees | undefined> {
  return readIgnoredTrees(worktreePath, true);
}

async function readIgnoredTrees(
  worktreePath: string,
  withOthers: boolean,
): Promise<IgnoredTrees | undefined> {
  const git = ["-C", worktreePath, ...HARDENED_GIT_CONFIG];
  try {
    const listed = await runCommand(
      "git",
      [...git, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { timeoutMs: EXCLUSION_READ_TIMEOUT_MS },
    );
    const directories = splitNul(listed.stdout).filter(
      (entry) => entry.endsWith("/") && !entry.includes("�"),
    );
    const dependencies = directories.filter(isDependencyTree);
    if (dependencies.length > WATCH_PLAN_MAX_EXCLUDED) return undefined;
    let others = withOthers ? directories.filter((entry) => !isDependencyTree(entry)) : [];
    if (others.length > WATCH_PLAN_MAX_IGNORED_CANDIDATES) others = [];
    const candidates = [...dependencies, ...others];
    if (candidates.length === 0) return { dependencies: [], others: [] };
    const confirmed = await runCommand("git", [...git, "check-ignore", "-z", "--stdin"], {
      stdin: `${candidates.join("\0")}\0`,
      timeoutMs: EXCLUSION_READ_TIMEOUT_MS,
    }).then(
      (result) => splitNul(result.stdout),
      (error: unknown) => {
        // `check-ignore` exits 1 when it matched nothing, which is an answer.
        if (error instanceof CommandFailedError && error.exitCode === 1) return [];
        throw error;
      },
    );
    return {
      dependencies: confirmed.filter(isDependencyTree).map((entry) => entry.slice(0, -1)),
      others: confirmed.filter((entry) => !isDependencyTree(entry)).map((e) => e.slice(0, -1)),
    };
  } catch {
    return undefined;
  }
}

/**
 * Counts the directories below `relative`, breadth first and one `readdir` at a
 * time, until it has seen more than `limit`. A directory it may not read still
 * counts: Bun's walk tries to watch it too. Symlinks are not followed.
 */
export async function exceedsDirectories(
  worktreePath: string,
  relative: string,
  limit: number,
): Promise<boolean> {
  const queue = [path.join(worktreePath, relative)];
  let seen = 0;
  for (let next = 0; next < queue.length; next += 1) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(queue[next]!, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      seen += 1;
      if (seen > limit) return true;
      // Never more than `limit` long, since it holds only directories seen.
      queue.push(path.join(queue[next]!, entry.name));
    }
  }
  return false;
}

/**
 * Covers a worktree without entering an excluded subtree: a non-recursive watch
 * on the root and on each ancestor of an excluded subtree, and a recursive watch
 * on every other child of those. Files directly inside an ancestor, and new
 * directories, are seen by its non-recursive watch.
 */
export async function planWatchTargets(
  excluded: readonly string[],
  childDirectories: (relative: string) => Promise<readonly string[]>,
  maxTargets = WATCH_PLAN_MAX_TARGETS,
): Promise<readonly WatchTarget[]> {
  if (excluded.length === 0) return WHOLE_WORKTREE;
  const left = new Set(excluded);
  const split = new Set<string>([""]);
  for (const entry of excluded) {
    for (let at = entry.lastIndexOf("/"); at > 0; at = entry.lastIndexOf("/", at - 1)) {
      split.add(entry.slice(0, at));
    }
  }
  const targets: WatchTarget[] = [];
  for (const directory of split) {
    let children: readonly string[];
    try {
      children = await childDirectories(directory);
    } catch (error) {
      if (directory === "" || !isAbsent(error)) throw error;
      // It went away; the event in its parent that says so plans again.
      continue;
    }
    targets.push({ relative: directory, recursive: false });
    for (const child of children) {
      // `fs` cannot reopen a name it could not decode. A recursive watch of a
      // parent still covers it.
      if (child.includes("�")) return WHOLE_WORKTREE;
      const relative = directory ? `${directory}/${child}` : child;
      if (left.has(relative) || split.has(relative)) continue;
      targets.push({ relative, recursive: true });
    }
    if (targets.length > maxTargets) return WHOLE_WORKTREE;
  }
  return targets;
}

function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export const worktreeWatchPlanIo: WorktreeWatchPlanIo = {
  listExcluded: listIgnoredDependencyTrees,
  listIgnoredTrees,
  exceedsDirectories,
  async childDirectories(worktreePath, relative) {
    const entries = await fs.readdir(path.join(worktreePath, relative), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
  async directoryIdentity(worktreePath, relative) {
    const stat = await fs.lstat(path.join(worktreePath, relative)).catch((error: unknown) => {
      if (isAbsent(error)) return null;
      throw error;
    });
    return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  },
};

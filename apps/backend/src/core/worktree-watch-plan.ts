import { promises as fs } from "node:fs";
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
  const git = ["-C", worktreePath, ...HARDENED_GIT_CONFIG];
  try {
    const listed = await runCommand(
      "git",
      [...git, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { timeoutMs: EXCLUSION_READ_TIMEOUT_MS },
    );
    const candidates = splitNul(listed.stdout).filter(
      (entry) => entry.endsWith("/") && isDependencyTree(entry) && !entry.includes("�"),
    );
    if (candidates.length === 0) return [];
    if (candidates.length > WATCH_PLAN_MAX_EXCLUDED) return undefined;
    const confirmed = await runCommand("git", [...git, "check-ignore", "-z", "--stdin"], {
      stdin: `${candidates.join("\0")}\0`,
      timeoutMs: EXCLUSION_READ_TIMEOUT_MS,
    });
    return splitNul(confirmed.stdout).map((entry) => entry.slice(0, -1));
  } catch (error) {
    // `check-ignore` exits 1 when it matched nothing, which is an answer.
    if (error instanceof CommandFailedError && error.exitCode === 1) return [];
    return undefined;
  }
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

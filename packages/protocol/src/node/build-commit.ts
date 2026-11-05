/**
 * The commit a backend bundle reports as its build commit.
 *
 * The build tasks read it from Git here and pass it to the bundlers in
 * {@link BUILD_COMMIT_ENV}, which Turbo hashes (`env` in `turbo.json` and
 * `packages/cli/turbo.json`). A build script must not ask Git itself: Turbo
 * restores `dist/**` on a cache hit without running it, so a later commit that
 * changed nothing in the task's inputs would report whichever commit first
 * filled the entry.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

import { parseBuildCommit } from "../backend-profile.js";

export const BUILD_COMMIT_ENV = "ORKESTRATOR_BUILD_COMMIT";

/** One Git command in the tree: its trimmed stdout, or `null` when it did not succeed. */
export type GitReader = (root: string, args: string[]) => string | null;

const readGit: GitReader = (root, args) => {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
};

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

/**
 * `HEAD` of the repository rooted at `root`, or `null` when no commit describes
 * the tree exactly: any modified or untracked file, or a tree that is not that
 * repository's root (an unpacked source archive inside some other checkout).
 */
export function readBuildCommit(root: string, git: GitReader = readGit): string | null {
  const topLevel = git(root, ["rev-parse", "--show-toplevel"]);
  if (!topLevel || !sameDirectory(topLevel, root)) return null;
  // Reading must not take the index lock from a Git command running beside it.
  if (git(root, ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]) !== "")
    return null;
  return parseBuildCommit(git(root, ["rev-parse", "HEAD"]));
}

/** `env` for a build run outside the mise tasks, with no inherited value left over. */
export function buildCommitEnv(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  git: GitReader = readGit,
): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next[BUILD_COMMIT_ENV];
  const commit = readBuildCommit(root, git);
  if (commit) next[BUILD_COMMIT_ENV] = commit;
  return next;
}

/**
 * The `Bun.build` `define` that embeds the commit, read by `BUILD_COMMIT` in the
 * backend's `constants.ts`. Anything but a valid commit embeds `null`.
 */
export function buildCommitDefine(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { __ORKESTRATOR_BUILD_COMMIT__: JSON.stringify(parseBuildCommit(env[BUILD_COMMIT_ENV])) };
}

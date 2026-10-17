import type { EnvironmentDiffBaseline } from "@orkestrator/protocol/diff-stats";
import { validateGitRefName } from "./commands-agent-support.js";
import { isImmutableCommitRef } from "./commands-files.js";
import { runCommand } from "./shell.js";
import type { Environment } from "./models.js";

/** Runs one git command in a checkout; the trimmed stdout, or null when git fails. */
export type BaselineGit = (args: string[]) => Promise<string | null>;

export function localBaselineGit(worktreePath: string): BaselineGit {
  return (args) =>
    runCommand("git", ["-C", worktreePath, ...args], { timeoutMs: 30_000 }).then(
      ({ stdout }) => stdout.trim(),
      () => null,
    );
}

/**
 * The branch whose newer history may move an environment's baseline: the PR's
 * actual base, else the branch a coordinator delegated from, else the
 * repository's configured branches.
 *
 * Null once the environment's PR is merged. Its own commits are then part of
 * the target, so taking the target back in would move the baseline past the
 * environment's work and report none. The baseline stays where it was.
 */
export function baselineTargetBranch(
  environment: Pick<Environment, "prBaseBranch" | "delegationBaseBranch"> &
    Partial<Pick<Environment, "prState">>,
  repositoryConfig: { prBaseBranch?: string; defaultBranch?: string } | undefined | null,
): string | null {
  if (environment.prState === "merged") return null;
  return (
    environment.prBaseBranch?.trim() ||
    environment.delegationBaseBranch?.trim() ||
    repositoryConfig?.prBaseBranch?.trim() ||
    repositoryConfig?.defaultBranch?.trim() ||
    "main"
  );
}

/**
 * Finds where the checkout's HEAD now leaves `targetBranch`, when that is later
 * than the commit the environment was created from.
 *
 * An environment is created at one commit, but its branch can take in newer
 * history from its target: an agent merges `origin/main`, rebases onto it, or
 * resets to it. Measured from the creation commit, every one of those incoming
 * commits reads as the environment's own work. The merge base with the target
 * is where the branch's own work starts, which is what a pull request shows.
 *
 * Only ever moves forward from the creation commit, and only along history
 * that contains it: a branch that has not taken in anything newer, or whose
 * target does not contain the creation commit (a launch from an unpushed local
 * commit), keeps measuring from where it was created. Reads local refs only;
 * a branch that took in `origin/main` already fetched it.
 *
 * Returns null when the creation commit is still the right baseline.
 */
export async function findIntegratedBaseline(
  git: BaselineGit,
  createdFromCommit: string,
  targetBranch: string,
): Promise<EnvironmentDiffBaseline | null> {
  if (!isImmutableCommitRef(createdFromCommit)) return null;
  const created = createdFromCommit.trim().toLowerCase();
  let branch: string;
  try {
    branch = validateGitRefName(targetBranch, "target branch");
  } catch {
    return null;
  }

  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const mergeBase = (await git(["merge-base", "HEAD", ref]))?.toLowerCase();
    if (!mergeBase || !isImmutableCommitRef(mergeBase)) continue;
    if (mergeBase === created) return null;
    const containsCreation =
      (await git(["merge-base", "--is-ancestor", created, mergeBase])) !== null;
    return containsCreation ? { createdFromCommit: created, commit: mergeBase } : null;
  }
  return null;
}

export function isSameDiffBaseline(
  a: EnvironmentDiffBaseline | null | undefined,
  b: EnvironmentDiffBaseline | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.createdFromCommit.toLowerCase() === b.createdFromCommit.toLowerCase() &&
    a.commit.toLowerCase() === b.commit.toLowerCase()
  );
}

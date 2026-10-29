import {
  MAX_DIFF_BASE_SUBJECT_LENGTH,
  shortDiffBaseRefName,
  type DiffBaseBranch,
  type DiffBaseCommit,
  type EnvironmentDiffBaseOverride,
} from "@orkestrator/protocol/diff-stats";
import { quoteShell, validateGitRefName } from "./commands-agent-support.js";
import { dockerExec } from "./commands-container-exec.js";
import { isImmutableCommitRef } from "./commands-files.js";
import type { Environment } from "./models.js";
import { runCommand } from "./shell.js";

/**
 * Reads behind the user-chosen diff base (`EnvironmentDiffBaseOverride`): the
 * branches and commits the Changes panel offers, and the check that a chosen
 * commit exists in the environment's checkout before it is saved.
 */

/** Runs one git command in an environment's checkout and returns stdout; throws when git fails. */
export type DiffBaseGit = (args: string[]) => Promise<string>;

export const MAX_DIFF_BASE_BRANCHES = 500;
export const DEFAULT_DIFF_BASE_COMMITS = 100;
export const MAX_DIFF_BASE_COMMITS = 500;
const FIELD = "\x1f";
const RECORD = "\x1e";

export function diffBaseGitForEnvironment(
  environment: Pick<Environment, "environmentType" | "worktreePath" | "containerId" | "status">,
): DiffBaseGit {
  if (environment.environmentType === "local") {
    const worktreePath = environment.worktreePath;
    if (!worktreePath) throw new Error("The environment has no checkout");
    return async (args) =>
      (await runCommand("git", ["-C", worktreePath, ...args], { timeoutMs: 30_000 })).stdout;
  }
  const containerId = environment.containerId;
  if (environment.status !== "running" || !containerId) {
    throw new Error("Start the environment to choose a comparison base");
  }
  return (args) =>
    dockerExec(
      containerId,
      `cd /workspace && git ${args.map((arg) => quoteShell(arg)).join(" ")}`,
      30_000,
    );
}

/** Local and remote-tracking branches, most recently committed first. */
export async function listDiffBaseBranches(git: DiffBaseGit): Promise<DiffBaseBranch[]> {
  const output = await git([
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  return parseDiffBaseBranches(output);
}

export function parseDiffBaseBranches(output: string): DiffBaseBranch[] {
  const branches: DiffBaseBranch[] = [];
  for (const line of output.split("\n")) {
    const ref = line.trim();
    // `origin/HEAD` is an alias of another listed branch.
    if (!ref || ref.endsWith("/HEAD")) continue;
    const kind = ref.startsWith("refs/heads/")
      ? "local"
      : ref.startsWith("refs/remotes/")
        ? "remote"
        : null;
    if (!kind) continue;
    branches.push({ ref, name: shortDiffBaseRefName(ref), kind });
    if (branches.length >= MAX_DIFF_BASE_BRANCHES) break;
  }
  return branches;
}

/** Rejects anything but a full local or remote-tracking branch ref. */
export function validateDiffBaseRef(value: unknown): string {
  if (typeof value !== "string") throw new Error("ref must be a string");
  const ref = validateGitRefName(value, "branch ref");
  if (!ref.startsWith("refs/heads/") && !ref.startsWith("refs/remotes/")) {
    throw new Error(`Invalid branch ref: ${value}`);
  }
  return ref;
}

/**
 * The newest commits on a branch, following first parents so a merged pull
 * request reads as one commit on its target rather than as every commit of the
 * branch it merged.
 */
export async function listDiffBaseCommits(
  git: DiffBaseGit,
  ref: string,
  limit = DEFAULT_DIFF_BASE_COMMITS,
): Promise<DiffBaseCommit[]> {
  const branch = validateDiffBaseRef(ref);
  const count = Math.max(1, Math.min(MAX_DIFF_BASE_COMMITS, Math.trunc(limit)));
  const output = await git([
    "log",
    "--first-parent",
    `--max-count=${count}`,
    `--format=%H${FIELD}%s${FIELD}%an${FIELD}%cI${RECORD}`,
    branch,
    "--",
  ]);
  return parseDiffBaseCommits(output);
}

export function parseDiffBaseCommits(output: string): DiffBaseCommit[] {
  const commits: DiffBaseCommit[] = [];
  for (const record of output.split(RECORD)) {
    const [commit, subject = "", author = "", committedAt = ""] = record.trim().split(FIELD);
    if (!commit || !isImmutableCommitRef(commit)) continue;
    commits.push({
      commit: commit.toLowerCase(),
      subject: subject.slice(0, MAX_DIFF_BASE_SUBJECT_LENGTH),
      author,
      committedAt,
    });
  }
  return commits;
}

/**
 * Builds the override to save after checking that the commit exists in the
 * environment's checkout. A base Git cannot read would make every scan fail.
 */
export async function resolveDiffBaseOverride(
  git: DiffBaseGit,
  input: { ref: unknown; commit: unknown },
): Promise<EnvironmentDiffBaseOverride> {
  const ref = validateDiffBaseRef(input.ref);
  if (typeof input.commit !== "string" || !isImmutableCommitRef(input.commit)) {
    throw new Error("commit must be a full commit SHA");
  }
  const commit = input.commit.trim().toLowerCase();
  const subject = await git(["log", "-1", "--format=%s", `${commit}^{commit}`, "--"]).catch(() => {
    throw new Error(`Commit ${commit.slice(0, 12)} is not in this environment's checkout`);
  });
  const trimmed = subject.trim().slice(0, MAX_DIFF_BASE_SUBJECT_LENGTH);
  return { ref, commit, ...(trimmed ? { subject: trimmed } : {}) };
}

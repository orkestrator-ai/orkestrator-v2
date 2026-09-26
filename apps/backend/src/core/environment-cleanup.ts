import { lstat } from "node:fs/promises";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { validateGitRefName } from "./commands-agent-support.js";
import {
  assertDockerContainerOwned,
  getWorktreeBaseDir,
  isMissingDockerObjectError,
} from "./commands-environment.js";
import {
  environmentCleanupLedger,
  type EnvironmentCleanupEntry,
  type EnvironmentCleanupStep,
} from "./environment-cleanup-ledger.js";
import { environmentStateDirectories } from "./environment-state-paths.js";
import type { Environment, Project } from "./models.js";
import { removeConfinedDirectory } from "./path-safety.js";
import { pathExists, runCommand } from "./shell.js";

export type EnvironmentCleanupContext = Pick<
  CommandContext,
  "storage" | "strictDockerOwner" | "worktreeDir"
>;

/** Injectable so tests can drive Docker without a daemon. */
export type CleanupCommandRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

export type CleanupStepOptions = {
  run?: CleanupCommandRunner;
  /**
   * Deletion asserts container ownership before it records anything, so its
   * own container step need not probe Docker a second time. The reconciler
   * never sets this: a retry runs long after that check.
   */
  containerOwnershipVerified?: boolean;
};

const GIT_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 60_000;

/**
 * Describes what deleting `environment` must remove from the host. Branch
 * cleanup is only scheduled for a local environment with a worktree, because
 * only that path created the branch in the project checkout.
 */
export function buildEnvironmentCleanupEntry(
  environment: Environment,
  project: Pick<Project, "localPath"> | null,
  dataDir: string,
  now: Date = new Date(),
): EnvironmentCleanupEntry {
  const projectPath = project?.localPath?.trim() || null;
  const worktreePath = environment.worktreePath?.trim() || null;
  const ownsBranch =
    environment.environmentType === "local" &&
    !!projectPath &&
    !!worktreePath &&
    !!environment.branch;
  const pending: EnvironmentCleanupStep[] = [];
  if (environment.containerId) pending.push("container");
  if (worktreePath) pending.push("worktree");
  if (ownsBranch) pending.push("branch");
  pending.push("state-dirs");
  return {
    version: 1,
    environmentId: environment.id,
    recordedAt: now.toISOString(),
    projectPath,
    worktreePath,
    branch: ownsBranch ? environment.branch : null,
    prMerged: environment.prState === "merged",
    createdFromCommit: environment.createdFromCommit ?? null,
    baseBranches: environment.delegationBaseBranch ? [environment.delegationBaseBranch] : [],
    containerId: environment.containerId,
    stateDirectories: environmentStateDirectories(dataDir, environment.id),
    pending,
    attempts: 0,
    // Deletion itself is the first attempt; retrying a step that failed a
    // moment ago would only fail again.
    lastAttemptAt: now.toISOString(),
    lastError: null,
  };
}

/**
 * A failure summary that is safe to persist and log: an errno code or exit
 * status, never a path, command line, or command output.
 */
export function redactCleanupError(error: unknown): string {
  if (error instanceof CleanupRefusedError) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,31}$/.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  const exit = message.match(/\bexit(?: code)?\s*:?\s*(\d{1,3})\b/i);
  if (exit) return `exit ${exit[1]}`;
  return error instanceof Error && /^[A-Za-z]{1,64}$/.test(error.name) ? error.name : "Error";
}

/** A refusal whose message is fixed text, so it is safe to persist verbatim. */
class CleanupRefusedError extends Error {
  override name = "CleanupRefusedError";
}

/** Returns `root`-relative `target`, or null unless it is strictly inside. */
function confinedRelativePath(root: string, target: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

async function directoryExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function cleanupContainer(
  entry: EnvironmentCleanupEntry,
  context: EnvironmentCleanupContext,
  run: CleanupCommandRunner,
  ownershipVerified: boolean,
): Promise<void> {
  const containerId = entry.containerId;
  if (!containerId) return;
  // Refuses a container another development profile owns, and an unreachable
  // daemon; a container the daemon has forgotten passes.
  if (!ownershipVerified) await assertDockerContainerOwned(containerId, context);
  try {
    await run("docker", ["rm", "-f", containerId], { timeoutMs: DOCKER_TIMEOUT_MS });
  } catch (error) {
    if (!isMissingDockerObjectError(error)) throw error;
  }
}

async function cleanupWorktree(
  entry: EnvironmentCleanupEntry,
  context: EnvironmentCleanupContext,
  run: CleanupCommandRunner,
): Promise<void> {
  const worktreePath = entry.worktreePath;
  if (!worktreePath) return;
  // Once this path is gone, a new environment may be allocated the same one.
  // A late retry must leave it alone.
  const resolved = path.resolve(worktreePath);
  const environments = await context.storage.loadEnvironments();
  if (
    environments.some(
      (environment) =>
        environment.id !== entry.environmentId &&
        !!environment.worktreePath &&
        path.resolve(environment.worktreePath) === resolved,
    )
  ) {
    return;
  }
  const projectPath =
    entry.projectPath && (await pathExists(entry.projectPath)) ? entry.projectPath : null;
  if (projectPath && (await directoryExists(worktreePath))) {
    await run("git", ["-C", projectPath, "worktree", "remove", "--force", worktreePath], {
      timeoutMs: 120_000,
    }).catch(() => undefined);
  }
  if (await directoryExists(worktreePath)) {
    // Git refuses to remove a directory it no longer registers, and a process
    // that outlived the terminals can re-create part of the tree after git
    // removed it. Only a path inside the workspaces root is ours to delete.
    const baseDir = getWorktreeBaseDir(context);
    const relative = confinedRelativePath(baseDir, worktreePath);
    if (!relative) {
      throw new CleanupRefusedError("worktree is outside the workspaces root");
    }
    await removeConfinedDirectory(baseDir, relative);
  }
  if (projectPath) {
    await run("git", ["-C", projectPath, "worktree", "prune"], {
      timeoutMs: GIT_TIMEOUT_MS,
    }).catch(() => undefined);
  }
  if (await directoryExists(worktreePath)) {
    throw new CleanupRefusedError("worktree directory still exists");
  }
}

async function gitSucceeds(
  run: CleanupCommandRunner,
  projectPath: string,
  args: string[],
): Promise<boolean> {
  try {
    await run("git", ["-C", projectPath, ...args], { timeoutMs: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function gitOutput(
  run: CleanupCommandRunner,
  projectPath: string,
  args: string[],
): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", projectPath, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function refExists(
  run: CleanupCommandRunner,
  projectPath: string,
  ref: string,
): Promise<boolean> {
  return gitSucceeds(run, projectPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
}

/**
 * Refs whose history counts as "landed". Only local refs are consulted: the
 * reconciler never fetches, so a stale remote-tracking ref can only make it
 * keep a branch, never delete one.
 */
async function mergeTargetRefs(
  run: CleanupCommandRunner,
  projectPath: string,
  baseBranches: string[],
): Promise<string[]> {
  const candidates = new Set<string>();
  const originHead = await gitOutput(run, projectPath, [
    "symbolic-ref",
    "--quiet",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead?.startsWith("refs/remotes/origin/")) {
    candidates.add(originHead);
    candidates.add(`refs/heads/${originHead.slice("refs/remotes/origin/".length)}`);
  } else {
    for (const name of ["main", "master"]) {
      candidates.add(`refs/remotes/origin/${name}`);
      candidates.add(`refs/heads/${name}`);
    }
  }
  for (const base of baseBranches) {
    try {
      const name = validateGitRefName(base, "base branch");
      candidates.add(`refs/remotes/origin/${name}`);
      candidates.add(`refs/heads/${name}`);
    } catch {
      // An unusable recorded base branch is simply not a merge target.
    }
  }
  const existing: string[] = [];
  for (const ref of candidates) {
    if (await refExists(run, projectPath, ref)) existing.push(ref);
  }
  return existing;
}

async function isAncestor(
  run: CleanupCommandRunner,
  projectPath: string,
  commit: string,
  ref: string,
): Promise<boolean> {
  return gitSucceeds(run, projectPath, ["merge-base", "--is-ancestor", commit, ref]);
}

async function branchCheckedOut(
  run: CleanupCommandRunner,
  projectPath: string,
  branch: string,
): Promise<boolean> {
  const listing = await gitOutput(run, projectPath, ["worktree", "list", "--porcelain"]);
  // Unknown is treated as checked out: deleting a branch in use is not
  // recoverable, keeping it is.
  if (listing === null) return true;
  return listing.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

export type BranchCleanupOutcome = "deleted" | "kept" | "absent";

/**
 * Deletes the environment's local branch only when no work would be lost:
 * - its PR was merged, and the branch holds nothing beyond what was pushed;
 * - its tip is already contained in a merge target such as `origin/HEAD`; or
 * - it has no commits beyond the one the environment was created from.
 * Anything else is kept.
 */
export async function cleanupEnvironmentBranch(
  entry: EnvironmentCleanupEntry,
  run: CleanupCommandRunner = runCommand,
): Promise<BranchCleanupOutcome> {
  const projectPath = entry.projectPath;
  if (!projectPath || !entry.branch || !(await pathExists(projectPath))) return "absent";
  let branch: string;
  try {
    branch = validateGitRefName(entry.branch, "environment branch");
  } catch {
    return "kept";
  }
  const localRef = `refs/heads/${branch}`;
  const tip = await gitOutput(run, projectPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${localRef}^{commit}`,
  ]);
  if (!tip) return "absent";
  if (await branchCheckedOut(run, projectPath, branch)) return "kept";

  let disposable = false;
  if (entry.prMerged) {
    const tracking = `refs/remotes/origin/${branch}`;
    // Commits made after the PR merged exist only locally. When the pushed
    // branch is still known, the local tip must not be ahead of it.
    disposable =
      !(await refExists(run, projectPath, tracking)) ||
      (await isAncestor(run, projectPath, tip, tracking));
  }
  if (!disposable && entry.createdFromCommit) {
    disposable = await isAncestor(run, projectPath, tip, entry.createdFromCommit);
  }
  if (!disposable) {
    for (const ref of await mergeTargetRefs(run, projectPath, entry.baseBranches)) {
      if (await isAncestor(run, projectPath, tip, ref)) {
        disposable = true;
        break;
      }
    }
  }
  if (!disposable) return "kept";
  // `-D`, not `-d`: `-d` judges against the checkout's HEAD or upstream, which
  // rejects squash merges that the checks above already accepted.
  await run("git", ["-C", projectPath, "branch", "-D", branch], { timeoutMs: GIT_TIMEOUT_MS });
  return "deleted";
}

async function cleanupStateDirectories(
  entry: EnvironmentCleanupEntry,
  context: EnvironmentCleanupContext,
): Promise<void> {
  const dataDir = context.storage.getDataDir();
  for (const directory of entry.stateDirectories) {
    const relative = confinedRelativePath(dataDir, directory);
    if (!relative) throw new CleanupRefusedError("state directory is outside the data directory");
    if (!(await directoryExists(directory))) continue;
    await removeConfinedDirectory(dataDir, relative);
  }
}

const loggedKeptBranches = new Set<string>();

/**
 * Runs one step and records the outcome in the ledger. Never throws: a failed
 * step stays pending for the reconciler, which is what makes it safe for
 * deletion to carry on and remove the environment record regardless.
 */
export async function runEnvironmentCleanupStep(
  entry: EnvironmentCleanupEntry,
  step: EnvironmentCleanupStep,
  context: EnvironmentCleanupContext,
  options: CleanupStepOptions = {},
): Promise<boolean> {
  const ledger = environmentCleanupLedger(context.storage.getDataDir());
  const run = options.run ?? runCommand;
  try {
    if (step === "container") {
      await cleanupContainer(entry, context, run, options.containerOwnershipVerified === true);
    } else if (step === "worktree") await cleanupWorktree(entry, context, run);
    else if (step === "branch") {
      const outcome = await cleanupEnvironmentBranch(entry, run);
      if (outcome === "kept" && !loggedKeptBranches.has(entry.environmentId)) {
        loggedKeptBranches.add(entry.environmentId);
        console.info(
          `[backend] Kept the local branch of deleted environment ${entry.environmentId}: it may hold unmerged work`,
        );
      }
    } else await cleanupStateDirectories(entry, context);
  } catch (error) {
    const summary = redactCleanupError(error);
    console.warn(
      `[backend] Environment cleanup step ${step} failed for ${entry.environmentId}: ${summary}`,
    );
    await ledger.fail(entry.environmentId, step, summary).catch(() => undefined);
    return false;
  }
  await ledger.complete(entry.environmentId, step).catch((error: unknown) => {
    console.warn(
      `[backend] Failed to record environment cleanup for ${entry.environmentId}: ${redactCleanupError(error)}`,
    );
  });
  return true;
}

import { lstat, realpath } from "node:fs/promises";
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
import { removeEnvironmentNetwork } from "./container-network.js";
import type { Environment, Project } from "./models.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { removeConfinedDirectory } from "./path-safety.js";
import { CommandFailedError, pathExists, runCommand } from "./shell.js";
import { parseContainerLifecycle } from "@orkestrator/protocol/container-lifecycle";
import { DOCKER_LABEL_ENVIRONMENT_ID, DOCKER_LABEL_OWNER } from "./constants.js";
import { dockerOwnerNamespace } from "./docker-ownership.js";

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
  // The project home's directory and branch are the user's checkout: deleting
  // the record must never schedule removal of either.
  const projectHome = isProjectHomeEnvironment(environment);
  const worktreePath = projectHome ? null : environment.worktreePath?.trim() || null;
  const ownsBranch =
    !projectHome &&
    environment.environmentType === "local" &&
    !!projectPath &&
    !!worktreePath &&
    !!environment.branch;
  const pending: EnvironmentCleanupStep[] = [];
  const retainedContainers = retainedContainerIds(environment);
  if (environment.containerId || retainedContainers.length > 0) pending.push("container");
  const volumes = storageVolumeNames(environment);
  if (volumes.length > 0) pending.push("volumes");
  // The environment's own Docker network (policy 2); absent is success.
  if (environment.environmentType === "containerized") pending.push("network");
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
    retainedContainers,
    volumes,
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
  if (containerId) {
    // Refuses a container another development profile owns, and an
    // unreachable daemon; a container the daemon has forgotten passes.
    if (!ownershipVerified) await assertDockerContainerOwned(containerId, context);
    try {
      await run("docker", ["rm", "-f", containerId], { timeoutMs: DOCKER_TIMEOUT_MS });
    } catch (error) {
      if (!isMissingDockerObjectError(error)) throw error;
    }
  }
  // Recovery copies go with the environment, each verified on its own.
  for (const retained of entry.retainedContainers ?? []) {
    await assertDockerContainerOwned(retained, context);
    try {
      await run("docker", ["rm", "-f", retained], { timeoutMs: DOCKER_TIMEOUT_MS });
    } catch (error) {
      if (!isMissingDockerObjectError(error)) throw error;
    }
  }
}

/** Every earlier runtime the environment keeps as a recovery copy. */
export function retainedContainerIds(environment: Environment): string[] {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) return [];
  return [...new Set((parsed.record.retainedRuntimes ?? []).map((runtime) => runtime.containerId))];
}

/** Every storage volume the environment's lifecycle record names. */
export function storageVolumeNames(environment: Environment): string[] {
  const parsed = parseContainerLifecycle(environment.containerLifecycle);
  if (!parsed.supported) return [];
  const names = new Set<string>();
  for (const volume of parsed.record.storage.volumes ?? []) names.add(volume.name);
  for (const retained of parsed.record.retainedStorage ?? []) {
    for (const volume of retained.volumes ?? []) names.add(volume.name);
  }
  return [...names];
}

async function cleanupVolumes(
  entry: EnvironmentCleanupEntry,
  context: EnvironmentCleanupContext,
  run: CleanupCommandRunner,
): Promise<void> {
  const owner = dockerOwnerNamespace(context.storage.getDataDir());
  for (const name of entry.volumes) {
    let labels: Record<string, string>;
    try {
      const { stdout } = await run(
        "docker",
        ["volume", "inspect", "--format", "{{json .Labels}}", name],
        { timeoutMs: DOCKER_TIMEOUT_MS },
      );
      labels = (JSON.parse(stdout.trim() || "{}") ?? {}) as Record<string, string>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Already gone counts as removed.
      if (/no such volume/i.test(message)) continue;
      throw error;
    }
    // A volume is removed only while it still names this owner and
    // environment; a reused name belonging to something else is left alone.
    if (
      labels[DOCKER_LABEL_OWNER] !== owner ||
      labels[DOCKER_LABEL_ENVIRONMENT_ID] !== entry.environmentId
    ) {
      throw new CleanupRefusedError("volume is not owned by this environment");
    }
    try {
      // Never forced: a volume still mounted by some container stays and the
      // step is retried after that container is gone.
      await run("docker", ["volume", "rm", name], { timeoutMs: DOCKER_TIMEOUT_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/no such volume/i.test(message)) throw error;
    }
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
  const baseDir = getWorktreeBaseDir(context);
  const relative = confinedRelativePath(baseDir, worktreePath);
  if (!relative) throw new CleanupRefusedError("worktree is outside the workspaces root");
  if (await directoryExists(worktreePath)) {
    const canonicalRoot = await realpath(baseDir);
    const canonicalWorktree = await realpath(worktreePath);
    if (!confinedRelativePath(canonicalRoot, canonicalWorktree)) {
      throw new CleanupRefusedError("worktree is outside the workspaces root");
    }
  }
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

async function gitPredicate(
  run: CleanupCommandRunner,
  projectPath: string,
  args: string[],
): Promise<boolean> {
  try {
    await run("git", ["-C", projectPath, ...args], { timeoutMs: GIT_TIMEOUT_MS });
    return true;
  } catch (error) {
    if (error instanceof CommandFailedError && error.exitCode === 1 && !error.timedOut)
      return false;
    // Git's ordinary false predicate exits 1. Locks, timeouts and invalid
    // repositories are retryable errors, not evidence that a ref is absent.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
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
  } catch (error) {
    if (args[0] === "symbolic-ref" && error instanceof CommandFailedError && error.exitCode === 1)
      return null;
    if (args[0] === "symbolic-ref" && (error as { code?: unknown }).code === 1) return null;
    throw error;
  }
}

async function refExists(
  run: CleanupCommandRunner,
  projectPath: string,
  ref: string,
): Promise<boolean> {
  return gitPredicate(run, projectPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
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
  return gitPredicate(run, projectPath, ["merge-base", "--is-ancestor", commit, ref]);
}

async function branchCheckedOut(
  run: CleanupCommandRunner,
  projectPath: string,
  branch: string,
): Promise<boolean> {
  const listing = await gitOutput(run, projectPath, ["worktree", "list", "--porcelain"]);
  if (listing === null) throw new CleanupRefusedError("worktree list unavailable");
  return listing.split("\n").some((line) => line.trim() === `branch refs/heads/${branch}`);
}

export type BranchCleanupOutcome = "deleted" | "kept" | "absent";

/**
 * Deletes the environment's local branch only when no work would be lost:
 * - its PR was merged, and the branch tip is proven to be pushed;
 * - its tip is already contained in a merge target such as `origin/HEAD`; or
 * - it has no commits beyond the one the environment was created from.
 * Anything else is kept.
 */
export async function cleanupEnvironmentBranch(
  entry: EnvironmentCleanupEntry,
  run: CleanupCommandRunner = runCommand,
): Promise<BranchCleanupOutcome> {
  const projectPath = entry.projectPath;
  if (!projectPath || !entry.branch) return "absent";
  if (!(await pathExists(projectPath)))
    throw new CleanupRefusedError("project checkout unavailable");
  let branch: string;
  try {
    branch = validateGitRefName(entry.branch, "environment branch");
  } catch {
    return "kept";
  }
  const localRef = `refs/heads/${branch}`;
  const localExists = await refExists(run, projectPath, localRef);
  if (!localExists) return "absent";
  const tip = await gitOutput(run, projectPath, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${localRef}^{commit}`,
  ]);
  if (!tip) throw new CleanupRefusedError("branch tip unavailable");
  if (await branchCheckedOut(run, projectPath, branch)) return "kept";

  let disposable = false;
  if (entry.prMerged) {
    const tracking = `refs/remotes/origin/${branch}`;
    // Commits made after the PR merged exist only locally. When the pushed
    // branch is still known, the local tip must not be ahead of it.
    disposable =
      (await refExists(run, projectPath, tracking)) &&
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
    } else if (step === "volumes") {
      // Read back the ledger: the caller's entry predates the container step.
      const current = await ledger.get(entry.environmentId);
      if ((current ?? entry).pending.includes("container")) {
        throw new CleanupRefusedError("container removal is still pending");
      }
      await cleanupVolumes(entry, context, run);
    } else if (step === "network") {
      const current = await ledger.get(entry.environmentId);
      if ((current ?? entry).pending.includes("container")) {
        throw new CleanupRefusedError("container removal is still pending");
      }
      const result = await removeEnvironmentNetwork(context, entry.environmentId);
      if (result === "in-use") throw new CleanupRefusedError("network still has containers");
      if (result === "unreachable") throw new CleanupRefusedError("docker unreachable");
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

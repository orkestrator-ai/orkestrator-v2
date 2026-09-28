import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";

import {
  environmentBranchNamespace,
  parseEnvironmentBranchNamespace,
} from "./commands-agent-support.js";
import type { CommandContext } from "./commands-context.js";
import {
  enqueueEnvironmentLifecycleOperation,
  getWorktreeBaseDir,
} from "./commands-environment.js";
import {
  ENVIRONMENT_CLEANUP_STEPS,
  environmentCleanupLedger,
  environmentCleanupSweepState,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import {
  cleanupEnvironmentBranch,
  redactCleanupError,
  runEnvironmentCleanupStep,
  type CleanupCommandRunner,
  type CleanupStepOptions,
} from "./environment-cleanup.js";
import {
  ENVIRONMENT_STATE_ROOTS,
  environmentStateKey,
  isEnvironmentStateKey,
} from "./environment-state-paths.js";
import { isPidAlive } from "./local-server-reaper.js";
import type { Project } from "./models.js";
import { removeConfinedDirectory } from "./path-safety.js";
import { pathExists, runCommand } from "./shell.js";

/** After this many passes an entry is kept for inspection but no longer retried. */
export const MAX_ENVIRONMENT_CLEANUP_ATTEMPTS = 8;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
/**
 * A state directory is created when a bridge starts, which can race a sweep
 * that listed environments a moment earlier. Anything this recent is left for
 * the next pass rather than trusted to be an orphan.
 */
export const ORPHANED_STATE_MIN_AGE_MS = 60 * 60_000;

export type EnvironmentCleanupReconcileOptions = CleanupStepOptions & {
  now?: () => Date;
};

export function environmentCleanupRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts));
}

function retryDueAt(entry: EnvironmentCleanupEntry): number {
  const last = entry.lastAttemptAt ? Date.parse(entry.lastAttemptAt) : Number.NaN;
  if (!Number.isFinite(last)) return 0;
  return last + environmentCleanupRetryDelayMs(entry.attempts);
}

const exhaustedWarnings = new Set<string>();

export type EnvironmentCleanupReconcileResult = {
  attempted: number;
  /** Earliest time a deferred entry becomes due, if any is still retryable. */
  nextDueAt: number | null;
};

/**
 * Retries every step a deletion could not finish. Only what a ledger entry
 * names is touched, and only once the environment record is gone: while it
 * exists, interrupted-deletion recovery owns the whole delete path.
 */
export async function reconcileEnvironmentCleanup(
  context: CommandContext,
  options: EnvironmentCleanupReconcileOptions = {},
): Promise<EnvironmentCleanupReconcileResult> {
  const now = options.now ?? (() => new Date());
  const ledger = environmentCleanupLedger(context.storage.getDataDir());
  const entries = await ledger.list();
  if (entries.length === 0) return { attempted: 0, nextDueAt: null };
  const liveIds = new Set(
    (await context.storage.loadEnvironments()).map((environment) => environment.id),
  );
  let attempted = 0;
  let nextDueAt: number | null = null;
  for (const entry of entries) {
    if (liveIds.has(entry.environmentId)) continue;
    if (entry.attempts >= MAX_ENVIRONMENT_CLEANUP_ATTEMPTS) {
      if (!exhaustedWarnings.has(entry.environmentId)) {
        exhaustedWarnings.add(entry.environmentId);
        console.warn(
          `[backend] Cleanup for deleted environment ${entry.environmentId} is still failing after ${entry.attempts} attempts (${entry.lastError ?? "unknown"}); pending: ${entry.pending.join(", ")}`,
        );
      }
      continue;
    }
    const dueAt = retryDueAt(entry);
    if (dueAt > now().getTime()) {
      nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
      continue;
    }
    attempted += 1;
    try {
      await enqueueEnvironmentLifecycleOperation(entry.environmentId, context, async () => {
        const current = await ledger.get(entry.environmentId);
        if (!current) return;
        await ledger.noteAttempt(current.environmentId, now());
        let worktreeDone = !current.pending.includes("worktree");
        for (const step of ENVIRONMENT_CLEANUP_STEPS) {
          if (!current.pending.includes(step)) continue;
          // The branch cannot be judged while a worktree may still have it
          // checked out.
          if (step === "branch" && !worktreeDone) continue;
          const done = await runEnvironmentCleanupStep(current, step, context, options);
          if (step === "worktree") worktreeDone = done;
        }
      });
    } catch (error) {
      // Admission closes at shutdown; the entry stays for the next start.
      console.warn(
        `[backend] Environment cleanup retry was not admitted for ${entry.environmentId}: ${redactCleanupError(error)}`,
      );
    }
    const remaining = await ledger.get(entry.environmentId);
    if (remaining && remaining.attempts < MAX_ENVIRONMENT_CLEANUP_ATTEMPTS) {
      const due = retryDueAt(remaining);
      nextDueAt = nextDueAt === null ? due : Math.min(nextDueAt, due);
    }
  }
  return { attempted, nextDueAt };
}

async function stateOwnerKeys(context: CommandContext): Promise<Set<string>> {
  const owners = new Set<string>();
  for (const environment of await context.storage.loadEnvironments()) {
    owners.add(environmentStateKey(environment.id));
  }
  // Coordinator conversations run the same bridges under a runtime id, so
  // their state lives in the same roots and must count as owned.
  if (typeof context.storage.listCoordinatorWorkspaces === "function") {
    for (const workspace of await context.storage.listCoordinatorWorkspaces()) {
      try {
        owners.add(environmentStateKey(coordinatorRuntimeId(workspace.id)));
        for (const conversation of workspace.conversations ?? []) {
          owners.add(environmentStateKey(coordinatorRuntimeId(workspace.id, conversation.id)));
        }
      } catch {
        // An id the protocol rejects never started a bridge.
      }
    }
  }
  return owners;
}

/**
 * Removes bridge state directories whose owner no longer exists. Ownership is
 * provable from the directory name alone, so this also clears state left by
 * builds that predate the cleanup ledger. Any failure to list the owners
 * aborts the sweep: an incomplete owner set would make live state look orphaned.
 */
export async function sweepOrphanedEnvironmentState(
  context: CommandContext,
  options: { now?: () => Date } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const dataDir = context.storage.getDataDir();
  const owners = await stateOwnerKeys(context);
  let removed = 0;
  for (const root of ENVIRONMENT_STATE_ROOTS) {
    let names: string[];
    try {
      names = await readdir(path.join(dataDir, root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const name of names) {
      if (!isEnvironmentStateKey(name) || owners.has(name)) continue;
      const stats = await lstat(path.join(dataDir, root, name)).catch(() => null);
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) continue;
      if (now().getTime() - stats.mtimeMs < ORPHANED_STATE_MIN_AGE_MS) continue;
      try {
        await removeConfinedDirectory(dataDir, `${root}/${name}`);
        removed += 1;
      } catch (error) {
        console.warn(
          `[backend] Failed to remove orphaned ${root} state: ${redactCleanupError(error)}`,
        );
      }
    }
  }
  return removed;
}

/** How often each project's local branches are checked for orphans. */
export const ORPHANED_BRANCH_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
/**
 * The pre-ledger sweeps have no environment of their own. This key only queues
 * them behind each other and under lifecycle admission; it is not a UUID, so
 * it never shares a queue with an environment.
 */
const PRE_LEDGER_SWEEP_QUEUE_KEY = "orphaned-disk-state-sweep";
/** A workspace directory with more entries than this is treated as content. */
const MAX_STRAY_DIRECTORY_ENTRIES = 10_000;
/** Candidates beyond this wait for the project's next daily pass. */
const MAX_ORPHANED_BRANCHES_PER_PASS = 500;
const SWEEP_GIT_TIMEOUT_MS = 30_000;
/** `<store>.json.<pid>.tmp`, as written by the PID-named atomic writers. */
const PID_TEMP_FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.json\.([1-9][0-9]{0,9})\.tmp$/;

export type PreLedgerSweepOptions = {
  now?: () => Date;
  run?: CleanupCommandRunner;
  /** Checked between branches so shutdown is not held by a long pass. */
  isCancelled?: () => boolean;
};

async function canonicalForms(target: string): Promise<string[]> {
  const resolved = path.resolve(target);
  const real = await realpath(resolved).catch(() => null);
  return real && real !== resolved ? [resolved, real] : [resolved];
}

function isSameOrInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

type WorktreeListing = { paths: string[]; branches: Set<string> };

/**
 * What git registers for a project checkout. A path with no `.git` has no
 * repository and so no worktrees; any other failure throws, because a missing
 * listing would make a registered worktree look unowned.
 */
async function projectWorktreeListing(
  run: CleanupCommandRunner,
  projectPath: string,
): Promise<WorktreeListing> {
  const listing: WorktreeListing = { paths: [], branches: new Set() };
  if (!(await pathExists(path.join(projectPath, ".git")))) return listing;
  const { stdout } = await run("git", ["-C", projectPath, "worktree", "list", "--porcelain"], {
    timeoutMs: SWEEP_GIT_TIMEOUT_MS,
  });
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) listing.paths.push(line.slice("worktree ".length));
    else if (line.startsWith("branch refs/heads/")) {
      listing.branches.add(line.slice("branch refs/heads/".length).trim());
    }
  }
  return listing;
}

async function localProjects(
  context: CommandContext,
  all?: Project[],
): Promise<Array<{ project: Project; projectPath: string }>> {
  const projects: Array<{ project: Project; projectPath: string }> = [];
  for (const project of all ?? (await context.storage.loadProjects())) {
    const projectPath = project.localPath?.trim();
    if (projectPath && (await pathExists(projectPath))) projects.push({ project, projectPath });
  }
  return projects;
}

/** Every path a live or deleting environment, the ledger, or git claims. */
async function ownedWorkspacePaths(
  context: CommandContext,
  run: CleanupCommandRunner,
): Promise<string[]> {
  const claimed: string[] = [];
  for (const environment of await context.storage.loadEnvironments()) {
    if (environment.worktreePath) claimed.push(environment.worktreePath);
  }
  for (const entry of await environmentCleanupLedger(context.storage.getDataDir()).list()) {
    if (entry.worktreePath) claimed.push(entry.worktreePath);
  }
  for (const { projectPath } of await localProjects(context)) {
    claimed.push(projectPath, ...(await projectWorktreeListing(run, projectPath)).paths);
  }
  return (await Promise.all(claimed.map(canonicalForms))).flat();
}

function isKnownBuildLog(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.at(-2) === ".turbo" && /^turbo-[^/]*\.log$/.test(segments.at(-1) ?? "");
}

type WorkspaceDirectoryInspection = { hasContent: boolean; newestMtimeMs: number };

/**
 * Walks `root` without following symlinks. Anything other than directories
 * and `**\/.turbo/turbo-*.log` counts as content, as does a tree too large or
 * too unreadable to finish. Null means the tree vanished during the walk.
 */
async function inspectWorkspaceDirectory(
  root: string,
): Promise<WorkspaceDirectoryInspection | null> {
  let newestMtimeMs = 0;
  let seen = 0;
  const pending = [""];
  try {
    while (pending.length > 0) {
      const relative = pending.pop()!;
      const directory = relative ? path.join(root, relative) : root;
      const stats = await lstat(directory);
      if (!stats.isDirectory()) return { hasContent: true, newestMtimeMs };
      newestMtimeMs = Math.max(newestMtimeMs, stats.mtimeMs);
      for (const dirent of await readdir(directory, { withFileTypes: true })) {
        if (++seen > MAX_STRAY_DIRECTORY_ENTRIES) return { hasContent: true, newestMtimeMs };
        const child = relative ? `${relative}/${dirent.name}` : dirent.name;
        if (dirent.isDirectory()) pending.push(child);
        else if (dirent.isFile() && isKnownBuildLog(child)) {
          newestMtimeMs = Math.max(newestMtimeMs, (await lstat(path.join(root, child))).mtimeMs);
        } else return { hasContent: true, newestMtimeMs };
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { hasContent: true, newestMtimeMs };
  }
  return { hasContent: false, newestMtimeMs };
}

export type StrayWorkspaceSweepResult = {
  removed: number;
  /** Unowned directories kept because they hold something besides build logs. */
  keptWithContent: number;
};

/**
 * Removes directories in the workspaces root that nothing owns and that hold
 * nothing but build logs a process re-created after its worktree was removed.
 * Creation never allocates a path that already exists, and the age check
 * covers a worktree whose environment record is still being written.
 */
export async function sweepStrayWorkspaceDirectories(
  context: CommandContext,
  options: PreLedgerSweepOptions = {},
): Promise<StrayWorkspaceSweepResult> {
  const now = options.now ?? (() => new Date());
  const run = options.run ?? runCommand;
  const result: StrayWorkspaceSweepResult = { removed: 0, keptWithContent: 0 };
  const baseDir = getWorktreeBaseDir(context);
  let names: string[];
  try {
    names = (await readdir(baseDir, { withFileTypes: true }))
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  if (names.length === 0) return result;
  const canonicalBase = await realpath(baseDir);
  const owned = await ownedWorkspacePaths(context, run);
  for (const name of names) {
    const forms = [path.resolve(baseDir, name), path.join(canonicalBase, name)];
    if (owned.some((claimed) => forms.some((form) => isSameOrInside(form, claimed)))) continue;
    const inspection = await inspectWorkspaceDirectory(path.join(canonicalBase, name));
    if (!inspection) continue;
    if (inspection.hasContent) {
      result.keptWithContent += 1;
      continue;
    }
    if (now().getTime() - inspection.newestMtimeMs < ORPHANED_STATE_MIN_AGE_MS) continue;
    try {
      await removeConfinedDirectory(canonicalBase, name);
      result.removed += 1;
    } catch (error) {
      console.warn(
        `[backend] Failed to remove a stray workspace directory: ${redactCleanupError(error)}`,
      );
    }
  }
  return result;
}

/**
 * The commit a branch was created at, from the oldest entry of its reflog,
 * when that entry still records the creation. An expired or missing reflog
 * gives null, which leaves only the merge-target test.
 */
async function branchStartPoint(
  run: CleanupCommandRunner,
  projectPath: string,
  branch: string,
): Promise<string | null> {
  try {
    const { stdout } = await run(
      "git",
      ["-C", projectPath, "reflog", "show", "--format=%H %gs", `refs/heads/${branch}`, "--"],
      { timeoutMs: SWEEP_GIT_TIMEOUT_MS },
    );
    const oldest = stdout.trim().split("\n").at(-1) ?? "";
    return /^([0-9a-f]{40}|[0-9a-f]{64}) branch: Created from /.exec(oldest)?.[1] ?? null;
  } catch {
    return null;
  }
}

type BranchOwners = { namespaces: Set<string>; branches: Set<string> };

async function environmentBranchOwners(context: CommandContext): Promise<BranchOwners> {
  const owners: BranchOwners = { namespaces: new Set(), branches: new Set() };
  for (const environment of await context.storage.loadEnvironments()) {
    owners.namespaces.add(environmentBranchNamespace(environment.id));
    if (environment.branch) owners.branches.add(environment.branch);
    if (environment.delegationBaseBranch) owners.branches.add(environment.delegationBaseBranch);
  }
  for (const entry of await environmentCleanupLedger(context.storage.getDataDir()).list()) {
    owners.namespaces.add(environmentBranchNamespace(entry.environmentId));
    if (entry.branch) owners.branches.add(entry.branch);
  }
  return owners;
}

type BranchSweepCounts = { deleted: number; kept: number };

async function sweepProjectBranches(
  context: CommandContext,
  project: Project,
  projectPath: string,
  owners: BranchOwners,
  run: CleanupCommandRunner,
  isCancelled: () => boolean,
  now: Date,
): Promise<(BranchSweepCounts & { complete: boolean }) | null> {
  if (!(await pathExists(path.join(projectPath, ".git")))) return null;
  const listing = await projectWorktreeListing(run, projectPath);
  const refs = await run(
    "git",
    ["-C", projectPath, "for-each-ref", "--format=%(refname)", "refs/heads/"],
    { timeoutMs: SWEEP_GIT_TIMEOUT_MS },
  );
  const defaultBranch = await context.storage
    .getRepositoryConfig(project.id)
    .then((config) => config.defaultBranch?.trim() || null)
    .catch(() => null);
  const originHead = await run(
    "git",
    ["-C", projectPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { timeoutMs: SWEEP_GIT_TIMEOUT_MS },
  )
    .then(({ stdout }) => stdout.trim().replace(/^origin\//, "") || null)
    .catch(() => null);
  // Checked-out branches, including the checkout's own, and the default branch
  // are never candidates; `cleanupEnvironmentBranch` re-checks the former.
  const refused = new Set([...listing.branches, defaultBranch, originHead]);
  const counts = { deleted: 0, kept: 0, complete: true };
  let examined = 0;
  for (const line of refs.stdout.split("\n")) {
    if (!line.startsWith("refs/heads/")) continue;
    const branch = line.slice("refs/heads/".length);
    const namespace = parseEnvironmentBranchNamespace(branch);
    if (!namespace || owners.namespaces.has(namespace) || owners.branches.has(branch)) continue;
    if (refused.has(branch)) continue;
    if (isCancelled() || !context.environmentLifecycleTasks.isAccepting()) {
      counts.complete = false;
      break;
    }
    if (++examined > MAX_ORPHANED_BRANCHES_PER_PASS) break;
    try {
      // A pre-ledger branch has no recorded PR state, so only the merge-target
      // and no-new-commits tests of the deletion policy can pass.
      const outcome = await cleanupEnvironmentBranch(
        {
          version: 1,
          environmentId: `orphaned-branch:${namespace}`,
          recordedAt: now.toISOString(),
          projectPath,
          worktreePath: null,
          branch,
          prMerged: false,
          createdFromCommit: await branchStartPoint(run, projectPath, branch),
          baseBranches: defaultBranch ? [defaultBranch] : [],
          containerId: null,
          stateDirectories: [],
          pending: ["branch"],
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
        },
        run,
      );
      if (outcome === "deleted") counts.deleted += 1;
      else if (outcome === "kept") counts.kept += 1;
    } catch {
      counts.kept += 1;
    }
  }
  return counts;
}

/**
 * Deletes local branches named by the environment scheme whose environment is
 * gone, only when the deletion policy proves no work is lost. Each project is
 * checked at most once per {@link ORPHANED_BRANCH_SWEEP_INTERVAL_MS}; a pass
 * that fails or is cut short by shutdown is retried on the next sweep.
 */
export async function sweepOrphanedEnvironmentBranches(
  context: CommandContext,
  options: PreLedgerSweepOptions = {},
): Promise<BranchSweepCounts> {
  const now = options.now ?? (() => new Date());
  const run = options.run ?? runCommand;
  const isCancelled = options.isCancelled ?? (() => false);
  const sweepState = environmentCleanupSweepState(context.storage.getDataDir());
  const totals: BranchSweepCounts = { deleted: 0, kept: 0 };
  const allProjects = await context.storage.loadProjects();
  const projects = await localProjects(context, allProjects);
  if (projects.length === 0) return totals;
  const lastRuns = await sweepState.branchSweeps();
  const knownProjectIds = allProjects.map((project) => project.id);
  let owners: BranchOwners | null = null;
  let firstError: unknown = null;
  for (const { project, projectPath } of projects) {
    const lastRun = Date.parse(lastRuns[project.id] ?? "");
    if (Number.isFinite(lastRun) && now().getTime() - lastRun < ORPHANED_BRANCH_SWEEP_INTERVAL_MS) {
      continue;
    }
    if (isCancelled()) break;
    try {
      owners ??= await environmentBranchOwners(context);
      const counts = await sweepProjectBranches(
        context,
        project,
        projectPath,
        owners,
        run,
        isCancelled,
        now(),
      );
      if (counts) {
        totals.deleted += counts.deleted;
        totals.kept += counts.kept;
        if (!counts.complete) break;
      }
      await sweepState.recordBranchSweep(project.id, now(), knownProjectIds);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
  return totals;
}

/**
 * Removes `<store>.json.<pid>.tmp` files in the data directory that a writer
 * abandoned: the PID is no longer running and the file is over an hour old.
 * A reused PID only keeps a file longer.
 */
export async function sweepAbandonedTempFiles(
  context: CommandContext,
  options: PreLedgerSweepOptions = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const dataDir = context.storage.getDataDir();
  let removed = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const dirent of entries) {
    if (!dirent.isFile()) continue;
    const pid = Number(PID_TEMP_FILE_PATTERN.exec(dirent.name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const file = path.join(dataDir, dirent.name);
    const stats = await lstat(file).catch(() => null);
    if (!stats?.isFile() || now().getTime() - stats.mtimeMs < ORPHANED_STATE_MIN_AGE_MS) continue;
    if (isPidAlive(pid)) continue;
    try {
      await unlink(file);
      removed += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}

const loggedSweepFailures = new Set<string>();
const reportedStrayWithContent = new Map<string, number>();

function warnSweepFailureOnce(sweep: string, error: unknown): void {
  if (loggedSweepFailures.has(sweep)) return;
  loggedSweepFailures.add(sweep);
  console.warn(`[backend] ${sweep} sweep failed: ${redactCleanupError(error)}`);
}

/**
 * Leftovers from before the cleanup ledger existed, whose ownership is still
 * provable: file-less workspace directories, orphaned environment branches,
 * and abandoned temp files. Runs as one admitted lifecycle operation so
 * shutdown neither starts it late nor waits on a long pass. Each sweep fails
 * alone and logs once per process; this never rejects.
 */
export async function sweepPreLedgerDiskState(
  context: CommandContext,
  options: PreLedgerSweepOptions = {},
): Promise<void> {
  const isCancelled = options.isCancelled ?? (() => false);
  const dataDirKey = path.resolve(context.storage.getDataDir());
  try {
    await enqueueEnvironmentLifecycleOperation(PRE_LEDGER_SWEEP_QUEUE_KEY, context, async () => {
      try {
        const { removed, keptWithContent } = await sweepStrayWorkspaceDirectories(context, options);
        if (removed > 0) {
          console.info(`[backend] Removed ${removed} stray workspace director(ies)`);
        }
        if (keptWithContent !== (reportedStrayWithContent.get(dataDirKey) ?? 0)) {
          reportedStrayWithContent.set(dataDirKey, keptWithContent);
          if (keptWithContent > 0) {
            console.info(
              `[backend] Kept ${keptWithContent} unowned workspace director(ies) that hold files; remove them by hand if unneeded`,
            );
          }
        }
      } catch (error) {
        warnSweepFailureOnce("Stray workspace directory", error);
      }
      if (isCancelled()) return;
      try {
        const { deleted, kept } = await sweepOrphanedEnvironmentBranches(context, options);
        if (deleted > 0 || kept > 0) {
          console.info(
            `[backend] Orphaned environment branches: deleted ${deleted}, kept ${kept} that may hold unmerged work`,
          );
        }
      } catch (error) {
        warnSweepFailureOnce("Orphaned environment branch", error);
      }
      if (isCancelled()) return;
      try {
        const removed = await sweepAbandonedTempFiles(context, options);
        if (removed > 0) console.info(`[backend] Removed ${removed} abandoned temp file(s)`);
      } catch (error) {
        warnSweepFailureOnce("Abandoned temp file", error);
      }
    });
  } catch (error) {
    // Admission closes at shutdown; the next start sweeps again.
    warnSweepFailureOnce("Pre-ledger disk state", error);
  }
}

type ScheduledReconcile = {
  running: Promise<void> | null;
  rerun: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  orphanTimer: ReturnType<typeof setTimeout> | null;
  cancelled: boolean;
};

const scheduled = new Map<string, ScheduledReconcile>();

/**
 * Runs the reconciler in the background, at most one pass at a time per data
 * directory, and re-arms itself for the earliest deferred retry. Never
 * rejects: cleanup is best-effort and must not surface as an unhandled
 * rejection in the backend.
 */
export function scheduleEnvironmentCleanupReconcile(
  context: CommandContext,
  options: EnvironmentCleanupReconcileOptions = {},
): void {
  const key = path.resolve(context.storage.getDataDir());
  const state = scheduled.get(key) ?? {
    running: null,
    rerun: false,
    timer: null,
    orphanTimer: null,
    cancelled: false,
  };
  scheduled.set(key, state);
  if (state.running) {
    state.rerun = true;
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.running = (async () => {
    try {
      const result = await reconcileEnvironmentCleanup(context, options);
      if (result.nextDueAt !== null && !state.rerun && !state.cancelled) {
        const delay = Math.max(1_000, result.nextDueAt - Date.now());
        state.timer = setTimeout(() => {
          state.timer = null;
          if (!state.cancelled) scheduleEnvironmentCleanupReconcile(context, options);
        }, delay);
        state.timer.unref?.();
      }
    } catch (error) {
      console.warn(`[backend] Environment cleanup reconcile failed: ${redactCleanupError(error)}`);
    } finally {
      state.running = null;
      if (state.rerun && !state.cancelled) {
        state.rerun = false;
        scheduleEnvironmentCleanupReconcile(context, options);
      }
    }
  })();
}

/** Cancels any armed retry timer, for shutdown and tests. */
export function cancelScheduledEnvironmentCleanup(dataDir: string): void {
  const state = scheduled.get(path.resolve(dataDir));
  if (state) {
    state.cancelled = true;
    state.rerun = false;
  }
  if (state?.timer) clearTimeout(state.timer);
  if (state?.orphanTimer) clearTimeout(state.orphanTimer);
  scheduled.delete(path.resolve(dataDir));
}

/**
 * Startup pass: clear provable orphans, then finish owed cleanup in the
 * background. The orphan sweeps repeat hourly; the branch sweep throttles
 * itself per project.
 */
export async function runStartupEnvironmentCleanup(
  context: CommandContext,
  options: { orphanSweepIntervalMs?: number } = {},
): Promise<void> {
  scheduleEnvironmentCleanupReconcile(context);
  const state = scheduled.get(path.resolve(context.storage.getDataDir()))!;
  if (state.orphanTimer) clearTimeout(state.orphanTimer);
  state.orphanTimer = null;
  const interval = options.orphanSweepIntervalMs ?? ORPHANED_STATE_MIN_AGE_MS;
  const sweep = async () => {
    if (state.cancelled) return;
    try {
      try {
        const removed = await sweepOrphanedEnvironmentState(context);
        if (removed > 0) {
          console.info(`[backend] Removed ${removed} orphaned environment state director(ies)`);
        }
      } catch (error) {
        console.warn(
          `[backend] Orphaned environment state sweep failed: ${redactCleanupError(error)}`,
        );
      }
      if (!state.cancelled) {
        await sweepPreLedgerDiskState(context, { isCancelled: () => state.cancelled });
      }
    } finally {
      if (!state.cancelled) {
        state.orphanTimer = setTimeout(() => {
          state.orphanTimer = null;
          void sweep();
        }, interval);
        state.orphanTimer.unref?.();
      }
    }
  };
  await sweep();
}

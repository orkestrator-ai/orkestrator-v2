import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  canonicalWorktreePath,
  captureWorktreePathIdentity,
} from "@orkestrator/protocol/node/worktree-paths";

import type { CommandContext } from "./commands-context.js";
import { stopLocalServersForEnvironmentUnlocked } from "./commands-local-server-lifecycle.js";
import { assertEnvironmentDeletionNotRequested } from "./commands-terminal.js";
import { enqueueEnvironmentLifecycleOperation } from "./commands-environment.js";
import type { EnvironmentMutationFence } from "./environment-replacement-fence.js";
import {
  defaultSessionRelocationHomes,
  relocateAgentSessionState,
  type SessionRelocationHomes,
} from "./environment-move-sessions.js";
import type { Environment, WorktreeMoveRecord, WorktreeMoveSubmodule } from "./models.js";
import { removeConfinedDirectory } from "./path-safety.js";
import { isProjectHomeEnvironment } from "./project-home-environment.js";
import { stopEnvironmentExecWorkers } from "./public-api/exec-control.js";
import { stopEnvironmentReviewValidation } from "./review-validation-service.js";
import { pathExists, runCommand } from "./shell.js";
import type { StorageService } from "./storage.js";
import { tmuxManager } from "./tmux-session-manager.js";
import { cleanupEnvironmentTmux } from "./tmux-commands.js";
import { getWorktreeBaseDir, validateWorktreeLocation } from "./worktree-locations.js";

const GIT_TIMEOUT_MS = 120_000;
// A copy to another disk carries dependencies and build output too.
const COPY_TIMEOUT_MS = 2 * 60 * 60_000;

export const AGENT_ACTIVE_MOVE_ERROR =
  "An agent is running in this environment. Wait for it to finish or stop it, then move the environment.";

export interface MoveEnvironmentOptions {
  /** Called once the environment's processes are stopped, before any file moves. */
  invalidateDiscovery?: (environmentId: string) => void;
  /** Tests: skip `git worktree move` and take the copy path used across disks. */
  forceCopy?: boolean;
  /** Tests: where each provider's folder-keyed session state lives. */
  sessionHomes?: SessionRelocationHomes;
}

/** Where a worktree goes when it is moved into `destinationRoot`: its folder name is kept. */
export function movedWorktreePath(worktreePath: string, destinationRoot: string): string {
  return path.join(destinationRoot, path.basename(worktreePath));
}

function isSameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(canonicalWorktreePath(root), canonicalWorktreePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function confinedRelative(root: string, target: string): string | null {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative;
}

function isAgentActive(environment: Environment): boolean {
  const state = environment.agentActivityState ?? "idle";
  return state === "working" || state === "waiting";
}

/**
 * Every reason a move is refused that can be decided from the record alone.
 * Checked when the move is requested and again once it reaches the front of
 * the environment's lifecycle queue.
 */
export function assertEnvironmentMovable(
  environment: Environment,
  context: Pick<CommandContext, "runtime">,
): void {
  context.runtime.environments.assertNotDeleting(environment.id);
  assertEnvironmentDeletionNotRequested(environment, environment.id);
  if (environment.environmentType !== "local") {
    throw new Error("Only a local environment can be moved to another folder");
  }
  if (isProjectHomeEnvironment(environment)) {
    throw new Error("The project home works in the project's own checkout and cannot be moved");
  }
  if (!environment.worktreePath) {
    throw new Error("This environment has no worktree yet; start it before moving it");
  }
  if (environment.worktreeMove) {
    throw new Error(
      "Move recovery is pending. Restart Orkestrator to retry recovery before moving or editing this environment.",
    );
  }
  if (environment.lifecycleOperation || context.runtime.environments.isMerging(environment.id)) {
    throw new Error("Another operation is running for this environment");
  }
  if (context.runtime.environments.fence.isBeingReplaced(environment.id)) {
    throw new Error("Another operation is running for this environment");
  }
  if (environment.status === "creating" || environment.status === "stopping") {
    throw new Error("Wait for the environment to finish starting or stopping, then move it");
  }
  if (
    environment.setupPhase === "running" ||
    context.runtime.environments.hasSetupSession(environment.id)
  ) {
    throw new Error("Environment setup is still running; move the environment when it finishes");
  }
  if (isAgentActive(environment)) throw new Error(AGENT_ACTIVE_MOVE_ERROR);
}

/**
 * Moves a local environment's worktree, with every file in it, into another
 * folder. Serialized with the environment's other lifecycle operations and
 * with its bridge starts: a bridge or terminal asked for during the move
 * starts afterwards, in the new folder.
 */
export function moveEnvironmentTask(
  environmentId: string,
  destinationDir: unknown,
  context: CommandContext,
  options: MoveEnvironmentOptions = {},
): Promise<Environment> {
  if (context.runtime.localServers.isShuttingDown()) {
    return Promise.reject(new Error("Backend is shutting down; environments cannot be moved"));
  }
  try {
    if (!context.runtime.environments.fence.beginMove(environmentId)) {
      return Promise.reject(new Error("This environment is already being moved"));
    }
  } catch (error) {
    return Promise.reject(error);
  }
  context.runtime.environments.invalidateStartDedupe(environmentId);
  try {
    return enqueueEnvironmentLifecycleOperation(environmentId, context, () =>
      context.runtime.localServers.enqueueEnvironmentOperation(environmentId, () =>
        moveEnvironmentOnce(environmentId, destinationDir, context, options),
      ),
    ).finally(() => context.runtime.environments.fence.endMove(environmentId));
  } catch (error) {
    context.runtime.environments.fence.endMove(environmentId);
    throw error;
  }
}

async function assertFreshAgentIdle(environmentId: string, context: CommandContext): Promise<void> {
  if (tmuxManager.activityState(environmentId) !== "idle") throw new Error(AGENT_ACTIVE_MOVE_ERROR);
  await context.nativeAgents?.assertEnvironmentIdleForMove(environmentId);
}

async function moveEnvironmentOnce(
  environmentId: string,
  destinationDir: unknown,
  context: CommandContext,
  options: MoveEnvironmentOptions,
): Promise<Environment> {
  const { storage } = context;
  const environment = await storage.getEnvironment(environmentId);
  if (!environment) throw new Error(`Environment not found: ${environmentId}`);
  assertEnvironmentMovable(environment, context);
  const sessions = await storage.listNativeAgentSessions();
  if (
    sessions.some((session) => session.environmentId === environmentId && session.pendingDispatch)
  ) {
    throw new Error("An agent submission is unresolved; settle it before moving this environment");
  }
  await assertFreshAgentIdle(environmentId, context);
  const project = await storage.getProject(environment.projectId);
  const projectPath = project?.localPath?.trim();
  if (!projectPath || !(await pathExists(projectPath))) {
    throw new Error("The project checkout is unavailable; the worktree cannot be moved");
  }
  const from = path.resolve(environment.worktreePath!);
  const fromStats = await fs.stat(from).catch(() => null);
  if (!fromStats?.isDirectory()) {
    throw new Error(`The environment's worktree does not exist: ${from}`);
  }
  const destinationRoot = validateWorktreeLocation(destinationDir, {
    label: "Destination folder",
    dataDir: storage.getDataDir(),
    projectPath,
  });
  if (isSameOrInside(destinationRoot, from)) {
    throw new Error("The destination folder must not be inside the environment's worktree");
  }
  const to = movedWorktreePath(from, destinationRoot);
  if (canonicalWorktreePath(to) === canonicalWorktreePath(from)) {
    throw new Error("The environment is already in this folder");
  }
  if (await pathExists(to)) {
    throw new Error(`The destination already contains ${path.basename(to)}: ${to}`);
  }
  // Agents may have keyed their state by either spelling of the old folder.
  const fromResolved = canonicalWorktreePath(from);
  const fromRoot = environment.worktreeBaseDir
    ? path.resolve(environment.worktreeBaseDir)
    : getWorktreeBaseDir(context);

  context.runtime.environments.fence.bindMovePaths(environment.id, [from, fromResolved, to]);
  const startedAt = new Date().toISOString();
  let record: WorktreeMoveRecord = {
    from,
    to,
    fromCanonical: fromResolved,
    fromRoot,
    phase: "moving",
    startedAt,
    sourceIdentity: { dev: fromStats.dev, ino: fromStats.ino },
  };
  await storage.updateEnvironment(environment.id, {
    lifecycleOperation: "moving",
    lifecycleOperationStartedAt: startedAt,
    worktreeMove: record,
  });

  let moved = false;
  let committed = false;
  let commitAttempted = false;
  try {
    await assertFreshAgentIdle(environmentId, context);
    await quiesceLocalEnvironment(environment, context, options);
    // The prompt fence has been held since the move was admitted, so a turn
    // cannot have started since the check above; a stale "working" written
    // by a bridge that just stopped still refuses the move.
    await assertFreshAgentIdle(environmentId, context);
    const current = await storage.getEnvironment(environment.id);
    if (current && isAgentActive(current)) throw new Error(AGENT_ACTIVE_MOVE_ERROR);

    const recheckDestination = captureWorktreePathIdentity(destinationRoot);
    await fs.mkdir(destinationRoot, { recursive: true });
    recheckDestination();

    const viaGit = options.forceCopy
      ? { moved: false as const }
      : await tryGitWorktreeMove(projectPath, from, to);
    if (viaGit.moved) {
      moved = true;
    } else {
      // Submodule checkouts keep their git dirs in the repository; the copy
      // re-links each one to its new folder.
      const submodules = await listLinkedSubmodules(from);
      const staging = path.join(
        destinationRoot,
        `.${path.basename(to)}.orkestrator-move-${randomBytes(4).toString("hex")}`,
      );
      record = { ...record, staging, ...(submodules.length ? { submodules } : {}) };
      await storage.updateEnvironment(environment.id, { worktreeMove: record });
      let renamed = false;
      try {
        await runCommand("cp", ["-Rp", from, staging], { timeoutMs: COPY_TIMEOUT_MS });
        recheckDestination();
        if (await pathExists(to)) throw new Error(`The destination already contains ${to}`);
        await fs.rename(staging, to);
        renamed = true;
        // Points the repository's record of this worktree at the copy. Until
        // it succeeds the original stays the worktree git knows about.
        await runCommand("git", ["-C", projectPath, "worktree", "repair", to], {
          timeoutMs: GIT_TIMEOUT_MS,
        });
        await relinkSubmodules(to, submodules);
      } catch (error) {
        await removeInside(destinationRoot, staging).catch(() => undefined);
        if (renamed) await removeInside(destinationRoot, to).catch(() => undefined);
        await repairWorktree(projectPath, from);
        await relinkSubmodules(from, submodules).catch(() => undefined);
        throw error;
      }
      record = { ...record, staging: undefined, phase: "copied", removeSource: true };
      moved = true;
      await storage.updateEnvironment(environment.id, { worktreeMove: record });
    }

    record = { ...record, phase: "committed" };
    commitAttempted = true;
    await commitMove(storage, environment.id, record, destinationRoot);
    committed = true;
    return await completeCommittedMove(
      environment,
      record,
      context,
      context.runtime.environments.fence,
      options.sessionHomes,
    );
  } catch (error) {
    // A storage write can publish before its notification rejects. Re-read
    // authority before deciding whether any filesystem rollback is allowed.
    const authoritative =
      commitAttempted && !committed
        ? await storage.getEnvironment(environment.id).catch(() => null)
        : null;
    if (authoritative?.worktreePath === to) committed = true;
    const rollbackAllowed = !commitAttempted || authoritative?.worktreePath === from;
    // A path commit is irreversible here: provider state may already have moved.
    // Retain the journal for startup to retry all idempotent completion stages.
    if (committed) {
      context.runtime.environments.fence.setMoveRecoveryPending(environment.id, true);
      return storage.updateEnvironment(environment.id, {
        lifecycleOperation: null,
        lifecycleOperationStartedAt: null,
        lifecycleError: `Environment moved; completion will retry on restart: ${errorMessage(error)}`,
      });
    }
    // A failed git command may already have renamed the directory. Inspect
    // both paths instead of interpreting a nonzero exit as no side effect.
    const fromExists = await pathExists(from);
    const toExists = await pathExists(to);
    let rolledBack = !moved && fromExists && !toExists && rollbackAllowed;
    if (moved && rollbackAllowed && record.removeSource && fromExists) {
      try {
        // Recovery must prefer the authoritative source before rollback can
        // partially remove the destination. Publish that decision first.
        record = { ...record, phase: "moving" };
        await storage.updateEnvironment(environment.id, { worktreeMove: record });
        await repairWorktree(projectPath, from);
        await relinkSubmodules(from, record.submodules);
        await removeInside(destinationRoot, to);
        rolledBack = true;
      } catch {
        rolledBack = false;
      }
    } else if (moved && !record.removeSource && rollbackAllowed) {
      rolledBack = await runCommand("git", ["-C", projectPath, "worktree", "move", to, from], {
        timeoutMs: GIT_TIMEOUT_MS,
      }).then(
        () => true,
        () => false,
      );
    }
    context.runtime.environments.fence.setMoveRecoveryPending(environment.id, !rolledBack);
    await storage
      .updateEnvironment(environment.id, {
        lifecycleOperation: null,
        lifecycleOperationStartedAt: null,
        worktreeMove: rolledBack
          ? null
          : { ...record, phase: record.removeSource && !rollbackAllowed ? "copied" : "moving" },
        lifecycleError: `Moving the environment failed: ${errorMessage(error)}`,
      })
      .catch(() => undefined);
    await context.runtime.diffStats.sync(context).catch(() => undefined);
    throw error;
  }
}

/**
 * Stops everything that runs in the worktree: terminals (and their build
 * descendants), Claude tmux sessions, review validation, exec workers and the
 * local agent bridges. They are restarted on demand afterwards in the new
 * folder.
 */
async function quiesceLocalEnvironment(
  environment: Environment,
  context: CommandContext,
  options: MoveEnvironmentOptions,
): Promise<void> {
  await stopEnvironmentReviewValidation(environment.id, context);
  await stopEnvironmentExecWorkers(environment.id, context, { requireStopped: true });
  if (context.userCommands?.hasRunning(environment.id)) {
    throw new Error(
      "A command you ran with ! is still running in the environment; cancel it first",
    );
  }
  const survivingTerminals = await context.runtime.terminals.terminateSessionsForEnvironment(
    environment.id,
  );
  if (survivingTerminals.length > 0) {
    throw new Error("Terminal processes in the environment are still running; try again");
  }
  // Restores `.claude/settings.local.json` from the tmux-mode backup while the
  // worktree is still where the backup recorded it.
  await cleanupEnvironmentTmux(environment.id, context, { requireStopped: true });
  context.previews?.registry.beforeEnvironmentTargetChange(environment.id);
  await stopLocalServersForEnvironmentUnlocked(environment.id, context);
  options.invalidateDiscovery?.(environment.id);
  // Release the worktree watcher and fetch schedule of the old folder.
  context.runtime.diffStats.invalidatePendingSync();
  context.runtime.diffStats.service.pause(environment.id);
  context.runtime.prMonitor.invalidatePendingSync();
  if (environment.worktreePath)
    context.runtime.diffStats.gitFetchScheduler.forget(environment.worktreePath);
}

async function tryGitWorktreeMove(
  projectPath: string,
  from: string,
  to: string,
): Promise<{ moved: boolean }> {
  try {
    await runCommand("git", ["-C", projectPath, "worktree", "move", from, to], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
    return { moved: true };
  } catch (error) {
    const message = errorMessage(error);
    // Git only renames, and never a worktree with submodules; both need a copy.
    if (
      /cross-device|EXDEV|containing submodules/i.test(message) &&
      (await pathExists(from)) &&
      !(await pathExists(to))
    )
      return { moved: false };
    throw new Error(`git could not move the worktree: ${message}`);
  }
}

/**
 * Populated submodules (recursively) whose git dir lives outside the worktree.
 * Their `.git` file and `core.worktree` hold paths relative to the checkout,
 * which a copy to another folder breaks. Embedded `.git` directories travel
 * with the copy and are left out.
 */
async function listLinkedSubmodules(worktree: string): Promise<WorktreeMoveSubmodule[]> {
  if (!(await pathExists(path.join(worktree, ".gitmodules")))) return [];
  const { stdout } = await runCommand(
    "git",
    [
      "-C",
      worktree,
      "submodule",
      "--quiet",
      "foreach",
      "--recursive",
      `printf '%s\\0%s\\0' "$displaypath" "$(git rev-parse --absolute-git-dir)"`,
    ],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  const fields = stdout.split("\0");
  const root = canonicalWorktreePath(worktree);
  const submodules: WorktreeMoveSubmodule[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const relative = fields[index]!;
    const gitDir = fields[index + 1]!;
    if (!relative || !path.isAbsolute(gitDir) || isSameOrInside(gitDir, root)) continue;
    if (!confinedRelative(root, path.join(root, relative))) continue;
    submodules.push({ path: relative, gitDir });
  }
  return submodules;
}

/** Points each submodule's `.git` file and git dir at its checkout inside `worktree`. */
async function relinkSubmodules(
  worktree: string,
  submodules: readonly WorktreeMoveSubmodule[] | undefined,
): Promise<void> {
  if (!submodules?.length) return;
  const root = canonicalWorktreePath(worktree);
  for (const submodule of submodules) {
    const checkout = path.join(root, submodule.path);
    if (!confinedRelative(root, checkout)) continue;
    if (!(await pathExists(checkout)) || !(await pathExists(submodule.gitDir))) continue;
    await fs.writeFile(
      path.join(checkout, ".git"),
      `gitdir: ${path.relative(checkout, submodule.gitDir)}\n`,
    );
    await runCommand(
      "git",
      [
        "config",
        "--file",
        path.join(submodule.gitDir, "config"),
        "core.worktree",
        path.relative(submodule.gitDir, checkout),
      ],
      { timeoutMs: GIT_TIMEOUT_MS },
    );
  }
}

/** Re-point the repository's record of a worktree at `worktreePath`. */
async function repairWorktree(projectPath: string | null, worktreePath: string): Promise<void> {
  if (!projectPath) throw new Error("Project checkout is unavailable for Git repair");
  await runCommand("git", ["-C", projectPath, "worktree", "repair", worktreePath], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const { stdout: listed } = await runCommand(
    "git",
    ["-C", projectPath, "worktree", "list", "--porcelain", "-z"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (
    !listed
      .split("\0")
      .some(
        (field) =>
          field.startsWith("worktree ") &&
          canonicalWorktreePath(field.slice(9)) === canonicalWorktreePath(worktreePath),
      )
  )
    throw new Error("Git did not register the repaired worktree");
  const { stdout: inside } = await runCommand(
    "git",
    ["-C", worktreePath, "rev-parse", "--is-inside-work-tree"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  if (inside.trim() !== "true") throw new Error("Repaired worktree is unavailable to Git");
}

async function commitMove(
  storage: StorageService,
  environmentId: string,
  record: WorktreeMoveRecord,
  destinationRoot: string,
): Promise<Environment> {
  return storage.updateEnvironment(environmentId, {
    worktreePath: record.to,
    worktreeBaseDir: destinationRoot,
    worktreeMove: record,
    lifecycleError: null,
  });
}

/** Idempotent completion shared by the live move and restart recovery. */
async function completeCommittedMove(
  environment: Environment,
  record: WorktreeMoveRecord,
  context: Pick<CommandContext, "storage"> & Partial<CommandContext>,
  fence: EnvironmentMutationFence,
  sessionHomes?: SessionRelocationHomes,
): Promise<Environment> {
  const failures = await relocateAgentSessionState(
    [record.from, record.fromCanonical ?? canonicalWorktreePath(record.from)],
    record.to,
    sessionHomes ?? (await defaultSessionRelocationHomes(environment.id, context)),
  );
  if (!failures.length && record.removeSource && !record.sourceCleaned) {
    await removeOldWorktree(
      record,
      (await context.storage.getProject(environment.projectId))?.localPath ?? null,
    );
    record = { ...record, sourceCleaned: true };
    await context.storage.updateEnvironment(environment.id, { worktreeMove: record });
  }
  await context.storage.clearBackendTerminalSessionIds?.(environment.id);
  if (context.emit) await afterMove(context as CommandContext);
  if (failures.length) {
    fence.setMoveRecoveryPending(environment.id, true);
    return context.storage.updateEnvironment(environment.id, {
      lifecycleOperation: null,
      lifecycleOperationStartedAt: null,
      lifecycleError: `Environment moved, but ${failures.join(", ")} conversations could not be relocated. Recovery will retry on restart.`,
    });
  }
  const completed = await context.storage.updateEnvironment(environment.id, {
    worktreeMove: null,
    lifecycleOperation: null,
    lifecycleOperationStartedAt: null,
    lifecycleError: null,
  });
  fence.setMoveRecoveryPending(environment.id, false);
  return completed;
}

async function afterMove(context: CommandContext): Promise<void> {
  // Terminal panes still name sessions that were closed in the old folder.
  await context.runtime.diffStats.sync(context);
  await context.runtime.prMonitor.sync(context);
}

/** Removes a copied-from worktree, but only from inside the folder it was created in. */
async function removeOldWorktree(
  record: WorktreeMoveRecord,
  projectPath: string | null,
): Promise<void> {
  const relative = confinedRelative(record.fromRoot!, record.from);
  if (!relative) throw new Error("Source is outside its original worktree root");
  const stats = await fs.lstat(record.from).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stats) return;
  if (!record.sourceIdentity)
    throw new Error("Original source identity is unavailable; source retained for manual cleanup");
  if (
    stats.isSymbolicLink() ||
    stats.dev !== record.sourceIdentity.dev ||
    stats.ino !== record.sourceIdentity.ino
  ) {
    // The original was removed and its pathname has been reused. It is no
    // longer ours to delete, including after a crash before cleanup was saved.
    return;
  }
  await removeConfinedDirectory(record.fromRoot!, relative, record.sourceIdentity);
  if (projectPath) {
    await runCommand("git", ["-C", projectPath, "worktree", "prune"], {
      timeoutMs: 30_000,
    }).catch(() => undefined);
  }
}

async function removeInside(root: string, target: string): Promise<void> {
  const relative = confinedRelative(root, target);
  if (!relative) throw new Error("The folder is outside the location it was created in");
  if (!(await pathExists(target))) return;
  await removeConfinedDirectory(root, relative);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A backend that stopped mid-move left `worktreeMove` behind. A completed
 * rename or copy is adopted; anything earlier is abandoned, leaving the
 * worktree where it was and removing only the move's own staging copy.
 */
export async function recoverInterruptedEnvironmentMove(
  environment: Environment,
  storage: StorageService,
  worktreeRoot: string,
  fence: EnvironmentMutationFence,
  sessionHomes?: SessionRelocationHomes,
): Promise<void> {
  const record = environment.worktreeMove;
  if (!record) return;
  fence.setMoveRecoveryPending(environment.id, true);
  fence.bindMovePaths(environment.id, [
    record.from,
    record.fromCanonical ?? record.from,
    record.to,
  ]);
  const destinationRoot = path.dirname(record.to);
  const [fromExists, toExists] = await Promise.all([
    pathExists(record.from),
    pathExists(record.to),
  ]);
  const project = await storage.getProject(environment.projectId).catch(() => null);
  const projectPath = project?.localPath?.trim() || null;
  const adopt =
    toExists && (record.phase === "committed" || record.phase === "copied" || !fromExists);
  if (adopt) {
    const committedRecord: WorktreeMoveRecord = {
      ...record,
      fromCanonical: record.fromCanonical ?? canonicalWorktreePath(record.from),
      fromRoot: record.fromRoot ?? environment.worktreeBaseDir ?? worktreeRoot,
      removeSource: record.removeSource ?? record.phase === "copied",
      phase: "committed",
    };
    if (!projectPath) throw new Error("Project checkout is unavailable for Git repair");
    await repairWorktree(projectPath, record.to);
    await relinkSubmodules(record.to, record.submodules);
    await commitMove(storage, environment.id, committedRecord, destinationRoot);
    await completeCommittedMove(environment, committedRecord, { storage }, fence, sessionHomes);
    return;
  }
  if (record.phase === "committed") {
    throw new Error("The committed move destination is unavailable; recovery retained for retry");
  }
  if (record.staging) await removeInside(destinationRoot, record.staging).catch(() => undefined);
  // A copy may have been repaired just before the backend stopped.
  if (fromExists) {
    await repairWorktree(projectPath, record.from);
    await relinkSubmodules(record.from, record.submodules).catch(() => undefined);
  }
  await storage.updateEnvironment(environment.id, {
    worktreeMove: null,
    lifecycleOperation: null,
    lifecycleOperationStartedAt: null,
    lifecycleError: toExists
      ? `An interrupted move left a copy of this environment at ${record.to}; the environment still uses ${record.from}.`
      : "Orkestrator stopped while moving this environment. Its files were left where they were; move it again.",
  });
  fence.setMoveRecoveryPending(environment.id, false);
}

/** Startup: settles every move a previous backend process left unfinished. */
export async function recoverInterruptedEnvironmentMoves(
  context: Pick<CommandContext, "storage" | "worktreeDir" | "runtime">,
  options: { sessionHomes?: SessionRelocationHomes } = {},
): Promise<void> {
  const environments = await context.storage.loadEnvironments();
  for (const environment of environments) {
    if (!environment.worktreeMove) continue;
    await recoverInterruptedEnvironmentMove(
      environment,
      context.storage,
      getWorktreeBaseDir(context),
      context.runtime.environments.fence,
      options.sessionHomes,
    ).catch(async (error: unknown) => {
      await context.storage
        .updateEnvironment(environment.id, {
          lifecycleOperation: null,
          lifecycleOperationStartedAt: null,
          lifecycleError: "Move recovery could not finish; it will retry on restart.",
        })
        .catch(() => undefined);
      console.warn(
        `[backend] interrupted move recovery failed for ${environment.id}:`,
        errorMessage(error),
      );
    });
  }
}

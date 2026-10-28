import { CommandFailedError, runCommand, type ExecResult } from "./shell.js";

/**
 * Git's fsmonitor daemon, and how this application keeps out of its way.
 *
 * Orkestrator used to write `core.fsmonitor=true` into every environment
 * worktree's `config.worktree`. On macOS that made every git call in those
 * worktrees wait about a second for the daemon's cookie file (much worse on
 * external volumes), some daemons hung and blocked `git status` for good, and
 * nothing ever stopped a daemon when its worktree was deleted. It is no longer
 * enabled; see docs/architecture/git-scan-caches.md.
 */

/** Prepended to a git invocation to keep it from consulting or starting a daemon. */
export const GIT_FSMONITOR_DISABLED_ARGS = ["-c", "core.fsmonitor=false"] as const;

/** A healthy daemon answers a stop request in milliseconds. */
const DAEMON_STOP_TIMEOUT_MS = 5_000;

type GitRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number },
) => Promise<unknown>;

/**
 * Asks the worktree's fsmonitor daemon, if any, to exit. Call it before the
 * worktree is deleted or moved: a daemon outlives its directory and is never
 * reaped otherwise.
 *
 * Best effort and cheap. Git exits at once when no daemon is running, and
 * `core.fsmonitor=false` keeps this call itself from starting one. A hung daemon
 * costs at most the timeout.
 */
export async function stopGitFsmonitorDaemon(
  worktreePath: string,
  run: GitRunner = runCommand,
): Promise<void> {
  await run(
    "git",
    ["-C", worktreePath, ...GIT_FSMONITOR_DISABLED_ARGS, "fsmonitor--daemon", "stop"],
    { timeoutMs: DAEMON_STOP_TIMEOUT_MS },
  ).catch(() => undefined);
}

const fsmonitorMigrations = new Map<string, Promise<void>>();

/**
 * Removes the `core.fsmonitor=true` that older versions wrote into a linked
 * application-owned worktree's own `config.worktree`, and stops its daemon.
 * Runs once per worktree per backend process after success; concurrent calls
 * share the attempt.
 *
 * Only that file is read or written, by explicit path rather than through
 * `git config --worktree`, which falls back to the shared repository config
 * when per-worktree config is off. Callers must establish application ownership;
 * project homes (including linked checkouts) must never opt in. Any other value,
 * including the user's own `false`, is left alone.
 */
export function removeLegacyWorktreeFsmonitor(
  worktreePath: string,
  applicationOwned = false,
): Promise<void> {
  if (!applicationOwned) return Promise.resolve();
  let migration = fsmonitorMigrations.get(worktreePath);
  if (!migration) {
    migration = migrateWorktreeFsmonitor(worktreePath).catch(() => {
      // A transient Git/config failure must not disable migration for this process.
      if (fsmonitorMigrations.get(worktreePath) === migration) {
        fsmonitorMigrations.delete(worktreePath);
      }
    });
    fsmonitorMigrations.set(worktreePath, migration);
  }
  return migration;
}

async function migrateWorktreeFsmonitor(worktreePath: string): Promise<void> {
  const { stdout } = await runCommand(
    "git",
    [
      "-C",
      worktreePath,
      ...GIT_FSMONITOR_DISABLED_ARGS,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
      "--git-common-dir",
      "--git-path",
      "config.worktree",
    ],
    { timeoutMs: 10_000 },
  );
  const [gitDir, commonDir, configPath] = stdout.split("\n").map((line) => line.trim());
  if (!gitDir || !commonDir || !configPath || gitDir === commonDir) return;

  const value = await runCommand(
    "git",
    ["config", "--file", configPath, "--get", "core.fsmonitor"],
    { timeoutMs: 10_000 },
  ).then(
    (result) => result.stdout.trim(),
    (error) => {
      // Exit 1 means the key/file is absent. Other failures need another attempt.
      if (error instanceof CommandFailedError && error.exitCode === 1) return "";
      throw error;
    },
  );
  if (value !== "true") return;

  await runCommand("git", ["config", "--file", configPath, "--unset", "core.fsmonitor"], {
    timeoutMs: 10_000,
  });
  await stopGitFsmonitorDaemon(worktreePath);
}

/** Tests: forget which worktrees were already migrated. */
export function resetLegacyFsmonitorMigrationsForTests(): void {
  fsmonitorMigrations.clear();
}

/**
 * Runs read-only git arguments and, if that times out, runs them once more with
 * fsmonitor disabled. A hung daemon blocks every git call that consults it, and
 * no amount of waiting fixes that; skipping the daemon costs only a full scan.
 * Other failures are returned as they are.
 */
export async function retryGitWithoutFsmonitorOnTimeout<T>(
  args: string[],
  run: (args: string[]) => Promise<T>,
): Promise<T> {
  try {
    return await run(args);
  } catch (error) {
    if (!(error instanceof CommandFailedError) || !error.timedOut) throw error;
    return run([...GIT_FSMONITOR_DISABLED_ARGS, ...args]);
  }
}

/** {@link retryGitWithoutFsmonitorOnTimeout} for a host `git` run. */
export function runGitWithFsmonitorFallback(
  args: string[],
  options: Parameters<typeof runCommand>[2] = {},
): Promise<ExecResult> {
  return retryGitWithoutFsmonitorOnTimeout(args, async (gitArgs) => {
    // runCommand reports a cancelled call as timed out too; that one stays cancelled.
    if (gitArgs !== args && options.signal?.aborted) throw options.signal.reason;
    return runCommand("git", gitArgs, options);
  });
}

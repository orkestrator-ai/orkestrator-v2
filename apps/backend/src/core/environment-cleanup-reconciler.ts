import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";

import type { CommandContext } from "./commands-context.js";
import { enqueueEnvironmentLifecycleOperation } from "./commands-environment.js";
import {
  ENVIRONMENT_CLEANUP_STEPS,
  environmentCleanupLedger,
  type EnvironmentCleanupEntry,
} from "./environment-cleanup-ledger.js";
import {
  redactCleanupError,
  runEnvironmentCleanupStep,
  type CleanupStepOptions,
} from "./environment-cleanup.js";
import {
  ENVIRONMENT_STATE_ROOTS,
  environmentStateKey,
  isEnvironmentStateKey,
} from "./environment-state-paths.js";
import { removeConfinedDirectory } from "./path-safety.js";

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

/** Startup pass: clear provable orphans, then finish owed cleanup in the background. */
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
      const removed = await sweepOrphanedEnvironmentState(context);
      if (removed > 0) {
        console.info(`[backend] Removed ${removed} orphaned environment state director(ies)`);
      }
    } catch (error) {
      console.warn(
        `[backend] Orphaned environment state sweep failed: ${redactCleanupError(error)}`,
      );
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

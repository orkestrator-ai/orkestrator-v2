import { CommandFailedError } from "./shell.js";

const PREFIX = "[ElectronBackend]";

export const PENDING_RENAME_FAILED_MESSAGE = `${PREFIX} Failed to rename environment from pending prompt`;
export const PENDING_RENAME_STILL_FAILING_MESSAGE = `${PREFIX} Environment rename from pending prompt is still failing`;
export const PENDING_RENAME_RECOVERED_MESSAGE = `${PREFIX} Renamed environment from pending prompt after failures`;

export interface PendingRenameFailureSummary {
  reason: "command-timed-out" | "command-missing" | "command-failed" | "error";
  error: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

/**
 * A rename failure without its message. Codex's stderr repeats the slug
 * prompt, and with it the user's first prompt, so only fields that cannot
 * carry prompt text are kept (AGENTS.md: logs never contain prompts).
 */
export function summarizePendingRenameFailure(error: unknown): PendingRenameFailureSummary {
  if (error instanceof CommandFailedError) {
    return {
      reason: error.timedOut
        ? "command-timed-out"
        : error.executableMissing
          ? "command-missing"
          : "command-failed",
      error: error.name,
      exitCode: error.exitCode,
      signal: error.signal,
    };
  }
  return { reason: "error", error: error instanceof Error ? error.name : typeof error };
}

/** The first retry after a failed first-prompt rename. */
export const PENDING_RENAME_RETRY_BASE_MS = 30_000;
/** The longest wait between retries, so a later sign-in is picked up within it. */
export const PENDING_RENAME_RETRY_MAX_MS = 30 * 60_000;

/**
 * How long to wait after the `failures`-th consecutive failure for one intent:
 * 30 seconds, doubling, capped at 30 minutes. Every failure class backs off
 * the same way, because a refused login and a transient outage both reach
 * here as a non-zero `codex exec` exit and cannot be told apart.
 */
export function pendingRenameRetryDelayMs(failures: number): number {
  const doublings = Math.max(0, Math.floor(failures) - 1);
  return Math.min(PENDING_RENAME_RETRY_BASE_MS * 2 ** doublings, PENDING_RENAME_RETRY_MAX_MS);
}

function isPowerOfTwo(value: number): boolean {
  return (value & (value - 1)) === 0;
}

/**
 * Logs first-prompt naming failures once per environment and intent.
 *
 * A failed rename retries while its intent is pending (see
 * {@link pendingRenameRetryDelayMs}), so a signed-out or offline Codex would
 * otherwise log on every retry. The first failure for an intent is logged in
 * full; later ones only as a count, at the 2nd, 4th, 8th... failure, and once
 * more when a retry succeeds.
 */
export class PendingRenameFailureLog {
  private readonly failures = new Map<string, { intent: string; count: number }>();

  constructor(
    private readonly warn: (...data: unknown[]) => void = (...data) => console.warn(...data),
  ) {}

  /** Records a failure and returns how many in a row this intent has had. */
  failed(environmentId: string, intent: string, error: unknown): number {
    const summary = summarizePendingRenameFailure(error);
    const previous = this.failures.get(environmentId);
    if (previous?.intent !== intent) {
      this.failures.set(environmentId, { intent, count: 1 });
      this.warn(PENDING_RENAME_FAILED_MESSAGE, { environmentId, ...summary });
      return 1;
    }
    previous.count += 1;
    if (isPowerOfTwo(previous.count)) {
      this.warn(PENDING_RENAME_STILL_FAILING_MESSAGE, {
        environmentId,
        failures: previous.count,
        reason: summary.reason,
      });
    }
    return previous.count;
  }

  succeeded(environmentId: string): void {
    const previous = this.failures.get(environmentId);
    if (!previous) return;
    this.failures.delete(environmentId);
    this.warn(PENDING_RENAME_RECOVERED_MESSAGE, { environmentId, failures: previous.count });
  }

  /** Forget environments that no longer hold a pending rename intent. */
  retainOnly(environmentIds: ReadonlySet<string>): void {
    for (const environmentId of this.failures.keys()) {
      if (!environmentIds.has(environmentId)) this.failures.delete(environmentId);
    }
  }
}

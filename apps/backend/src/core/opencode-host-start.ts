/**
 * Every OpenCode server this backend starts on the host (one per local
 * environment, plus the short-lived catalogue and sign-in servers) opens the
 * user's one `opencode.db` under XDG data. Two of them opening it in the same
 * moment can lose one to SQLite's "database is locked": the server exits
 * before it is healthy and the turn that asked for it is refused.
 *
 * Starts are therefore taken one at a time, from spawn until the server is
 * healthy or has exited, and a start that still loses the database (to a
 * `opencode` the user runs in a terminal, say) is retried a bounded number of
 * times. Container servers have their own database and are not involved.
 */

const DATABASE_LOCKED = /database is locked/i;
/** The stderr kept per starting server: enough for SQLite's one-line error. */
export const OPENCODE_STARTUP_STDERR_TAIL_BYTES = 4_096;
const DEFAULT_LOCKED_START_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

let lockedStartRetryDelaysMs = DEFAULT_LOCKED_START_RETRY_DELAYS_MS;
let hostStartTail: Promise<void> = Promise.resolve();

/**
 * Wait for this host's turn to start an OpenCode server. Call the returned
 * release once the server is healthy or the start has failed; it is safe to
 * call more than once. A start holds the turn for at most the health budget.
 */
export async function acquireOpenCodeHostStart(): Promise<() => void> {
  const previous = hostStartTail;
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostStartTail = previous.then(() => current);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/** Whether a starting server's stderr says it lost the shared database. */
export function openCodeStderrReportsLockedDatabase(stderrTail: string): boolean {
  return DATABASE_LOCKED.test(stderrTail);
}

export type OpenCodeDatabaseLockedError = Error & { openCodeDatabaseLocked: true };

export function openCodeDatabaseLockedError(message: string): OpenCodeDatabaseLockedError {
  return Object.assign(new Error(message), { openCodeDatabaseLocked: true as const });
}

export function isOpenCodeDatabaseLockedError(
  error: unknown,
): error is OpenCodeDatabaseLockedError {
  return (
    error instanceof Error &&
    (error as Partial<OpenCodeDatabaseLockedError>).openCodeDatabaseLocked === true
  );
}

/** The wait before retry `attempt` (0-based), or undefined once retries are spent. */
export function openCodeLockedStartRetryDelayMs(attempt: number): number | undefined {
  return lockedStartRetryDelaysMs[attempt];
}

export function setOpenCodeLockedStartRetryDelaysForTests(delays: readonly number[]): void {
  lockedStartRetryDelaysMs = delays;
}

export function resetOpenCodeHostStartForTests(): void {
  lockedStartRetryDelaysMs = DEFAULT_LOCKED_START_RETRY_DELAYS_MS;
  hostStartTail = Promise.resolve();
}

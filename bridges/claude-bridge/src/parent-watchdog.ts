/**
 * Terminates the bridge when the backend that spawned it disappears.
 *
 * Bridges are spawned detached (their own process group), so an Electron force
 * quit, a crashed backend, or a SIGKILL leaves them running with no owner: the
 * backend's in-memory process table is gone and nothing else knows the PID.
 * An orphaned bridge keeps its in-memory sessions — and any Claude CLI
 * children mid-turn — alive indefinitely, which is how repeated app restarts
 * accumulated leaked bun processes.
 *
 * The backend advertises its PID via `ORKESTRATOR_PARENT_PID`; when that
 * process is gone, the bridge runs its normal graceful shutdown. Opt-in by
 * design: a bridge started by hand for debugging has no parent to watch.
 */
export const PARENT_PID_ENV = "ORKESTRATOR_PARENT_PID";

const DEFAULT_POLL_INTERVAL_MS = 15_000;

export function parseParentPid(value: string | undefined): number | null {
  if (!value) return null;
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ParentWatchdogOptions {
  parentPid: number;
  /** Invoked exactly once, when the parent process no longer exists. */
  onParentExit: () => void;
  pollIntervalMs?: number;
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean;
}

/** Returns a stop function; the timer never holds the process open. */
export function startParentWatchdog(options: ParentWatchdogOptions): () => void {
  const isAlive = options.isAlive ?? isProcessAlive;
  const timer = setInterval(() => {
    if (isAlive(options.parentPid)) return;
    clearInterval(timer);
    options.onParentExit();
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

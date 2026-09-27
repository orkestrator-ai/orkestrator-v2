/**
 * The parent-death contract between the backend and the processes it spawns.
 *
 * Bridges are spawned detached (their own process group), so an Electron force
 * quit, a crashed backend, or a SIGKILL leaves them running with no owner: the
 * backend's in-memory process table is gone and nothing else knows the PID.
 * An orphaned bridge keeps its child tree — a codex app-server and its shells
 * and sub-agents, or a Claude CLI mid-turn — alive indefinitely, which is how
 * repeated app restarts accumulated tens of GB of leaked processes.
 *
 * The backend advertises its PID via `ORKESTRATOR_PARENT_PID`; when that
 * process is gone, the child runs its own graceful shutdown. Opt-in by design:
 * a bridge started by hand for debugging has no parent to watch.
 *
 * This lives in the protocol package because the env var *is* a cross-process
 * contract — the backend writes it and both bridges read it. Keeping one
 * implementation means hardening it hardens every watcher at once.
 */
export const PARENT_PID_ENV = "ORKESTRATOR_PARENT_PID";

const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * PID 1 is rejected on purpose: it is init/launchd and never exits, so
 * watching it can only ever burn a timer. Anything unparseable, zero, or
 * negative means "no parent to watch" rather than a parent that has died —
 * treating those as death would shut down a healthy process at startup.
 */
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

/**
 * The interval primitives a watchdog or lifecycle owner arms.
 *
 * Injected so tests can drive time deterministically and count what is still
 * armed after a shutdown, rather than sleeping and hoping. Production passes
 * nothing and gets the runtime's own timers.
 */
export interface IntervalTimers {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const runtimeIntervalTimers: IntervalTimers = {
  setInterval: (callback, ms) => {
    const handle = setInterval(callback, ms);
    // A watchdog or sweep must never be what keeps a process alive.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface ParentWatchdogOptions {
  parentPid: number;
  /** Invoked exactly once, when the parent process no longer exists. */
  onParentExit: () => void;
  pollIntervalMs?: number;
  /** Injected in tests. */
  isAlive?: (pid: number) => boolean;
  /** Injected in tests. */
  timers?: IntervalTimers;
}

/** Returns an idempotent stop function; the timer never holds the process open. */
export function startParentWatchdog(options: ParentWatchdogOptions): () => void {
  const isAlive = options.isAlive ?? isProcessAlive;
  const timers = options.timers ?? runtimeIntervalTimers;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(timer);
  };
  const timer = timers.setInterval(() => {
    // A callback that was already due when `stop` ran must not fire.
    if (stopped || isAlive(options.parentPid)) return;
    stop();
    options.onParentExit();
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  return stop;
}

export interface ReparentWatchdogOptions {
  /** Invoked exactly once, when this process is reparented. */
  onReparented: () => void;
  /**
   * Parent observed at process startup. Pass this when asynchronous startup
   * work happens before the watchdog is installed, so an early reparent cannot
   * be mistaken for a process that was launched by init.
   */
  initialParentPid?: number;
  pollIntervalMs?: number;
  /** Injected in tests. */
  readParentPid?: () => number;
}

/**
 * The mirror image, for a process watching its *own* parent rather than a
 * PID handed to it: when the parent dies the OS reparents us, so a changed
 * ppid is the death signal.
 *
 * Returns `null` — starting nothing — when the initial ppid is already 1.
 * That is the service-manager case (systemd, launchd, a container init), where
 * the ppid is stable for the process's whole life and a change can never mean
 * what it means under a supervisor that spawned us directly.
 */
export function startReparentWatchdog(options: ReparentWatchdogOptions): (() => void) | null {
  const readParentPid = options.readParentPid ?? (() => process.ppid);
  const initialParentPid = options.initialParentPid ?? readParentPid();
  if (initialParentPid <= 1) return null;

  const timer = setInterval(() => {
    if (readParentPid() === initialParentPid) return;
    clearInterval(timer);
    options.onReparented();
  }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

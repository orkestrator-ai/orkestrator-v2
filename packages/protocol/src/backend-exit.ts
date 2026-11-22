/**
 * Why the Local backend stopped when nobody asked it to: the `exitCause` the
 * desktop's `backend.exited` essential event keeps. The event's message and
 * stderr never reach the essential log, so before this field every unexpected
 * exit (a kernel OOM kill, a Bun crash, a stray SIGKILL, a `process.exit(1)`)
 * read the same in a self-improvement digest: `desktop:backend.exited:Error`.
 *
 * `exitCause` is deliberately not one of the self-improvement qualifier fields, so
 * the event's signature stays the same and an open ticket's ledger entry keeps
 * matching; the digest shows it as evidence instead.
 */
export const BACKEND_EXIT_CAUSES = [
  /** It exited with a code: `process.exit`, a fatal-rejection guard, a startup check. */
  "exit-code",
  /** A fault signal (SIGSEGV, SIGABRT, …), or Bun printed its crash report. */
  "crashed",
  /** SIGKILL while the kernel counted an OOM kill in the backend's cgroup. */
  "oom-killed",
  /** SIGKILL with no OOM kill counted: another process, or an OOM we could not see. */
  "killed",
  /** Any other signal (SIGTERM, SIGHUP, SIGINT, …) the desktop did not send. */
  "terminated",
  /** The child process failed (`error` event) rather than exiting. */
  "spawn-error",
] as const;

export type BackendExitCause = (typeof BACKEND_EXIT_CAUSES)[number];

/** Signals the kernel sends a process for its own fault, or that `abort()` raises. */
const FAULT_SIGNALS = new Set([
  "SIGSEGV",
  "SIGBUS",
  "SIGABRT",
  "SIGILL",
  "SIGFPE",
  "SIGTRAP",
  "SIGSYS",
]);

export function isBackendExitCause(value: string): value is BackendExitCause {
  return (BACKEND_EXIT_CAUSES as readonly string[]).includes(value);
}

export interface BackendExitFacts {
  exitCode: number | null;
  signal: string | null;
  /** The child emitted `error` instead of exiting. */
  spawnError?: boolean;
  /** OOM kills the kernel counted in the backend's cgroup while it ran; null when unknown. */
  oomKills?: number | null;
  /** Bun's crash report appeared on the backend's stderr. */
  crashReport?: boolean;
}

export function classifyBackendExit(facts: BackendExitFacts): BackendExitCause {
  if (facts.spawnError) return "spawn-error";
  if (facts.signal === "SIGKILL") {
    if ((facts.oomKills ?? 0) > 0) return "oom-killed";
    return facts.crashReport ? "crashed" : "killed";
  }
  if (facts.crashReport) return "crashed";
  if (facts.signal) return FAULT_SIGNALS.has(facts.signal) ? "crashed" : "terminated";
  return "exit-code";
}

/**
 * Bun's crash report (`crash_handler.zig`): a `panic(<thread>): …` or bare
 * `panic: …` line and the "Bun has crashed" banner. Matching a line only sets
 * a boolean; the line itself is never kept.
 */
const BUN_CRASH_LINE =
  /^(?:panic(?:\([^)]{0,64}\))?: |oh no: Bun has crashed\b)|\bBun has crashed\b/;

export function isBunCrashReportLine(line: string): boolean {
  return BUN_CRASH_LINE.test(line.trimStart());
}

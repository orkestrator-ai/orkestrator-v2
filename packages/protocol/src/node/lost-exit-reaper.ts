import { createRequire } from "node:module";
import { createLogger } from "../logger.js";
import { bunRuntime, PROCESS_INSPECTION_OPTIONS } from "./shell-process-state.js";

const log = createLogger("process");

/**
 * Reaps macOS children whose exit Bun 1.4.4 lost
 * (docs/architecture/backend-runtime.md, "One-shot commands").
 *
 * `watchForLostExit` settles such a command from the zombie's status, but nothing
 * calls `waitpid` for it, so the child stays `Z <defunct>` until the backend exits.
 * This calls it, under rules that keep it to that one child:
 *
 * - It acts only on a PID a capture started and handed over, and only while that
 *   capture's runtime still reports no exit. Once the runtime has reaped a child,
 *   its PID can name a new process; a reported exit is what says that happened.
 * - It waits a grace period first, so a late event still reaches the runtime.
 * - It reaps only a zombie whose parent is this process, read from `ps` just
 *   before, and `waitpid` with `WNOHANG` on that one PID. The kernel answers
 *   `waitpid` only for this process's own children, so no other process's child
 *   can be touched, and a child still running is left alone.
 *
 * Every check and the `waitpid` run in one synchronous step on the JavaScript
 * thread, which is where Bun reaps on macOS, so Bun cannot reap the child between
 * them. What remains is a lost event Bun delivers after the reap: its own
 * `waitpid` then finds no child, the capture has already settled and ignores it.
 */

/** What the reaper asks the kernel. Injected in tests. */
export type LostExitReaperSystem = {
  readonly selfPid: number;
  /**
   * One PID's parent and state. `"gone"` when it names no process, `undefined`
   * when `ps` could not say.
   */
  inspect(pid: number): { ppid: number; state: string } | "gone" | undefined;
  /** `waitpid(pid, WNOHANG)`: the PID once reaped, 0 while it runs, -1 on failure. */
  waitNoHang(pid: number): number;
};

export type LostExitReaperOptions = {
  system: LostExitReaperSystem;
  /** First check after the capture settles. */
  graceMs?: number;
  /** Longest gap between checks; each gap doubles up to it. */
  maxCheckMs?: number;
  /** Checks before a child that never became a zombie is given up on. */
  maxChecks?: number;
  /** Children waited on at once. Past it a child is left unreaped, never queued. */
  maxPending?: number;
};

export type LostExitReaperStats = { pending: number; reaped: number; abandoned: number };

export type LostExitReaper = {
  /** Watch `pid` until it can be reaped. `reported` says its runtime saw the exit. */
  reap(pid: number, reported: () => boolean): void;
  stats(): LostExitReaperStats;
  /** Stops every pending watch. For tests. */
  stop(): void;
};

const REAP_GRACE_MS = 2_000;
const REAP_MAX_CHECK_MS = 30_000;
const REAP_MAX_CHECKS = 12;
const REAP_MAX_PENDING = 256;

export function createLostExitReaper(options: LostExitReaperOptions): LostExitReaper {
  const { system } = options;
  const graceMs = options.graceMs ?? REAP_GRACE_MS;
  const maxCheckMs = options.maxCheckMs ?? REAP_MAX_CHECK_MS;
  const maxChecks = options.maxChecks ?? REAP_MAX_CHECKS;
  const maxPending = options.maxPending ?? REAP_MAX_PENDING;
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  let reaped = 0;
  let abandoned = 0;

  const abandon = (pid: number, reason: "not-a-zombie" | "capacity" | "waitpid-failed") => {
    abandoned += 1;
    log.warn("child.reap-abandoned", { pid, reason });
  };

  /** One check. Returns whether to check again. */
  const check = (pid: number, reported: () => boolean, startedAt: number): boolean => {
    if (reported()) return false;
    const found = system.inspect(pid);
    if (found === undefined) return true;
    // Gone, or no longer this process's child: someone reaped it, so leave it.
    if (found === "gone" || found.ppid !== system.selfPid) return false;
    if (!found.state.startsWith("Z")) return true;
    const result = system.waitNoHang(pid);
    if (result === pid) {
      reaped += 1;
      log.info("child.reaped", { pid, waitedMs: Date.now() - startedAt });
      return false;
    }
    if (result === 0) return true;
    abandon(pid, "waitpid-failed");
    return false;
  };

  const schedule = (
    pid: number,
    reported: () => boolean,
    startedAt: number,
    delayMs: number,
    checks: number,
  ) => {
    const timer = setTimeout(() => {
      pending.delete(pid);
      let again: boolean;
      try {
        again = check(pid, reported, startedAt);
      } catch {
        again = true;
      }
      if (!again) return;
      if (checks + 1 >= maxChecks) {
        abandon(pid, "not-a-zombie");
        return;
      }
      schedule(pid, reported, startedAt, Math.min(delayMs * 2, maxCheckMs), checks + 1);
    }, delayMs);
    // A zombie must not keep the process alive; exiting reaps it anyway.
    timer.unref?.();
    pending.set(pid, timer);
  };

  return {
    reap(pid, reported) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || pid === system.selfPid) return;
      if (pending.has(pid) || reported()) return;
      if (pending.size >= maxPending) {
        abandon(pid, "capacity");
        return;
      }
      schedule(pid, reported, Date.now(), graceMs, 0);
    },
    stats: () => ({ pending: pending.size, reaped, abandoned }),
    stop() {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}

const WNOHANG = 1;

type WaitpidLibrary = {
  symbols: { waitpid(pid: number, status: Int32Array, options: number): number };
};

/** `waitpid` from libSystem through `bun:ffi`. Undefined where it cannot load. */
function loadDarwinWaitpid(
  loadFfi: () => unknown = () => createRequire(import.meta.url)("bun:ffi"),
): ((pid: number) => number) | undefined {
  try {
    // Reached through createRequire because bridges bundle for `--target=node`,
    // and typed here because their tsconfigs do not load Bun's definitions.
    const { dlopen, FFIType } = loadFfi() as {
      dlopen(
        path: string,
        symbols: Record<string, { args: unknown[]; returns: unknown }>,
      ): WaitpidLibrary;
      FFIType: { i32: unknown; ptr: unknown };
    };
    const libSystem = dlopen("/usr/lib/libSystem.B.dylib", {
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    });
    const status = new Int32Array(1);
    return (pid) => libSystem.symbols.waitpid(pid, status, WNOHANG);
  } catch {
    return undefined;
  }
}

/** The real kernel, on macOS under Bun. Undefined where `waitpid` cannot load. */
export function darwinReaperSystem(loadFfi?: () => unknown): LostExitReaperSystem | undefined {
  const waitNoHang = loadDarwinWaitpid(loadFfi);
  if (!waitNoHang) return undefined;
  return {
    selfPid: process.pid,
    inspect(pid) {
      const result = bunRuntime()?.spawnSync(
        ["/bin/ps", "-o", "ppid=,stat=", "-p", String(pid)],
        PROCESS_INSPECTION_OPTIONS,
      );
      if (!result) return undefined;
      const output = result.stdout.toString().trim();
      // `ps -p` exits 1 with nothing printed when the PID names no process.
      if (!result.success) return result.exitCode === 1 && output === "" ? "gone" : undefined;
      const match = /^(\d+)\s+(\S+)$/.exec(output);
      return match ? { ppid: Number(match[1]), state: match[2]! } : undefined;
    },
    waitNoHang,
  };
}

let defaultReaper: LostExitReaper | null | undefined;

/** Lazy native loading has one failure path, also exercised without loading FFI. */
export function createDarwinLostExitReaper(loadFfi?: () => unknown): LostExitReaper | null {
  const system = darwinReaperSystem(loadFfi);
  if (!system) log.warn("child.reap-unavailable");
  return system ? createLostExitReaper({ system }) : null;
}

function sharedReaper(): LostExitReaper | undefined {
  if (defaultReaper === undefined) {
    defaultReaper = createDarwinLostExitReaper();
  }
  return defaultReaper ?? undefined;
}

/**
 * Called when a capture has settled while its runtime still reports no exit for
 * `pid`. On macOS under Bun that child may be a zombie nobody will reap, so it is
 * reaped once it is one; elsewhere this does nothing, because only macOS lost
 * the exit (Node never did, and Linux always delivered it).
 */
export function reapAfterLostExit(pid: number | undefined, reported: () => boolean): void {
  if (process.platform !== "darwin" || pid === undefined || !bunRuntime()) return;
  sharedReaper()?.reap(pid, reported);
}

/** Counts from the shared reaper, for diagnostics and tests. */
export function lostExitReaperStats(): LostExitReaperStats {
  return defaultReaper?.stats() ?? { pending: 0, reaped: 0, abandoned: 0 };
}

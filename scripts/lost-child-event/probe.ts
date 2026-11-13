/**
 * The strict lost-child-event probe (to-do 6900): does Bun lose a child's
 * `exit` or `close` event? It starts no process and reaps nothing, so it can
 * neither wake Bun nor change what it measures.
 *
 * A child counts as lost when it has been an unreaped zombie for 5 s with no
 * `exit` (read through `waitid(P_PID, pid, WEXITED | WNOHANG | WNOWAIT)`), or
 * 5 s after its `exit` with no `close`. At a lost `close` it records whether
 * the child's process group still exists and a zero-timeout `poll()` of this
 * process's own ends of the child's stdio: `IN|HUP` there means the kernel
 * already reports EOF and nothing has read it.
 *
 * Records are JSON lines, to `LOST_CHILD_PROBE_OUT` or stdout. They hold the
 * command and its subcommand only (`git rev-parse`), never paths, arguments,
 * output or environment. With `LOST_CHILD_PROBE_SCHEDULE` set, the summary
 * also writes every child's spawn offset, working directory and full argv to
 * that file, for `reduction.ts replay`; keep it local, it holds paths.
 *
 * Used by `preload.ts` (inside `bun test`) and by `reduction.ts`.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "linux") throw new Error("macOS and Linux only");
const { symbols } = dlopen(mac ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
  waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  poll: { args: [FFIType.ptr, FFIType.u32, FFIType.i32], returns: FFIType.i32 },
});
const P_PID = 1;
// WEXITED | WNOHANG | WNOWAIT: 0x04 | 0x01 | 0x20 on macOS, 0x04 | 0x01 | 0x01000000 on Linux.
const WAIT_FLAGS = mac ? 0x25 : 0x01000005;
// `si_pid` is siginfo_t's fourth int on macOS and its fifth on Linux.
const SI_PID = mac ? 3 : 4;
const siginfo = new Int32Array(32);

/** Whether `pid` is an unreaped zombie child of this process. Reaps nothing. */
export function isZombie(pid: number): boolean {
  siginfo.fill(0);
  return symbols.waitid(P_PID, pid, ptr(siginfo), WAIT_FLAGS) === 0 && siginfo[SI_PID] === pid;
}

const POLLIN = 0x1;
const POLLERR = 0x8;
const POLLHUP = 0x10;
const POLLNVAL = 0x20;

/** `fd:revents` of a zero-timeout `poll()` on each descriptor. */
export function pollNow(fds: readonly number[]): string[] {
  if (fds.length === 0) return [];
  const buffer = new ArrayBuffer(8 * fds.length);
  const ints = new Int32Array(buffer);
  const shorts = new Int16Array(buffer);
  fds.forEach((fd, index) => {
    ints[index * 2] = fd;
    shorts[index * 4 + 2] = POLLIN | POLLHUP;
  });
  symbols.poll(ptr(ints), fds.length, 0);
  return fds.map((fd, index) => {
    const revents = shorts[index * 4 + 3]!;
    const names = [
      revents & POLLIN ? "IN" : "",
      revents & POLLHUP ? "HUP" : "",
      revents & POLLNVAL ? "NVAL" : "",
      revents & POLLERR ? "ERR" : "",
    ].filter(Boolean);
    return `${fd}:${names.length ? names.join("|") : "none"}`;
  });
}

/** This process's open descriptors; compare before and after a synchronous spawn. */
export function openFds(): Set<number> {
  return new Set(readdirSync(mac ? "/dev/fd" : "/proc/self/fd").map(Number));
}

/** The command and its subcommand, skipping git's `-C <path>` and `-c <k=v>`. */
export function commandLabel(argv: readonly string[]): string {
  const command = (argv[0] ?? "").split("/").pop() ?? "";
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "-C" || arg === "-c") {
      index++;
      continue;
    }
    if (!arg.startsWith("-")) return command === "git" ? `git ${arg}` : command;
  }
  return command;
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type Tracked = {
  label: string;
  pid: number;
  /** The test it started in, numbered by `preload.ts`. */
  test: number;
  spawnAt: number;
  fds: number[];
  zombieAt: number;
  exitAt: number;
  closeAt: number;
  marks: string[];
  lostExit: boolean;
  lostClose: boolean;
};

const LOSS_MS = 5_000;
const tracked: Tracked[] = [];
const schedule: Array<{ at: number; cwd: string; argv: string[] }> = [];
export const probeState = { test: 0 };

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  const out = process.env.LOST_CHILD_PROBE_OUT;
  if (out) appendFileSync(out, `${line}\n`);
  else console.log(line);
}

/**
 * Registers a child just spawned. `before` is `openFds()` read immediately
 * before the synchronous `spawn`, so the new descriptors are the child's stdio.
 */
export function track(
  child: ChildProcess,
  argv: readonly string[],
  before: Set<number>,
  cwd?: string,
): void {
  if (child.pid === undefined) return;
  const t: Tracked = {
    label: commandLabel(argv),
    pid: child.pid,
    test: probeState.test,
    spawnAt: Date.now(),
    fds: [...openFds()].filter((fd) => !before.has(fd)),
    zombieAt: 0,
    exitAt: 0,
    closeAt: 0,
    marks: [],
    lostExit: false,
    lostClose: false,
  };
  tracked.push(t);
  if (process.env.LOST_CHILD_PROBE_SCHEDULE)
    schedule.push({ at: t.spawnAt, cwd: cwd ?? "", argv: [...argv] });
  child.once("exit", () => {
    t.exitAt = Date.now();
    if (t.lostExit)
      record({ kind: "LATE_EXIT", label: t.label, afterZombieMs: t.exitAt - t.zombieAt });
  });
  child.once("close", () => {
    t.closeAt = Date.now();
    if (t.lostClose)
      record({ kind: "LATE_CLOSE", label: t.label, afterExitMs: t.closeAt - t.exitAt });
  });
}

/** Notes what the capture did to a child (`aborted`, `timed-out`), with its age in ms. */
export function mark(pid: number | undefined, what: string): void {
  const t = tracked.findLast((entry) => entry.pid === pid);
  if (t) t.marks.push(`${what}@${Date.now() - t.spawnAt}`);
}

function scan(): void {
  const now = Date.now();
  for (const t of tracked) {
    if (t.closeAt) continue;
    if (!t.exitAt && !t.zombieAt && isZombie(t.pid)) t.zombieAt = now;
    if (t.zombieAt && !t.exitAt && !t.lostExit && now - t.zombieAt >= LOSS_MS) {
      t.lostExit = true;
      record({
        kind: "LOST_EXIT",
        label: t.label,
        test: t.test,
        zombieAfterSpawnMs: t.zombieAt - t.spawnAt,
        groupAlive: groupAlive(t.pid),
        marks: t.marks,
      });
    }
    if (t.exitAt && !t.lostClose && now - t.exitAt >= LOSS_MS) {
      t.lostClose = true;
      record({
        kind: "LOST_CLOSE",
        label: t.label,
        test: t.test,
        exitAfterSpawnMs: t.exitAt - t.spawnAt,
        groupAlive: groupAlive(t.pid),
        poll: pollNow(t.fds),
        marks: t.marks,
      });
    }
  }
}

const scanner = setInterval(scan, 20);
scanner.unref();

/** Waits up to `maxMs` for every tracked child to close, then writes the summary. */
export async function holdUntilClosed(maxMs: number): Promise<void> {
  const until = Date.now() + maxMs;
  while (tracked.some((t) => !t.closeAt) && Date.now() < until) await Bun.sleep(50);
  scan();
  clearInterval(scanner);
  const scheduleFile = process.env.LOST_CHILD_PROBE_SCHEDULE;
  if (scheduleFile) {
    const first = schedule[0]?.at ?? 0;
    const entries = schedule.map((entry) => ({ ...entry, at: entry.at - first }));
    appendFileSync(scheduleFile, `${JSON.stringify(entries)}\n`);
  }
  const labels: Record<string, number> = {};
  for (const t of tracked) labels[t.label] = (labels[t.label] ?? 0) + 1;
  record({
    kind: "SUMMARY",
    bun: Bun.version,
    platform: process.platform,
    tracked: tracked.length,
    lostExit: tracked.filter((t) => t.lostExit).length,
    lostClose: tracked.filter((t) => t.lostClose).length,
    neverClosed: tracked
      .filter((t) => !t.closeAt)
      .map((t) => ({ label: t.label, exited: t.exitAt > 0, zombie: isZombie(t.pid) })),
    labels,
  });
}

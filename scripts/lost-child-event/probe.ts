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
 * also writes a schedule to that file for `reduction.ts replay`: every child's
 * spawn offset, working directory, full argv, Git identity and date variables,
 * exit status, the revision it printed (a `rev-parse HEAD`'s output), and
 * which earlier children were still running when it started; and every file
 * the test wrote (`recordWrite`, called by `preload.ts`). That is what a
 * replay needs to rebuild the repository the commands ran against, rather
 * than only their timing. Keep it local: it holds paths and file contents.
 * Recording a revision adds a `data` listener to the child's stdout, so a
 * recording run is not a measuring run; count losses from runs without it.
 *
 * Used by `preload.ts` (inside `bun test`), `reduction.ts` and `pipe-runner.ts`.
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
  /** Its position among this process's tracked children, from 1. */
  seq: number;
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
export const probeState = { test: 0 };

/** One recorded command. `open`: earlier entries (by index) still running when it started. */
export type ScheduleCommand = {
  at: number;
  cwd: string;
  argv: string[];
  /** Only the `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables the spawn passed. */
  env?: Record<string, string>;
  open: number[];
  /** The exit code, `null` for a signal; absent if it never exited. */
  exit?: number | null;
  /** The object id the command printed as its whole first line, if any. */
  oid?: string;
};
/** One recorded file write, under the test's own directories. */
export type ScheduleWrite = {
  at: number;
  write: string;
  content?: string;
  contentBase64?: string;
  open: number[];
};
export type ScheduleEntry = ScheduleCommand | ScheduleWrite;
/** The schedule file's first line. Version 1 was a bare array of `{ at, cwd, argv }`. */
export type ScheduleFile = { version: 2; entries: ScheduleEntry[] };
export const SCHEDULE_VERSION = 2;

const recording = Boolean(process.env.LOST_CHILD_PROBE_SCHEDULE);
const schedule: ScheduleEntry[] = [];
/** Schedule indices of commands not yet closed. */
const openEntries = new Set<number>();
const GIT_IDENTITY = /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/;
const OID_LINE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** Bounds a recorded write, so a schedule stays small. */
const MAX_WRITE_BYTES = 64 * 1024;

function openNow(): number[] {
  return [...openEntries];
}

/**
 * Records a file write for the replay; a no-op unless recording. Writes over
 * 64 KiB, or of content that is neither a string nor bytes, are recorded as
 * skipped, so the replay can say it is incomplete.
 */
export function recordWrite(file: unknown, data: unknown): void {
  if (!recording || typeof file !== "string") return;
  const entry: ScheduleWrite = { at: Date.now(), write: file, open: openNow() };
  if (typeof data === "string" && Buffer.byteLength(data) <= MAX_WRITE_BYTES) entry.content = data;
  else if (ArrayBuffer.isView(data) && data.byteLength <= MAX_WRITE_BYTES)
    entry.contentBase64 = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(
      "base64",
    );
  schedule.push(entry);
}

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
  env?: Record<string, string | undefined>,
): void {
  if (child.pid === undefined) return;
  const t: Tracked = {
    label: commandLabel(argv),
    seq: tracked.length + 1,
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
  let entry: ScheduleCommand | undefined;
  let index = -1;
  if (recording) {
    entry = { at: t.spawnAt, cwd: cwd ?? "", argv: [...argv], open: openNow() };
    const identity = Object.entries(env ?? {}).filter(
      (pair): pair is [string, string] => GIT_IDENTITY.test(pair[0]) && pair[1] !== undefined,
    );
    if (identity.length) entry.env = Object.fromEntries(identity);
    index = schedule.push(entry) - 1;
    openEntries.add(index);
    // Only the first line is kept, and only if it is an object id.
    let head = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      if (head.length < 128) head += String(chunk).slice(0, 128);
    });
    child.once("close", () => {
      const line = head.split("\n")[0]!.trim();
      if (OID_LINE.test(line)) entry!.oid = line;
    });
  }
  child.once("exit", (code) => {
    t.exitAt = Date.now();
    if (entry) entry.exit = code;
    if (t.lostExit)
      record({ kind: "LATE_EXIT", label: t.label, afterZombieMs: t.exitAt - t.zombieAt });
  });
  child.once("close", () => {
    t.closeAt = Date.now();
    if (index >= 0) openEntries.delete(index);
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
        seq: t.seq,
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
        seq: t.seq,
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
    const first = schedule.find((entry) => "argv" in entry)?.at ?? 0;
    const file: ScheduleFile = {
      version: SCHEDULE_VERSION,
      entries: schedule.map((entry) => ({ ...entry, at: entry.at - first })),
    };
    appendFileSync(scheduleFile, `${JSON.stringify(file)}\n`);
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

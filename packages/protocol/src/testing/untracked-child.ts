import { spyOn } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * Children of the test process that Bun knows nothing about, started with
 * libSystem's `posix_spawnp`. Bun never reaps them, so one that exits stays a
 * zombie until something calls `waitpid`: the state a child is left in when Bun
 * loses its exit (docs/architecture/backend-runtime.md, "One-shot commands").
 * macOS only.
 */

const libSystem = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
    posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawnattr_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
    posix_spawnattr_setpgroup: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    posix_spawnp: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    posix_spawn_file_actions_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawn_file_actions_destroy: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawn_file_actions_adddup2: {
      args: [FFIType.ptr, FFIType.i32, FFIType.i32],
      returns: FFIType.i32,
    },
    posix_spawn_file_actions_addopen: {
      args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u16],
      returns: FFIType.i32,
    },
    waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });

let library: ReturnType<typeof libSystem> | undefined;
const lib = () => (library ??= libSystem()).symbols;

const cString = (value: string) => Buffer.from(`${value}\0`);

/** A null-terminated array of C string pointers. The strings must outlive the call. */
function cStringArray(strings: Buffer[]): BigUint64Array {
  const array = new BigUint64Array(strings.length + 1);
  strings.forEach((value, index) => {
    array[index] = BigInt(ptr(value));
  });
  return array;
}

/**
 * Starts `argv` as a child of this process that Bun does not track. stdin is
 * `/dev/null`; stdout and stderr go to the given descriptors, or are inherited.
 */
export function spawnUntrackedChild(
  argv: string[],
  { stdoutFd, stderrFd }: { stdoutFd?: number; stderrFd?: number } = {},
): number {
  const symbols = lib();
  // posix_spawn_file_actions_t is one pointer on macOS.
  const actions = new BigUint64Array(1);
  if (symbols.posix_spawn_file_actions_init(actions) !== 0) throw new Error("file actions init");
  const attributes = new BigUint64Array(1);
  if (symbols.posix_spawnattr_init(attributes) !== 0) {
    symbols.posix_spawn_file_actions_destroy(actions);
    throw new Error("spawn attributes init");
  }
  const devNull = cString("/dev/null");
  try {
    symbols.posix_spawn_file_actions_addopen(actions, 0, devNull, 0, 0);
    if (stdoutFd !== undefined) symbols.posix_spawn_file_actions_adddup2(actions, stdoutFd, 1);
    if (stderrFd !== undefined) symbols.posix_spawn_file_actions_adddup2(actions, stderrFd, 2);
    // POSIX_SPAWN_SETPGROUP: group 0 makes the child its own group leader,
    // matching detached command capture so forced termination reaches it.
    if (
      symbols.posix_spawnattr_setpgroup(attributes, 0) !== 0 ||
      symbols.posix_spawnattr_setflags(attributes, 2) !== 0
    )
      throw new Error("spawn group");
    const args = argv.map(cString);
    const env = [cString(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)];
    const pid = new Int32Array(1);
    const file = cString(argv[0]!);
    const result = symbols.posix_spawnp(
      pid,
      file,
      actions,
      attributes,
      cStringArray(args),
      cStringArray(env),
    );
    if (result !== 0) throw new Error(`posix_spawnp failed: ${result}`);
    return pid[0]!;
  } finally {
    symbols.posix_spawnattr_destroy(attributes);
    symbols.posix_spawn_file_actions_destroy(actions);
  }
}

/** `ps`'s parent and state for `pid`, or undefined once it names no process. */
export function processState(pid: number): { ppid: number; state: string } | undefined {
  const output = Bun.spawnSync(["/bin/ps", "-o", "ppid=,stat=", "-p", String(pid)])
    .stdout.toString()
    .trim();
  const match = /^(\d+)\s+(\S+)$/.exec(output);
  return match ? { ppid: Number(match[1]), state: match[2]! } : undefined;
}

/** Waits until `pid` is a zombie. */
export async function untilZombie(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!processState(pid)?.state.startsWith("Z")) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} did not become a zombie`);
    await Bun.sleep(10);
  }
}

/** Synchronous kernel operations; injectable so PID reuse needs no real signals. */
export type UntrackedChildCleanupSystem = {
  wait(pid: number, noHang: boolean): number;
  kill(pid: number): void;
};

/**
 * Only signal a child waitpid still identifies as our running, unreaped child.
 * No await separates that check from the signal: neither the JS reaper nor Bun
 * can release this untracked child in between. A successful wait or ECHILD ends
 * ownership immediately, including when the PID now belongs to another parent.
 */
export function cleanUpUntrackedChild(
  pid: number,
  system: UntrackedChildCleanupSystem = {
    wait: (child, noHang) => lib().waitpid(child, new Int32Array(1), noHang ? 1 : 0),
    kill: (child) => process.kill(child, "SIGKILL"),
  },
): void {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return;
  if (system.wait(pid, true) !== 0) return;
  system.kill(pid);
  system.wait(pid, false);
}

type FakeSubprocess = {
  pid: number;
  stdin: { end(): void };
  exited: Promise<number>;
  exitCode: null;
  signalCode: null;
  kill(signal?: NodeJS.Signals): void;
};

/**
 * Makes `Bun.spawn` start its child untracked, the whole of Bun's lost exit:
 * `exited` never settles, `exitCode` stays null and the child stays a zombie.
 * Honours numeric stdout and stderr; stdin is always `/dev/null`. Returns the
 * PIDs it started and what puts Bun back.
 */
export function loseBunExitsEntirely({
  lateEchildMs,
  errorMs,
}: {
  /** Then reject `exited` with ECHILD, as Bun does when it handles the exit after someone reaped the child. */
  lateEchildMs?: number;
  /** Simulate a runtime transport error while the child is still running. */
  errorMs?: number;
} = {}): { pids: number[]; restore(): void } {
  const pids: number[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (callback: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, ms);
    timers.add(timer);
  };
  const spy = spyOn(Bun, "spawn").mockImplementation(((
    argv: string[],
    options: { stdout?: unknown; stderr?: unknown } = {},
  ) => {
    const pid = spawnUntrackedChild(argv, {
      stdoutFd: typeof options.stdout === "number" ? options.stdout : undefined,
      stderrFd: typeof options.stderr === "number" ? options.stderr : undefined,
    });
    pids.push(pid);
    const child: FakeSubprocess = {
      pid,
      stdin: { end: () => undefined },
      exited: new Promise((_resolve, reject) => {
        if (errorMs !== undefined) {
          later(() => {
            process.kill(pid, "SIGKILL");
            reject(new Error("fixture runtime error"));
          }, errorMs);
          return;
        }
        if (lateEchildMs === undefined) return;
        later(() => reject(new Error("ECHILD: unknown error, waitpid")), lateEchildMs);
      }),
      exitCode: null,
      signalCode: null,
      kill: (signal) => process.kill(pid, signal ?? "SIGTERM"),
    };
    return child;
  }) as unknown as typeof Bun.spawn);
  return {
    pids,
    restore: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      spy.mockRestore();
    },
  };
}

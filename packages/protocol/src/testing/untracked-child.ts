import { spyOn } from "bun:test";
import { dlopen, FFIType, ptr } from "bun:ffi";

/**
 * Children of the test process that Bun knows nothing about, started with
 * libSystem's `posix_spawnp`. Bun never reaps them, so one that exits stays a
 * zombie until something calls `waitpid`: the state a child is left in when Bun
 * loses its exit (docs/todo/cross-cutting/4260-bun-loses-child-process-events.md).
 * macOS only.
 */

const libSystem = () =>
  dlopen("/usr/lib/libSystem.B.dylib", {
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
  const devNull = cString("/dev/null");
  try {
    symbols.posix_spawn_file_actions_addopen(actions, 0, devNull, 0, 0);
    if (stdoutFd !== undefined) symbols.posix_spawn_file_actions_adddup2(actions, stdoutFd, 1);
    if (stderrFd !== undefined) symbols.posix_spawn_file_actions_adddup2(actions, stderrFd, 2);
    const args = argv.map(cString);
    const env = [cString(`PATH=${process.env.PATH ?? "/usr/bin:/bin"}`)];
    const pid = new Int32Array(1);
    const file = cString(argv[0]!);
    const result = symbols.posix_spawnp(
      pid,
      file,
      actions,
      null,
      cStringArray(args),
      cStringArray(env),
    );
    if (result !== 0) throw new Error(`posix_spawnp failed: ${result}`);
    return pid[0]!;
  } finally {
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

/** Kills and reaps an untracked child the test still owns. Safe after it was reaped. */
export function cleanUpUntrackedChild(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone, or already a zombie.
  }
  // Blocking, but SIGKILL has just been sent; -1 means it was already reaped.
  lib().waitpid(pid, new Int32Array(1), 0);
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
}: {
  /** Then reject `exited` with ECHILD, as Bun does when it handles the exit after someone reaped the child. */
  lateEchildMs?: number;
} = {}): { pids: number[]; restore(): void } {
  const pids: number[] = [];
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
        if (lateEchildMs === undefined) return;
        setTimeout(() => reject(new Error("ECHILD: unknown error, waitpid")), lateEchildMs);
      }),
      exitCode: null,
      signalCode: null,
      kill: (signal) => process.kill(pid, signal ?? "SIGTERM"),
    };
    return child;
  }) as unknown as typeof Bun.spawn);
  return { pids, restore: () => spy.mockRestore() };
}

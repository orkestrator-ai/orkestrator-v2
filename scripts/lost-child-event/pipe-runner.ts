/**
 * The old pipe-based `runCommand` (to-do 6900), for `in-process.ts` only. It
 * is `executeCommandBytes` from `git show 96ee1eb3e:apps/backend/src/core/shell.ts`
 * with today's output limits, minus everything that settles a command before
 * the probe can see a loss: no git output-close grace, no lost-exit watchdog
 * and no reaper. Each child is registered with the strict probe (`probe.ts`).
 *
 * Nothing in the product imports this, and `runCommand` stays on file
 * capture: `scratch.ts` splices this into a throwaway worktree's
 * `packages/protocol/src/node/command-capture.ts` only, for `in-process.ts`.
 * Its failures carry the fields that file's `runCommandBytes` reads
 * (`code`, `killed`, `signal`, `outputLimitExceeded`, `stdout`, `stderr`).
 */
import { spawn } from "node:child_process";
import { mark, openFds, track } from "./probe";

/** The subset of `RunCommandOptions` the reduced test's callers pass. */
export type PipeRunOptions = {
  signal?: AbortSignal;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxStderrBytes?: number;
};

/** What the real capture's `CommandFailedError` is built from. */
export type PipeFailure = Error & {
  stdout: Buffer;
  stderr: Buffer;
  /** Timed out or aborted: what the capture calls `killed`. */
  killed: boolean;
  outputLimitExceeded: boolean;
  /** The exit code, or the spawn error's code (`ENOENT`). */
  code: number | string | null;
  signal: NodeJS.Signals | null;
};

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const KILL_GRACE_MS = 100;

/** Spawns with `stdio: "pipe"` and settles on `close`, as `runCommand` did before file capture. */
export function runPipe(
  command: string,
  args: string[],
  options: PipeRunOptions,
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const limits = {
    stdout: options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
    stderr: options.maxStderrBytes ?? options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
  };
  return new Promise((resolve, reject) => {
    const failure = (message: string, details: Partial<PipeFailure>): PipeFailure =>
      Object.assign(new Error(message), {
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        killed: false,
        outputLimitExceeded: false,
        code: null,
        signal: null,
        ...details,
      });
    if (options.signal?.aborted) {
      reject(failure("Command aborted", { killed: true }));
      return;
    }
    const before = openFds();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env,
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    track(child, [command, ...args], before, options.cwd, options.env);
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const bytes = { stdout: 0, stderr: 0 };
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, signal);
      } catch {
        // Already gone.
      }
    };
    const output = () => ({
      stdout: Buffer.concat(chunks.stdout, bytes.stdout),
      stderr: Buffer.concat(chunks.stderr, bytes.stderr),
    });
    const fail = (error: PipeFailure) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(Object.assign(error, output()));
    };
    const abort = () => {
      timedOut = true;
      mark(child.pid, "aborted");
      kill("SIGKILL");
      fail(failure("Command aborted", { killed: true }));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream].on("data", (chunk: Buffer) => {
        if (settled || timedOut) return;
        const kept = chunk.subarray(0, Math.max(0, limits[stream] - bytes[stream]));
        chunks[stream].push(kept);
        bytes[stream] += kept.length;
        if (kept.length < chunk.length) {
          kill("SIGKILL");
          fail(failure(`${stream} maxBuffer length exceeded`, { outputLimitExceeded: true }));
        }
      });
      child[stream].on("error", (error: Error) => {
        if (settled || timedOut) return;
        kill("SIGKILL");
        fail(failure(error.message, {}));
      });
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled || timedOut) return;
      kill("SIGKILL");
      fail(failure(error.message, { code: error.code ?? null }));
    });
    child.stdin.on("error", () => undefined);
    child.on("close", (code, signal) => {
      if (settled || timedOut) return;
      if (code !== 0 || signal !== null) {
        fail(failure(`Command failed: ${[command, ...args].join(" ")}`, { code, signal }));
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      options.signal?.removeEventListener("abort", abort);
      resolve(output());
    });
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        mark(child.pid, "timed-out");
        kill("SIGTERM");
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        timeoutTimer = setTimeout(() => {
          kill("SIGKILL");
          fail(
            failure(`Command timed out after ${timeoutMs} ms`, {
              killed: true,
              code: child.exitCode,
              signal: child.signalCode,
            }),
          );
        }, KILL_GRACE_MS);
      }, timeoutMs);
    }
    child.stdin.end(options.stdin);
  });
}

import { CommandFailedError } from "../command-capture.js";
import type { SshAdapterContext } from "./context.js";

export type BoundedCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when an output bound stopped the child. */
  overflowed: boolean;
  /** True when the binary could not be started at all. */
  spawnFailed: boolean;
};

export type BoundedCommandOptions = {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

/**
 * A chatty helper's diagnostics are kept to `maxStderrBytes` without stopping it,
 * but they go to a file while it runs, so this much stops it.
 */
const STDERR_STOP_BYTES = 1024 * 1024;

/**
 * Run a short-lived local helper (`ssh -G`, a host-key probe, `ssh-keygen -l`)
 * from an argv array with a deadline and bounded output. Stdin is closed so
 * nothing can wait on a terminal, and the deadline settles the call whether or
 * not the runtime reports the child's exit.
 */
export async function runBoundedCommand(
  context: SshAdapterContext,
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  const clipStderr = (stderr: string) => stderr.slice(0, options.maxStderrBytes);
  try {
    const { stdout, stderr } = await context.capture(command, [...args], {
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxStdoutBytes,
      maxStderrBytes: Math.max(options.maxStderrBytes, STDERR_STOP_BYTES),
      env: options.env ?? context.env,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      exitCode: 0,
      signal: null,
      stdout,
      stderr: clipStderr(stderr),
      timedOut: false,
      overflowed: false,
      spawnFailed: false,
    };
  } catch (error) {
    // Anything but a command failure, or one that names no outcome, never ran.
    const ran =
      error instanceof CommandFailedError &&
      (error.exitCode !== null ||
        error.signal !== null ||
        error.timedOut ||
        error.outputLimitExceeded);
    if (!ran) {
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        overflowed: false,
        spawnFailed: true,
      };
    }
    return {
      exitCode: error.exitCode,
      signal: error.signal,
      stdout: error.stdout,
      stderr: clipStderr(error.stderr),
      timedOut: error.timedOut && !error.aborted,
      overflowed: error.outputLimitExceeded,
      spawnFailed: false,
    };
  }
}

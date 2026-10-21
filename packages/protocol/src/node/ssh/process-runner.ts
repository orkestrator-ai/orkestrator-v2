import type { SshAdapterContext } from "./context.js";

export type BoundedCommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True when stdout exceeded its bound; the child was stopped. */
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

const KILL_GRACE_MS = 1_000;

/**
 * Run a short-lived local helper (`ssh -G`, a host-key probe, `ssh-keygen -l`)
 * from an argv array with a deadline and bounded output. Stdin is closed so
 * nothing can wait on a terminal.
 */
export function runBoundedCommand(
  context: SshAdapterContext,
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
): Promise<BoundedCommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = context.spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env ?? context.env,
      shell: false,
      windowsHide: true,
    });

    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => stop();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) stop();

    const finish = (result: Omit<BoundedCommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > options.maxStdoutBytes) {
        overflowed = true;
        stop();
        return;
      }
      stdout += text;
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (stderrBytes >= options.maxStderrBytes) return;
      const room = options.maxStderrBytes - stderrBytes;
      stderrBytes += Buffer.byteLength(text);
      stderr += text.length > room ? text.slice(0, room) : text;
    });
    child.once("error", () => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        overflowed,
        spawnFailed: true,
      });
    });
    child.once("exit", (code, signal) => {
      // Let buffered pipe data drain before resolving.
      setImmediate(() =>
        finish({ exitCode: code, signal, timedOut, overflowed, spawnFailed: false }),
      );
    });
  });
}

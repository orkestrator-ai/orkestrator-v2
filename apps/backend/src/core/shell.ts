import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import * as captureFs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { formatLogError } from "@orkestrator/protocol/logger";
import { classifyCommandFailure } from "@orkestrator/protocol/node/command-failure-reason";
import {
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_SIZE_LABEL,
  readReadableHostFile,
  validateRelativeFilePath,
  writeConfinedFile,
} from "./path-safety.js";
import { recurringWorkMetrics, spawnWorkUnit } from "./recurring-work-metrics.js";
import { groupHasLiveMember, readZombieExit, type CommandExit } from "./shell-process-state.js";

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export type ExecBufferResult = {
  stdout: Buffer;
  stderr: Buffer;
};

/**
 * A child process failure with the outcome preserved separately from the text.
 *
 * Callers that need to classify a failure (timeout vs. missing binary vs. a
 * real non-zero exit) must not pattern-match the message: it is whatever the
 * child wrote to stderr, is locale- and version-dependent, and for a timeout is
 * empty because the child is killed before it can explain itself.
 *
 * `message` and `stdout` hold the child's output, so a raw `console` call or a
 * `JSON.stringify` prints the safe form below instead: a classified reason, the
 * exit code and signal, and bounded stack frames. `String(error)` and reading
 * `.message` still give the output, because callers build user-facing text from
 * them; a log line must not, and `formatLogError` is how it avoids that.
 */
export class CommandFailedError extends Error {
  readonly stdout: string;
  readonly timedOut: boolean;
  /** Compatibility classification for callers rejecting failed pipe captures. */
  readonly outputCloseTimedOut: boolean;
  readonly executableMissing: boolean;
  /** The caller's abort signal stopped it. `timedOut` is also set, as callers expect. */
  readonly aborted: boolean;
  /** It wrote more than `MAX_COMMAND_OUTPUT_BYTES`, so it was killed. */
  readonly outputLimitExceeded: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    details: {
      stdout?: string;
      timedOut?: boolean;
      outputCloseTimedOut?: boolean;
      executableMissing?: boolean;
      aborted?: boolean;
      outputLimitExceeded?: boolean;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    } = {},
  ) {
    super(message);
    this.name = "CommandFailedError";
    this.stdout = details.stdout ?? "";
    this.timedOut = details.timedOut ?? false;
    this.outputCloseTimedOut = details.outputCloseTimedOut ?? false;
    this.executableMissing = details.executableMissing ?? false;
    this.aborted = details.aborted ?? false;
    this.outputLimitExceeded = details.outputLimitExceeded ?? false;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
  }

  toJSON() {
    return { ...formatLogError(this), ...classifyCommandFailure(this) };
  }

  [inspect.custom](): string {
    const { name, reason, exitCode, signal, stack } = this.toJSON();
    const frames = stack?.length ? ` | ${stack.join(" | ")}` : "";
    return `${name} reason=${reason} exitCode=${exitCode} signal=${signal} outputOmitted=true${frames}`;
  }
}

type RunCommandOptions = {
  signal?: AbortSignal;
  /** Wait for same-group descendants and capture their late output. Defaults to leader exit. */
  waitForDescendants?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload. When omitted, stdin is closed immediately. */
  stdin?: string | Buffer;
  /** Defaults to 60 seconds; 0 disables the deadline. Invalid durations are rejected. */
  timeoutMs?: number;
  /**
   * Values that must never escape this process boundary. Both successful
   * output and errors are redacted because some CLIs echo argv or environment
   * values when reporting failures.
   */
  redactValues?: ReadonlyArray<string | null | undefined>;
};

function redactCommandValues(
  value: string,
  redactValues: ReadonlyArray<string | null | undefined> | undefined,
): string {
  const secrets = Array.from(
    new Set(
      (redactValues ?? []).filter(
        (secret): secret is string => typeof secret === "string" && secret.length > 0,
      ),
    ),
  ).sort((left, right) => right.length - left.length);

  return secrets.reduce((redacted, secret) => redacted.split(secret).join("[REDACTED]"), value);
}

const COMMAND_ABORTED_MESSAGE = "Command aborted";
const OUTPUT_LIMIT_MESSAGE = "maxBuffer length exceeded";

/** Classify failures using structured outcomes rather than CLI output. */
function commandFailureOutcome(error: unknown): {
  timedOut: boolean;
  executableMissing: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
} {
  const details = (error ?? {}) as {
    killed?: boolean;
    code?: number | string | null;
    signal?: NodeJS.Signals | null;
    message?: unknown;
    outputLimitExceeded?: boolean;
  };
  // Read the internal abort message before it is replaced by child output.
  // Capture overflow carries a marker independent of command arguments.
  const message = typeof details.message === "string" ? details.message : "";
  return {
    timedOut: details.killed === true,
    executableMissing: details.code === "ENOENT",
    aborted: message === COMMAND_ABORTED_MESSAGE,
    outputLimitExceeded: details.outputLimitExceeded === true,
    exitCode: typeof details.code === "number" ? details.code : null,
    signal: details.signal ?? null,
  };
}

/**
 * A git command that talks to a remote ran out of time. Still a timeout to
 * every generic handler, but distinguishable: the usual cause is credentials
 * (an SSH key waiting on a passphrase) or the network, not a container runtime.
 */
export class GitRemoteTimeoutError extends CommandFailedError {
  constructor(message: string, details: { signal?: NodeJS.Signals | null } = {}) {
    super(message, { timedOut: true, signal: details.signal });
    this.name = "GitRemoteTimeoutError";
  }
}

/**
 * Subprocesses started through `runCommand`, by program name. Counts only —
 * never arguments — so benchmarks can report how many Docker calls a scenario
 * costs. Process-wide on purpose, as are the observers: they count this
 * process's own subprocesses, and `runCommand` has no backend in reach.
 */
const commandInvocations = new Map<string, number>();

export function commandInvocationCount(command: string): number {
  return commandInvocations.get(command) ?? 0;
}

type CommandObserver = (args: readonly string[]) => void;
const commandObservers = new Map<string, Set<CommandObserver>>();

/**
 * Calls `observer` with the arguments of each `runCommand` of `command` until
 * the returned function is called. For benchmarks that attribute a count by
 * verb or target: an observer must not keep or report the arguments.
 */
export function observeCommandInvocations(command: string, observer: CommandObserver): () => void {
  const observers = commandObservers.get(command) ?? new Set<CommandObserver>();
  observers.add(observer);
  commandObservers.set(command, observers);
  return () => {
    observers.delete(observer);
    if (observers.size === 0) commandObservers.delete(command);
  };
}

/**
 * Makes a `git` child fail instead of waiting for someone to answer it.
 *
 * The backend has no terminal to type into, but a child inherits whatever
 * controlling tty the backend was launched from. An `ssh` that cannot read its
 * key then sits on a passphrase or host-key prompt until the timeout, which
 * surfaces as "Environment start timed out" and hides the real cause.
 * `SSH_ASKPASS_REQUIRE=force` routes every ssh prompt to a program that refuses,
 * so the failure is an immediate `Permission denied (publickey)`. That is used
 * rather than `GIT_SSH_COMMAND=ssh -o BatchMode=yes` because the env var would
 * override a `core.sshCommand` the user configured. Keychain and agent lookups
 * happen before ssh prompts, so a key that is available still works.
 *
 * Anything the caller or the backend's own environment already set wins.
 */
function nonInteractiveGitEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const merged = { ...(env ?? process.env) };
  merged.GIT_TERMINAL_PROMPT ??= "0";
  if (process.platform !== "win32") {
    merged.SSH_ASKPASS ??= "/usr/bin/false";
    merged.SSH_ASKPASS_REQUIRE ??= "force";
  }
  return merged;
}

const MAX_COMMAND_OUTPUT_BYTES = 50 * 1024 * 1024;
const COMMAND_KILL_GRACE_MS = 100;
/** A file has no back-pressure, so a runaway command is noticed by looking. */
const COMMAND_OUTPUT_CHECK_MS = 100;
const COMMAND_GROUP_POLL_MS = 5;
const COMMAND_GROUP_POLL_MAX_MS = 200;
const COMMAND_EXIT_WATCH_MS = 1_000;
const COMMAND_EXIT_WATCH_MAX_MS = 16_000;

/**
 * Opens a private, already unlinked file for one stream of a command.
 *
 * Output goes to a file and not a pipe because Bun 1.4.4's pipe readers can miss
 * the end of a stream: the kernel reports EOF on the socket and Bun never reads
 * it, so a child that exited in 2 ms looks unfinished until its 10 s or 60 s
 * timeout, through `Bun.spawn` as much as `node:child_process`
 * (docs/tests/flaky-tests/environments-and-containers/1537-diff-base-override-scan-timeout.md).
 * The file is unlinked before the child starts, so captured output has no name
 * on disk and its blocks are freed with the last descriptor. Appending keeps a
 * child that reopens `/dev/stdout` from writing over what is there.
 */
function openCaptureFile(): number {
  const filePath = path.join(os.tmpdir(), `orkestrator-capture-${randomUUID()}`);
  const fd = captureFs.openSync(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_APPEND,
    0o600,
  );
  try {
    captureFs.unlinkSync(filePath);
    return fd;
  } catch (error) {
    captureFs.closeSync(fd);
    throw error;
  }
}

/** The first `MAX_COMMAND_OUTPUT_BYTES` of a stream. Synchronous, so no event can be lost. */
function readCaptureFile(fd: number): Buffer {
  const size = Math.min(captureFs.fstatSync(fd).size, MAX_COMMAND_OUTPUT_BYTES);
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = captureFs.readSync(fd, buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

/**
 * Starts a captured command. POSIX detached children lead a private
 * session/process group; these commands do not need the backend's controlling tty.
 */
function spawnCaptured(
  command: string,
  args: string[],
  options: RunCommandOptions,
  stdoutFd: number,
  stderrFd: number,
) {
  const payload = options.stdin?.length ? Buffer.from(options.stdin) : undefined;
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env: command === "git" ? nonInteractiveGitEnv(options.env) : (options.env ?? process.env),
    detached: process.platform !== "win32",
    stdin: payload ?? "pipe",
    stdout: stdoutFd,
    stderr: stderrFd,
  });
  // Close stdin immediately when there is no payload, so CLIs cannot await EOF.
  if (!payload) closeStdin(child.stdin as Bun.FileSink);
  return child;
}

function closeStdin(stdin: Bun.FileSink): void {
  try {
    // Closing can reject once the child is gone, and nothing is left to deliver.
    void Promise.resolve(stdin.end()).catch(() => undefined);
  } catch {
    // Already closed. The child sees EOF either way.
  }
}

type CapturedChild = ReturnType<typeof spawnCaptured>;

/** Signal only the group created for this command, never PIDs from a ps snapshot. */
function signalCommand(child: CapturedChild, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32") {
      // The group can outlive its leader, and it may still be writing output.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // Already gone or no longer signalable. Settlement must not depend on this.
  }
}

/**
 * Whether anything still runs in the command's group. The signal is the common
 * path: only a group that still exists is worth enumerating for live members.
 */
function commandGroupAlive(child: CapturedChild): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-child.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  return groupHasLiveMember(child.pid);
}

function executeCommandBytes(
  command: string,
  args: string[],
  options: RunCommandOptions,
  timeoutMs: number,
): Promise<ExecBufferResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(Object.assign(new Error(COMMAND_ABORTED_MESSAGE), { killed: true }));
      return;
    }
    const captureFds: number[] = [];
    const releaseCaptureFds = () => {
      for (const fd of captureFds.splice(0)) {
        try {
          captureFs.closeSync(fd);
        } catch {
          /* Continue releasing the other stream. */
        }
      }
    };
    try {
      captureFds.push(openCaptureFile());
      captureFds.push(openCaptureFile());
    } catch (error) {
      releaseCaptureFds();
      // Not the command's own outcome: an ENOENT here must not read as a missing executable.
      const code = (error as NodeJS.ErrnoException).code ?? "unknown";
      reject(new Error(`Could not open a command output file in the temporary directory: ${code}`));
      return;
    }
    const [stdoutFd, stderrFd] = captureFds as [number, number];
    let child: CapturedChild;
    try {
      child = spawnCaptured(command, args, options, stdoutFd, stderrFd);
    } catch (error) {
      releaseCaptureFds();
      reject(error);
      return;
    }
    let settled = false;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let groupTimer: ReturnType<typeof setTimeout> | undefined;
    let limitTimer: ReturnType<typeof setInterval> | undefined;
    let exitWatchTimer: ReturnType<typeof setTimeout> | undefined;
    let commandExit: CommandExit | undefined;

    /** Ends the command's capture and returns what it wrote. Runs exactly once. */
    const finishCapture = (): ExecBufferResult | undefined => {
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(groupTimer);
      clearInterval(limitTimer);
      clearTimeout(exitWatchTimer);
      options.signal?.removeEventListener("abort", abort);
      try {
        return { stdout: readCaptureFile(stdoutFd), stderr: readCaptureFile(stderrFd) };
      } catch (error) {
        reject(error);
        return undefined;
      } finally {
        releaseCaptureFds();
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      const output = finishCapture();
      if (output) reject(Object.assign(error, { ...output, killed: timedOut }));
    };
    const abort = () => {
      timedOut = true;
      signalCommand(child, "SIGKILL");
      fail(new Error(COMMAND_ABORTED_MESSAGE));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const checkOutputLimit = (): boolean => {
      const stream =
        captureFs.fstatSync(stdoutFd).size > MAX_COMMAND_OUTPUT_BYTES
          ? "stdout"
          : captureFs.fstatSync(stderrFd).size > MAX_COMMAND_OUTPUT_BYTES
            ? "stderr"
            : undefined;
      if (stream === undefined) return false;
      signalCommand(child, "SIGKILL");
      fail(
        Object.assign(new Error(`${stream} ${OUTPUT_LIMIT_MESSAGE}`), {
          outputLimitExceeded: true,
        }),
      );
      return true;
    };
    const failIfOverLimit = (): boolean => {
      try {
        return checkOutputLimit();
      } catch (error) {
        signalCommand(child, "SIGKILL");
        fail(error instanceof Error ? error : new Error(String(error)));
        return true;
      }
    };
    limitTimer = setInterval(() => {
      if (!settled && !timedOut) failIfOverLimit();
    }, COMMAND_OUTPUT_CHECK_MS);
    const settleOnExit = () => {
      if (settled || timedOut || failIfOverLimit()) return;
      if (commandExit?.code !== 0 || commandExit.signal !== null) {
        fail(
          Object.assign(new Error(`Command failed: ${[command, ...args].join(" ")}`), {
            code: commandExit?.code,
            signal: commandExit?.signal,
          }),
        );
        return;
      }
      const output = finishCapture();
      if (output) resolve(output);
    };
    // Default capture is a snapshot at leader exit. Helpers may outlive it;
    // callers needing their late output explicitly opt into group waiting.
    const awaitGroupExit = (delayMs: number) => {
      if (settled || timedOut) return;
      if (commandGroupAlive(child)) {
        groupTimer = setTimeout(
          awaitGroupExit,
          delayMs,
          Math.min(delayMs * 2, COMMAND_GROUP_POLL_MAX_MS),
        );
        return;
      }
      settleOnExit();
    };
    const onCommandExit = (exit: CommandExit) => {
      if (commandExit) return;
      commandExit = exit;
      clearTimeout(exitWatchTimer);
      if (options.waitForDescendants) awaitGroupExit(COMMAND_GROUP_POLL_MS);
      else settleOnExit();
    };
    void child.exited.then(
      () =>
        onCommandExit({ code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null }),
      (error) => fail(error instanceof Error ? error : new Error(String(error))),
    );
    // On macOS Bun can lose the exit itself, and the child waits as a zombie that
    // nothing will reap. Its status is still readable, so ask once it has had time.
    const watchForLostExit = (delayMs: number) => {
      exitWatchTimer = setTimeout(() => {
        if (settled || timedOut || commandExit) return;
        const exit = readZombieExit(child.pid);
        if (exit) onCommandExit(exit);
        else watchForLostExit(Math.min(delayMs * 2, COMMAND_EXIT_WATCH_MAX_MS));
      }, delayMs);
    };
    if (process.platform === "darwin") watchForLostExit(COMMAND_EXIT_WATCH_MS);
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalCommand(child, "SIGTERM");
        // Always escalate, even if the leader exits during the grace period.
        // That does not prove that the group's descendants exited.
        timeoutTimer = setTimeout(() => {
          signalCommand(child, "SIGKILL");
          fail(
            Object.assign(new Error(`Command timed out after ${timeoutMs} ms`), {
              code: child.exitCode,
              signal: child.signalCode,
            }),
          );
        }, COMMAND_KILL_GRACE_MS);
      }, timeoutMs);
    }
  });
}

async function runCommandBytes(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<ExecBufferResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be an integer between 0 and 2147483647");
  }
  if (commandInvocations.size < 64 || commandInvocations.has(command)) {
    commandInvocations.set(command, (commandInvocations.get(command) ?? 0) + 1);
  }
  for (const observer of commandObservers.get(command) ?? []) observer(args);
  // The one boundary every `runCommand` spawn crosses, so each process is
  // counted exactly once and charged to whichever recurring job caused it.
  recurringWorkMetrics.work(spawnWorkUnit(command, args));
  try {
    const { stdout, stderr } = await executeCommandBytes(command, args, options, timeoutMs);
    recurringWorkMetrics.bytes(stdout.length);
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
    };
  } catch (error) {
    const outcome = commandFailureOutcome(error);
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const withOutput = error as {
        message?: string;
        stdout?: Buffer | string;
        stderr?: Buffer | string;
      };
      const stderr = withOutput.stderr?.toString() ?? "";
      const stdout = withOutput.stdout?.toString() ?? "";
      const message = (stderr || stdout || withOutput.message || "Command failed").trim();
      throw new CommandFailedError(redactCommandValues(message, options.redactValues), {
        ...outcome,
        stdout: redactCommandValues(stdout, options.redactValues),
      });
    }
    if (options.redactValues?.some((value) => typeof value === "string" && value.length > 0)) {
      const message = error instanceof Error ? error.message : String(error);
      // Construct a clean Error instead of returning the original child-process
      // error, which can expose argv through enumerable `cmd`/`spawnargs` fields.
      throw new CommandFailedError(
        redactCommandValues(message || "Command failed", options.redactValues),
        outcome,
      );
    }
    if (outcome.timedOut || outcome.executableMissing) {
      // The outcome is the only thing distinguishing these from an ordinary
      // non-zero exit, and it is not recoverable from the message.
      const message = error instanceof Error ? error.message : String(error);
      throw new CommandFailedError(message || "Command failed", outcome);
    }
    throw error;
  }
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<ExecResult> {
  const { stdout, stderr } = await runCommandBytes(command, args, options);
  return {
    stdout: redactCommandValues(stdout.toString(), options.redactValues),
    stderr: redactCommandValues(stderr.toString(), options.redactValues),
  };
}

/** Runs a command without decoding stdout, for callers that validate the original bytes. */
export function runCommandBuffer(
  command: string,
  args: string[] = [],
  options: Omit<RunCommandOptions, "redactValues"> = {},
): Promise<ExecBufferResult> {
  return runCommandBytes(command, args, options);
}

export function spawnCommand(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {},
): ChildProcessWithoutNullStreams {
  return spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio: "pipe",
  });
}

/**
 * Runs `"$@"` until it exits, this backend closes the wrapper's stdin, or the
 * wrapper is signalled. The backend never writes to that pipe, so EOF means the
 * backend is gone: a SIGKILL skips every shutdown path, and a follower that
 * only ever reads (`docker events`) would otherwise run forever as an orphan.
 *
 * An asynchronous list's stdin is /dev/null in a non-interactive shell, so the
 * pipe is kept on fd 3 for the watcher.
 */
export const PARENT_BOUND_SCRIPT = [
  "exec 3<&0",
  '"$@" </dev/null 3<&- &',
  "c=$!",
  "trap 'kill \"$c\" 2>/dev/null' HUP INT TERM",
  '( while read -r _; do :; done; kill "$c" 2>/dev/null ) <&3 &',
  "w=$!",
  "exec 3<&-",
  'wait "$c"',
  "s=$?",
  'kill "$w" 2>/dev/null',
  'exit "$s"',
].join("\n");

/**
 * A long-running follower that cannot outlive the backend (POSIX hosts). Its
 * stdout and stderr are the command's; `kill()` stops the command too.
 */
export function spawnParentBoundCommand(
  command: string,
  args: string[] = [],
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") return spawnCommand(command, args);
  return spawnCommand("/bin/sh", [
    "-c",
    PARENT_BOUND_SCRIPT,
    "orkestrator-follower",
    command,
    ...args,
  ]);
}

export async function commandExists(command: string): Promise<boolean> {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  try {
    await runCommand(lookupCommand, [command], { timeoutMs: 5_000 });
    return true;
  } catch {
    return false;
  }
}

export function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readFileBase64(filePath: string, allowedRoots?: string[]): Promise<string> {
  return (await readReadableHostFile(filePath, allowedRoots)).toString("base64");
}

/**
 * Writes a base64 payload into a worktree, overwriting an existing file.
 *
 * A plain `mkdir -p` + `writeFile` follows a symlink planted anywhere along the
 * path, so this goes through the confined writer that creates and validates
 * every ancestor itself. The returned path stays the lexical join of the caller's
 * root: callers echo it back to the renderer, which knows the worktree by the
 * path it asked for, not by its canonical form.
 */
export async function writeFileBase64(
  rootPath: string,
  relativePath: string,
  base64Data: string,
): Promise<string> {
  const safeRelativePath = validateRelativeFilePath(relativePath, "relative file path");
  await writeConfinedFile(rootPath, safeRelativePath, base64Data, {
    exclusive: false,
    label: "relative file path",
  });
  return path.join(rootPath, safeRelativePath);
}

export function inferLanguage(filePath: string): string {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  // `.env`, `.env.local`, `.env.production` and `production.env`. A bare
  // `.env` has no extension as far as `extname` is concerned.
  if (basename === ".env" || basename.startsWith(".env.") || extension === "env") {
    return "dotenv";
  }
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    rs: "rust",
    py: "python",
    rb: "ruby",
    sh: "shell",
    zsh: "shell",
    bash: "shell",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
  };
  return aliases[extension] ?? extension;
}

export function decodeEditorTextFile(contents: Uint8Array): string {
  if (contents.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `File is too large to open in the editor (maximum size is ${MAX_TEXT_FILE_SIZE_LABEL})`,
    );
  }
  if (contents.includes(0)) {
    throw new Error("Binary files cannot be opened in the text editor");
  }
  try {
    // Treat a UTF-8 BOM as text rather than decoder metadata so opening and
    // saving an unchanged editor buffer preserves the original bytes.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(contents);
  } catch {
    throw new Error("File is not valid UTF-8 text and cannot be opened in the editor");
  }
}

export function assertEditorTextFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("File size could not be determined safely");
  }
  if (size > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `File is too large to open in the editor (maximum size is ${MAX_TEXT_FILE_SIZE_LABEL})`,
    );
  }
}

function isPathInsideRoot(filePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, filePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export async function readTextFile(
  rootPath: string,
  relativePath: string,
  testHooks: { afterInitialValidation?: () => void | Promise<void> } = {},
): Promise<{ path: string; content: string; language: string }> {
  const safeRelativePath = validateRelativeFilePath(relativePath, "relative file path");

  const fullPath = path.join(rootPath, safeRelativePath);
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(fullPath),
  ]);
  if (!isPathInsideRoot(canonicalTarget, canonicalRoot)) {
    throw new Error("File is outside the local worktree");
  }
  const handle = await fs.open(
    canonicalTarget,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let contents: Buffer;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("File is not a regular file");
    assertEditorTextFileSize(stats.size);
    await testHooks.afterInitialValidation?.();

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_TEXT_FILE_BYTES) {
      const remaining = MAX_TEXT_FILE_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    contents = Buffer.concat(chunks, totalBytes);

    const [finalStats, finalTarget] = await Promise.all([handle.stat(), fs.realpath(fullPath)]);
    if (
      !finalStats.isFile() ||
      finalStats.dev !== stats.dev ||
      finalStats.ino !== stats.ino ||
      finalTarget !== canonicalTarget ||
      !isPathInsideRoot(finalTarget, canonicalRoot)
    ) {
      throw new Error("File changed while it was being read; please try again");
    }
  } finally {
    await handle.close();
  }
  return {
    path: safeRelativePath,
    content: decodeEditorTextFile(contents),
    language: inferLanguage(safeRelativePath),
  };
}

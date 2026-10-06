import {
  execFile,
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_SIZE_LABEL,
  readReadableHostFile,
  validateRelativeFilePath,
  writeConfinedFile,
} from "./path-safety.js";
import { recurringWorkMetrics, spawnWorkUnit } from "./recurring-work-metrics.js";

const execFileAsync = promisify(execFile);

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
 */
export class CommandFailedError extends Error {
  readonly timedOut: boolean;
  readonly executableMissing: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;

  constructor(
    message: string,
    details: {
      timedOut?: boolean;
      executableMissing?: boolean;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
    } = {},
  ) {
    super(message);
    this.name = "CommandFailedError";
    this.timedOut = details.timedOut ?? false;
    this.executableMissing = details.executableMissing ?? false;
    this.exitCode = details.exitCode ?? null;
    this.signal = details.signal ?? null;
  }
}

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional stdin payload. When omitted, stdin is closed immediately. */
  stdin?: string | Buffer;
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

/**
 * `execFile` reports a timeout only through `killed`, never in the message: it
 * SIGTERMs the child, so stdout/stderr are empty and the message is the generic
 * "Command failed: <argv>". A missing executable arrives as an ENOENT
 * `SystemError` with no output fields at all.
 */
function commandFailureOutcome(error: unknown): {
  timedOut: boolean;
  executableMissing: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
} {
  const details = (error ?? {}) as {
    killed?: boolean;
    code?: number | string | null;
    signal?: NodeJS.Signals | null;
  };
  return {
    timedOut: details.killed === true,
    executableMissing: details.code === "ENOENT",
    exitCode: typeof details.code === "number" ? details.code : null,
    signal: details.signal ?? null,
  };
}

/**
 * Subprocesses started through `runCommand`, by program name. Counts only —
 * never arguments — so benchmarks can report how many Docker calls a scenario
 * costs.
 */
const commandInvocations = new Map<string, number>();

export function commandInvocationCount(command: string): number {
  return commandInvocations.get(command) ?? 0;
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
  if (
    process.platform !== "win32" &&
    merged.SSH_ASKPASS === undefined &&
    merged.SSH_ASKPASS_REQUIRE === undefined
  ) {
    merged.SSH_ASKPASS = "/usr/bin/false";
    merged.SSH_ASKPASS_REQUIRE = "force";
  }
  return merged;
}

async function descendantPids(rootPid: number): Promise<number[]> {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const childrenOf = new Map<number, number[]>();
    for (const line of stdout.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid === undefined || ppid === undefined || Number.isNaN(pid) || Number.isNaN(ppid)) {
        continue;
      }
      childrenOf.set(ppid, [...(childrenOf.get(ppid) ?? []), pid]);
    }
    const found: number[] = [];
    const queue = [rootPid];
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      for (const child of childrenOf.get(next) ?? []) {
        found.push(child);
        queue.push(child);
      }
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Stops a timed-out child and everything it started.
 *
 * Killing only the child is not enough: `git fetch` runs `ssh` as a subprocess,
 * and once git dies that ssh is reparented to init and keeps its connection
 * open forever. The descendants have to be found before the child is killed,
 * because afterwards nothing links them to it.
 */
async function killProcessTree(child: ChildProcess): Promise<void> {
  const descendants = child.pid === undefined ? [] : await descendantPids(child.pid);
  // The child may have finished while its descendants were being listed; its
  // pid and theirs could then belong to unrelated processes.
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (const pid of descendants) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

async function runCommandBytes(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<ExecBufferResult> {
  if (commandInvocations.size < 64 || commandInvocations.has(command)) {
    commandInvocations.set(command, (commandInvocations.get(command) ?? 0) + 1);
  }
  // The one boundary every `runCommand` spawn crosses, so each process is
  // counted exactly once and charged to whichever recurring job caused it.
  recurringWorkMetrics.work(spawnWorkUnit(command, args));
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // execFile's own `timeout` is deliberately not used: it signals only the
    // child, which leaves anything the child started running.
    const execPromise = execFileAsync(command, args, {
      cwd: options.cwd,
      encoding: "buffer",
      env: command === "git" ? nonInteractiveGitEnv(options.env) : options.env,
      maxBuffer: 50 * 1024 * 1024,
    });
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timeoutTimer = setTimeout(() => void killProcessTree(execPromise.child), timeoutMs);
    }
    // execFile leaves the child's stdin pipe open. Close it immediately when
    // there is no payload so non-TTY CLIs cannot hang waiting for EOF.
    execPromise.child.stdin?.end(options.stdin);
    const { stdout, stderr } = await execPromise;
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
      throw new CommandFailedError(redactCommandValues(message, options.redactValues), outcome);
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
  } finally {
    clearTimeout(timeoutTimer);
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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./command-capture.js";
import {
  MAX_TEXT_FILE_BYTES,
  MAX_TEXT_FILE_SIZE_LABEL,
  readReadableHostFile,
  validateRelativeFilePath,
  writeConfinedFile,
} from "./path-safety.js";

export {
  CommandFailedError,
  commandInvocationCount,
  GitRemoteTimeoutError,
  observeCommandInvocations,
  nonInteractiveGitEnv,
  runCommand,
  runCommandBuffer,
  type ExecBufferResult,
  type ExecResult,
} from "./command-capture.js";

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
 *
 * The trap is installed before the command starts. The command can run, and
 * print, before this shell reaches its next line, so a signal sent as soon as
 * the command is seen used to kill the wrapper by default and orphan the
 * command (flake case 4471). A signal that arrives before `c` is known is
 * remembered and delivered once it is.
 *
 * The watcher's own stderr is discarded. A quick command makes the wrapper
 * `kill "$w"` right after forking the watcher, and a SIGTERM that lands while
 * Bash is still resetting the inherited trap in that subshell makes it print
 * `run_pending_traps: bad value in trap_list[15]` warnings, which would
 * otherwise reach the command's stderr (flake case 7341).
 */
export const PARENT_BOUND_SCRIPT = [
  "c=",
  "stop=",
  'trap \'stop=1; [ -z "$c" ] || kill "$c" 2>/dev/null\' HUP INT TERM',
  "exec 3<&0",
  '"$@" </dev/null 3<&- &',
  "c=$!",
  '[ -z "$stop" ] || kill "$c" 2>/dev/null',
  '( while read -r _; do :; done; kill "$c" 2>/dev/null ) <&3 2>/dev/null &',
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

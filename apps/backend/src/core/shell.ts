import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  assertBase64PayloadWithinLimit,
  readReadableHostFile,
  validateRelativeFilePath,
} from "./path-safety.js";

const execFileAsync = promisify(execFile);

export type ExecResult = {
  stdout: string;
  stderr: string;
};

type RunCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
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
  const secrets = Array.from(new Set(
    (redactValues ?? [])
      .filter((secret): secret is string => typeof secret === "string" && secret.length > 0),
  )).sort((left, right) => right.length - left.length);

  return secrets.reduce(
    (redacted, secret) => redacted.split(secret).join("[REDACTED]"),
    value,
  );
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: RunCommandOptions = {},
): Promise<ExecResult> {
  try {
    const execPromise = execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    // execFile leaves the child's stdin pipe open without ever writing to it.
    // CLIs that read piped (non-TTY) stdin — e.g. `codex exec` — block waiting
    // for an EOF that never arrives and hang until the timeout. We never feed
    // stdin here, so close it immediately to signal EOF.
    execPromise.child.stdin?.end();
    const { stdout, stderr } = await execPromise;
    return {
      stdout: redactCommandValues(stdout.toString(), options.redactValues),
      stderr: redactCommandValues(stderr.toString(), options.redactValues),
    };
  } catch (error) {
    if (error && typeof error === "object" && "stdout" in error && "stderr" in error) {
      const withOutput = error as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
      const stderr = withOutput.stderr?.toString() ?? "";
      const stdout = withOutput.stdout?.toString() ?? "";
      const message = (stderr || stdout || withOutput.message || "Command failed").trim();
      throw new Error(redactCommandValues(message, options.redactValues));
    }
    if (options.redactValues?.some((value) => typeof value === "string" && value.length > 0)) {
      const message = error instanceof Error ? error.message : String(error);
      // Construct a clean Error instead of returning the original child-process
      // error, which can expose argv through enumerable `cmd`/`spawnargs` fields.
      throw new Error(redactCommandValues(message || "Command failed", options.redactValues));
    }
    throw error;
  }
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

export async function readFileBase64(filePath: string): Promise<string> {
  return (await readReadableHostFile(filePath)).toString("base64");
}

export async function writeFileBase64(rootPath: string, relativePath: string, base64Data: string): Promise<string> {
  const safeRelativePath = validateRelativeFilePath(relativePath, "relative file path");
  assertBase64PayloadWithinLimit(base64Data);

  const fullPath = path.join(rootPath, safeRelativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, Buffer.from(base64Data, "base64"));
  return fullPath;
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

export async function readTextFile(rootPath: string, relativePath: string): Promise<{ path: string; content: string; language: string }> {
  const safeRelativePath = validateRelativeFilePath(relativePath, "relative file path");

  const fullPath = path.join(rootPath, safeRelativePath);
  return {
    path: safeRelativePath,
    content: await fs.readFile(fullPath, "utf8"),
    language: inferLanguage(safeRelativePath),
  };
}

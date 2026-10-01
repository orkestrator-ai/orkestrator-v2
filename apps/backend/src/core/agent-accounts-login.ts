import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentAccountPlatform } from "@orkestrator/protocol/agent-accounts";

/**
 * Drives a provider CLI's own login against one account directory.
 *
 * - Claude: `claude auth login` prints an authorize URL and reads the code the
 *   browser shows from stdin.
 * - Codex: `codex login --device-auth` prints a verification URL and a one-time
 *   code, then exits once the user approves it. Device code avoids the browser
 *   flow's fixed `127.0.0.1:1455` callback.
 *
 * The CLI owns the OAuth exchange and writes the credential where it always
 * does for that directory; this module never sees a token.
 */

const MAX_OUTPUT_BYTES = 64 * 1024;
const LOGIN_STARTUP_TIMEOUT_MS = 30_000;
/** Codex's device code expires after 15 minutes; Claude's flow is given the same. */
const LOGIN_TOTAL_TIMEOUT_MS = 16 * 60_000;
const MAX_LOGIN_CODE_LENGTH = 512;

// Matching the ESC control character is the point: it opens every ANSI sequence.
// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_PATTERN = /https:\/\/[^\s"'<>]+/g;
const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface ParsedLoginPrompt {
  url?: string;
  userCode?: string;
}

/** Claude prints the authorize URL once, after "visit:". */
export function parseClaudeLoginOutput(output: string): ParsedLoginPrompt {
  const text = stripAnsi(output);
  const url = (text.match(URL_PATTERN) ?? []).find((candidate) =>
    /\/oauth\/authorize\b/.test(candidate),
  );
  return url ? { url } : {};
}

/** Codex prints a verification URL and a code such as `ABCD-EFGH1`. */
export function parseCodexDeviceLoginOutput(output: string): ParsedLoginPrompt {
  const text = stripAnsi(output);
  const url = (text.match(URL_PATTERN) ?? []).find((candidate) =>
    /auth\.openai\.com\/.*device/.test(candidate),
  );
  const userCode = text.match(DEVICE_CODE_PATTERN)?.[0];
  return { ...(url ? { url } : {}), ...(userCode ? { userCode } : {}) };
}

export interface AgentAccountLoginCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * A directory holding no-op `open`/`xdg-open` so the CLI does not open a
 * browser on the backend's desktop. The renderer opens the URL itself, which
 * also works when it is a browser client on another machine.
 */
export async function ensureBrowserShim(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of ["open", "xdg-open"]) {
    const file = path.join(directory, name);
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.chmod(file, 0o700);
  }
  return directory;
}

/** Credentials inherited from the backend would pre-empt the login being created. */
export const INHERITED_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

export function agentAccountLoginCommand(options: {
  platform: AgentAccountPlatform;
  executable: string;
  /**
   * The account directory to sign in to. Absent for Claude's host login, which
   * the CLI writes wherever it always does (Keychain or `~/.claude`).
   */
  accountHome?: string;
  browserShimDirectory: string;
  env?: NodeJS.ProcessEnv;
}): AgentAccountLoginCommand {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), NO_COLOR: "1" };
  for (const key of INHERITED_CREDENTIAL_ENV) delete env[key];
  if (options.platform === "claude") {
    if (options.accountHome) env.CLAUDE_CONFIG_DIR = options.accountHome;
    env.PATH = [options.browserShimDirectory, env.PATH].filter(Boolean).join(path.delimiter);
    env.BROWSER = path.join(options.browserShimDirectory, "open");
    return { command: options.executable, args: ["auth", "login"], env };
  }
  if (options.accountHome) env.CODEX_HOME = options.accountHome;
  return { command: options.executable, args: ["login", "--device-auth"], env };
}

export interface AgentAccountLoginHandle {
  url: string;
  userCode?: string;
  needsCode: boolean;
  /** Settles when the CLI exits: resolves on a clean exit, rejects otherwise. */
  completion: Promise<void>;
  submitCode: (code: string) => void;
  cancel: () => void;
}

export type SpawnLike = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] },
) => ChildProcess;

/**
 * Spawn the login and resolve once it has printed what the user needs.
 *
 * Output is bounded and never logged: it carries the authorize URL's PKCE
 * challenge and state, and whatever the CLI prints about the account.
 */
export async function beginAgentAccountLogin(
  platform: AgentAccountPlatform,
  command: AgentAccountLoginCommand,
  options: {
    spawnImpl?: SpawnLike;
    startupTimeoutMs?: number;
    totalTimeoutMs?: number;
  } = {},
): Promise<AgentAccountLoginHandle> {
  const spawnImpl: SpawnLike = options.spawnImpl ?? spawn;
  const child = spawnImpl(command.command, command.args, {
    env: command.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let settleCompletion: (error?: Error) => void = () => undefined;
  const completion = new Promise<void>((resolve, reject) => {
    let settled = false;
    settleCompletion = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
  });
  // The caller may never observe completion when startup fails first.
  void completion.catch(() => undefined);

  let resolvePrompt: (value: ParsedLoginPrompt) => void = () => undefined;
  let rejectPrompt: (error: Error) => void = () => undefined;
  const prompt = new Promise<ParsedLoginPrompt>((resolve, reject) => {
    resolvePrompt = resolve;
    rejectPrompt = reject;
  });
  void prompt.catch(() => undefined);

  // Both CLIs trap SIGTERM (Codex even exits 0), so an exit we caused must
  // never read as a completed sign-in.
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  };
  const startupTimer = setTimeout(() => {
    // Settle before killing: the exit that follows would otherwise report a
    // timeout as a cancellation.
    const error = new Error("The sign-in did not start in time");
    rejectPrompt(error);
    settleCompletion(error);
    cancel();
  }, options.startupTimeoutMs ?? LOGIN_STARTUP_TIMEOUT_MS);
  startupTimer.unref?.();
  const totalTimer = setTimeout(() => {
    settleCompletion(new Error("The sign-in timed out"));
    cancel();
  }, options.totalTimeoutMs ?? LOGIN_TOTAL_TIMEOUT_MS);
  totalTimer.unref?.();

  let output = "";
  const parse = platform === "claude" ? parseClaudeLoginOutput : parseCodexDeviceLoginOutput;
  const onData = (chunk: Buffer | string): void => {
    output += chunk.toString();
    if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
    const parsed = parse(output);
    if (parsed.url && (platform === "claude" || parsed.userCode)) {
      clearTimeout(startupTimer);
      resolvePrompt(parsed);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.stdin?.on("error", () => undefined);

  child.once("error", (error) => {
    clearTimeout(startupTimer);
    clearTimeout(totalTimer);
    rejectPrompt(error);
    settleCompletion(error);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(startupTimer);
    clearTimeout(totalTimer);
    const error = new Error(
      cancelled || signal
        ? "The sign-in was cancelled"
        : `The sign-in did not complete (exit code ${code ?? "unknown"})`,
    );
    rejectPrompt(error);
    settleCompletion(code === 0 && !cancelled ? undefined : error);
  });

  const parsed = await prompt;
  return {
    url: parsed.url!,
    ...(parsed.userCode ? { userCode: parsed.userCode } : {}),
    needsCode: platform === "claude",
    completion,
    submitCode: (code: string) => {
      const trimmed = code.trim();
      if (!trimmed || trimmed.length > MAX_LOGIN_CODE_LENGTH || /[\r\n]/.test(trimmed)) {
        throw new Error("The sign-in code is not valid");
      }
      if (!child.stdin || child.stdin.destroyed) {
        throw new Error("The sign-in is no longer waiting for a code");
      }
      child.stdin.write(`${trimmed}\n`);
    },
    cancel,
  };
}

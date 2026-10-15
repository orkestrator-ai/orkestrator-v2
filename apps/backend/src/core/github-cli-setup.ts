import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { getHostGitHubToken } from "./commands-files.js";
import {
  beginAgentAccountLogin,
  ensureBrowserShim,
  type AgentAccountLoginHandle,
  type SpawnLike,
} from "./agent-accounts-login.js";
import { commandExists } from "./shell.js";

/**
 * Helps a user who has no working GitHub CLI: install it with Homebrew on
 * macOS, and sign it in with GitHub's device flow without leaving the app.
 *
 * Both act on the host's own `gh`, the one every GitHub feature already runs.
 * `gh` keeps the login wherever it always does (Keychain or `~/.config/gh`);
 * this module never sees the token.
 */

export const GITHUB_HOSTNAME = "github.com";

const INSTALL_TIMEOUT_MS = 10 * 60_000;
const MAX_INSTALL_OUTPUT_BYTES = 16 * 1024;
/** gh's device code is valid for 15 minutes. */
const LOGIN_TOTAL_TIMEOUT_MS = 16 * 60_000;

export interface GitHubCliStatus {
  installed: boolean;
  /** `gh` holds a login for github.com. Always false when it is not installed. */
  authenticated: boolean;
  /** One click can install `gh` here: macOS with Homebrew available. */
  canInstallWithHomebrew: boolean;
}

export type GitHubCliOperationState = "idle" | "pending" | "succeeded" | "failed";

export interface GitHubCliLoginProgress {
  state: GitHubCliOperationState;
  operationId?: string;
  url?: string;
  userCode?: string;
  error?: string;
}

export interface GitHubCliInstallProgress {
  state: GitHubCliOperationState;
  operationId?: string;
  error?: string;
}

/**
 * An agent-test profile isolates the host's GitHub configuration. Installing
 * software on the host or writing a host login would break that isolation.
 */
function assertHostSetupAllowed(context: CommandContext): void {
  if (context.runtimeFlavor === "agent-test") {
    throw new Error("GitHub CLI setup is not available in an isolated test profile.");
  }
}

export async function getGitHubCliStatus(
  context: CommandContext,
  options: { platform?: NodeJS.Platform } = {},
): Promise<GitHubCliStatus> {
  const installed = await commandExists("gh");
  const platform = options.platform ?? process.platform;
  return {
    installed,
    authenticated: installed && Boolean(await getHostGitHubToken()),
    canInstallWithHomebrew:
      !installed &&
      platform === "darwin" &&
      context.runtimeFlavor !== "agent-test" &&
      (await commandExists("brew")),
  };
}

// ---------------------------------------------------------------------------
// Sign-in

interface ActiveLogin {
  operationId: string;
  state: Exclude<GitHubCliOperationState, "idle">;
  handle?: AgentAccountLoginHandle;
  cancelled?: boolean;
  error?: string;
}

let activeLogin: ActiveLogin | undefined;

function loginProgress(): GitHubCliLoginProgress {
  const entry = activeLogin;
  if (!entry) return { state: "idle" };
  return {
    state: entry.state,
    operationId: entry.operationId,
    ...(entry.state === "pending" && entry.handle
      ? {
          url: entry.handle.url,
          ...(entry.handle.userCode ? { userCode: entry.handle.userCode } : {}),
        }
      : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export function gitHubCliLoginProgress(): GitHubCliLoginProgress {
  return loginProgress();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `gh auth login --web` without a terminal prints the one-time code and the
 * device URL, then exits once the user approves it. `GH_TOKEN` and
 * `GITHUB_TOKEN` would make gh refuse to store a login, and a token the backend
 * inherited is not the login the user is creating.
 */
export function gitHubCliLoginCommand(browserShimDirectory: string, env = process.env) {
  const loginEnv: NodeJS.ProcessEnv = { ...env, NO_COLOR: "1", GH_PROMPT_DISABLED: "1" };
  delete loginEnv.GH_TOKEN;
  delete loginEnv.GITHUB_TOKEN;
  const browser = path.join(browserShimDirectory, "open");
  loginEnv.PATH = [browserShimDirectory, loginEnv.PATH].filter(Boolean).join(path.delimiter);
  loginEnv.BROWSER = browser;
  loginEnv.GH_BROWSER = browser;
  return {
    command: "gh",
    args: ["auth", "login", "--web", "--hostname", GITHUB_HOSTNAME],
    env: loginEnv,
  };
}

export async function startGitHubCliLogin(
  context: CommandContext,
  options: { spawnImpl?: SpawnLike; shimDirectory?: string } = {},
): Promise<GitHubCliLoginProgress> {
  assertHostSetupAllowed(context);
  if (activeLogin?.state === "pending") return loginProgress();
  const entry: ActiveLogin = { operationId: randomUUID(), state: "pending" };
  activeLogin = entry;
  let handle: AgentAccountLoginHandle;
  try {
    const shim = await ensureBrowserShim(
      options.shimDirectory ?? path.join(context.storage.agentAccountsDirectory(), ".login-shim"),
    );
    handle = await beginAgentAccountLogin("github", gitHubCliLoginCommand(shim), {
      spawnImpl: options.spawnImpl,
      totalTimeoutMs: LOGIN_TOTAL_TIMEOUT_MS,
    });
  } catch (error) {
    entry.state = "failed";
    entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
    throw new Error(entry.error);
  }
  if (entry.cancelled) {
    handle.cancel();
    throw new Error("The sign-in was cancelled");
  }
  entry.handle = handle;
  void handle.completion.then(
    () => {
      entry.state = "succeeded";
    },
    (error: unknown) => {
      entry.state = "failed";
      entry.error = entry.cancelled ? "The sign-in was cancelled" : errorMessage(error);
    },
  );
  return loginProgress();
}

/** Cancel a pending sign-in, or dismiss a finished one. */
export function cancelGitHubCliLogin(operationId?: string): GitHubCliLoginProgress {
  const entry = activeLogin;
  if (operationId && entry?.operationId !== operationId) return loginProgress();
  activeLogin = undefined;
  if (entry?.state === "pending") {
    entry.cancelled = true;
    entry.handle?.cancel();
  }
  return loginProgress();
}

// ---------------------------------------------------------------------------
// Install

interface ActiveInstall {
  operationId: string;
  state: Exclude<GitHubCliOperationState, "idle">;
  error?: string;
}

let activeInstall: ActiveInstall | undefined;

function installProgress(): GitHubCliInstallProgress {
  const entry = activeInstall;
  if (!entry) return { state: "idle" };
  return {
    state: entry.state,
    operationId: entry.operationId,
    ...(entry.error ? { error: entry.error } : {}),
  };
}

export function gitHubCliInstallProgress(): GitHubCliInstallProgress {
  return installProgress();
}

/**
 * Run `brew install gh` in the background. Homebrew's bin directory is already
 * on the backend's PATH, so the new `gh` is usable as soon as this succeeds.
 */
export async function startGitHubCliInstall(
  context: CommandContext,
  options: {
    spawnImpl?: (
      command: string,
      args: string[],
      options: { env: NodeJS.ProcessEnv },
    ) => ChildProcess;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
  } = {},
): Promise<GitHubCliInstallProgress> {
  assertHostSetupAllowed(context);
  if (activeInstall?.state === "pending") return installProgress();
  const status = await getGitHubCliStatus(context, { platform: options.platform });
  if (status.installed) {
    activeInstall = { operationId: randomUUID(), state: "succeeded" };
    return installProgress();
  }
  if (!status.canInstallWithHomebrew) {
    throw new Error("The GitHub CLI can only be installed automatically on macOS with Homebrew.");
  }

  const entry: ActiveInstall = { operationId: randomUUID(), state: "pending" };
  activeInstall = entry;
  const spawnImpl =
    options.spawnImpl ??
    ((command: string, args: string[], spawnOptions: { env: NodeJS.ProcessEnv }) =>
      spawn(command, args, { env: spawnOptions.env, stdio: ["ignore", "pipe", "pipe"] }));
  const child = spawnImpl("brew", ["install", "gh"], {
    env: {
      ...process.env,
      NONINTERACTIVE: "1",
      HOMEBREW_NO_ENV_HINTS: "1",
      NO_COLOR: "1",
    },
  });

  let output = "";
  const onData = (chunk: Buffer | string): void => {
    output += chunk.toString();
    if (output.length > MAX_INSTALL_OUTPUT_BYTES) output = output.slice(-MAX_INSTALL_OUTPUT_BYTES);
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const fail = (message: string): void => {
    if (entry.state !== "pending") return;
    entry.state = "failed";
    const detail = output.trim().split("\n").slice(-3).join("\n");
    entry.error = detail ? `${message}\n${detail}` : message;
  };
  const timer = setTimeout(() => {
    fail("Homebrew did not finish installing the GitHub CLI in time.");
    child.kill("SIGTERM");
  }, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
  timer.unref?.();

  child.once("error", (error) => {
    clearTimeout(timer);
    fail(`Homebrew could not be started: ${error.message}`);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    if (entry.state !== "pending") return;
    if (code === 0) entry.state = "succeeded";
    else fail(`Homebrew could not install the GitHub CLI (exit code ${code ?? "unknown"}).`);
  });
  return installProgress();
}

/** Test seam: forget any operation without touching its process. */
export function resetGitHubCliSetupForTests(): void {
  activeLogin = undefined;
  activeInstall = undefined;
}

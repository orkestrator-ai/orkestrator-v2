import path from "node:path";

import type { CommandContext } from "./commands-context.js";
import { getHostGitHubToken } from "./github-credentials.js";
import {
  beginAgentAccountLogin,
  ensureBrowserShim,
  type SpawnLike,
} from "./agent-accounts-login.js";
import type { GitHubCliLoginProgress } from "./github-cli-login.js";
import { gitHubCli } from "./github-cli-binary.js";
import { checkHostTool } from "./host-tools.js";

/**
 * Signs the GitHub CLI in with GitHub's device flow without leaving the app.
 *
 * It drives the same `gh` every GitHub feature runs: the toolchain's pinned
 * copy, which Orkestrator installs with the agent CLIs, or one on PATH. `gh`
 * keeps the login wherever it always does (Keychain or `~/.config/gh`); this
 * module never sees the token.
 */

export const GITHUB_HOSTNAME = "github.com";

/** gh's device code is valid for 15 minutes. */
const LOGIN_TOTAL_TIMEOUT_MS = 16 * 60_000;

export interface GitHubCliStatus {
  installed: boolean;
  /** `gh` holds a login for github.com. Always false when it is not installed. */
  authenticated: boolean;
  /** This runtime may sign `gh` in. False in isolated test profiles. */
  canSignIn: boolean;
  /** The user turned off the startup reminder to set `gh` up. */
  reminderDismissed: boolean;
}

export type { GitHubCliLoginProgress, GitHubCliOperationState } from "./github-cli-login.js";

/**
 * An agent-test profile isolates the host's GitHub configuration, and writing
 * a host login would break that isolation.
 */
function assertSignInAllowed(context: CommandContext): void {
  if (context.runtimeFlavor === "agent-test") {
    throw new Error("GitHub sign-in is not available in an isolated test profile.");
  }
}

export async function getGitHubCliStatus(context: CommandContext): Promise<GitHubCliStatus> {
  const installed = await checkHostTool(context, "gh");
  const [authenticated, config] = await Promise.all([
    installed ? getHostGitHubToken().then(Boolean) : false,
    context.storage.loadConfig(),
  ]);
  return {
    installed,
    authenticated,
    canSignIn: installed && context.runtimeFlavor !== "agent-test",
    reminderDismissed: config.global.githubCliReminderDismissed === true,
  };
}

// ---------------------------------------------------------------------------
// Sign-in

export function gitHubCliLoginProgress(context: CommandContext): GitHubCliLoginProgress {
  return context.runtime.localServers.gitHubCliLogin.progress();
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
    command: gitHubCli(),
    args: ["auth", "login", "--web", "--hostname", GITHUB_HOSTNAME],
    env: loginEnv,
  };
}

export async function startGitHubCliLogin(
  context: CommandContext,
  options: { spawnImpl?: SpawnLike; shimDirectory?: string } = {},
): Promise<GitHubCliLoginProgress> {
  assertSignInAllowed(context);
  return context.runtime.localServers.gitHubCliLogin.start(async () => {
    const shim = await ensureBrowserShim(
      options.shimDirectory ??
        path.join(context.storage.agentAccounts.agentAccountsDirectory(), ".login-shim"),
    );
    return beginAgentAccountLogin("github", gitHubCliLoginCommand(shim), {
      spawnImpl: options.spawnImpl,
      totalTimeoutMs: LOGIN_TOTAL_TIMEOUT_MS,
    });
  });
}

/** Cancel a pending sign-in, or dismiss a finished one. */
export function cancelGitHubCliLogin(
  context: CommandContext,
  operationId?: string,
): GitHubCliLoginProgress {
  return context.runtime.localServers.gitHubCliLogin.cancel(operationId);
}

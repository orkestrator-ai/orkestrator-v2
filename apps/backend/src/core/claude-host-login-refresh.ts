import { promises as fs } from "node:fs";
import path from "node:path";

import { CLAUDE_PINNED_RUNTIME_ENV } from "@orkestrator/protocol/terminal-agent-launch";

import type { CommandContext } from "./commands-context.js";
import { resolveClaudeBinary } from "./commands-agent-support.js";
import {
  stripInheritedAgentCredentials,
  type ResolvedAgentAccount,
} from "./agent-accounts-active.js";
import { CommandFailedError, runCommand } from "./shell.js";

/**
 * Have the host's own Claude Code refresh one account's login.
 *
 * Claude Code has no refresh-only command, so this sends one request it
 * cannot serve: a model name no catalogue knows. The CLI refreshes a login in
 * its last five minutes before any API request, through its own code: a lock
 * on the config directory, a re-read that adopts a token another process
 * already saved, and a compare-and-swap save. The request then fails before
 * any inference, so it costs no usage. Checked against Claude Code 2.1.296 in
 * a container with a fake login; see container-network-and-credential-isolation.md.
 *
 * Settings, hooks, MCP servers, tools and session persistence are all off, so
 * nothing of the user's runs and no transcript is written. The CLI does create
 * an empty project directory for its working directory, which is a private
 * directory under the data dir.
 *
 * The caller judges success by reading the login again; this never throws for
 * the expected failing exit.
 */
export const CLAUDE_HOST_REFRESH_MODEL = "orkestrator-login-refresh";

export async function refreshHostClaudeLogin(
  context: CommandContext,
  account: ResolvedAgentAccount,
  run: typeof runCommand = runCommand,
): Promise<void> {
  if (context.runtimeFlavor === "agent-test") {
    throw new Error("An agent-test profile never refreshes the host's Claude login");
  }
  const cwd = path.join(context.storage.getDataDir(), "claude-login-refresh");
  await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
  const binary = resolveClaudeBinary(context);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(binary !== "claude" ? CLAUDE_PINNED_RUNTIME_ENV : {}),
  };
  // A bearer token or key in the backend's environment would outrank the
  // login and leave it unrefreshed.
  stripInheritedAgentCredentials(env);
  if (account.home) env.CLAUDE_CONFIG_DIR = account.home;
  await run(
    binary,
    [
      "-p",
      "ok",
      "--model",
      CLAUDE_HOST_REFRESH_MODEL,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--tools",
      "",
      "--no-session-persistence",
    ],
    { cwd, env, timeoutMs: 60_000 },
  ).catch((error: unknown) => {
    // The deliberately unknown model normally exits 1. Infrastructure failures
    // must reach the keeper, which warns once per refresh backoff window.
    if (
      error instanceof CommandFailedError &&
      !error.timedOut &&
      !error.executableMissing &&
      error.exitCode === 1 &&
      !error.signal
    )
      return;
    const reason =
      error instanceof CommandFailedError
        ? error.timedOut
          ? "timeout"
          : error.executableMissing
            ? "executable missing"
            : "command failed"
        : "command failed";
    throw new Error(`Host Claude refresh ${reason}`);
  });
}

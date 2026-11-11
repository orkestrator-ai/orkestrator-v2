/**
 * The command `refreshHostClaudeLogin` runs, kept free of imports so that
 * `scripts/claude-host-refresh-trigger-probe.ts` runs exactly the same
 * arguments against a pinned Claude Code with a fake login.
 */

/** A model name no catalogue knows: the API refuses it before any inference. */
export const CLAUDE_HOST_REFRESH_MODEL = "orkestrator-login-refresh";

/**
 * Settings, hooks, MCP servers, tools and session persistence are all off, so
 * nothing of the user's runs and no transcript is written.
 */
export const CLAUDE_HOST_REFRESH_ARGS: readonly string[] = Object.freeze([
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
]);

/** How long the host refresh may run before it is reported as a timeout. */
export const CLAUDE_HOST_REFRESH_TIMEOUT_MS = 60_000;

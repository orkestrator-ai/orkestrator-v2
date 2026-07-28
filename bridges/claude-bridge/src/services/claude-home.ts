// Where the user's Claude configuration lives.
//
// Both the MCP and the plugin resolvers need `~/.claude.json` and
// `~/.claude/plugins/`, and each used to compute those paths itself. Owning
// the layout in one place keeps them from drifting, and gives the resolvers a
// single seam a test can point somewhere harmless — these files belong to the
// developer running the suite, and no test may read or write the real ones.

import { homedir } from "node:os";
import { join } from "node:path";

let overrideHome: string | null = null;

/**
 * Root of the user's Claude configuration.
 *
 * Resolved per call rather than at module load: `os.homedir()` is cheap, and
 * these resolvers run at most a handful of times per prompt.
 */
export function claudeHome(): string {
  return overrideHome ?? homedir();
}

/** Global Claude config: MCP servers, plugins, and per-project overrides. */
export function claudeJsonPath(): string {
  return join(claudeHome(), ".claude.json");
}

/** Directory the Claude CLI installs marketplace plugins into. */
export function claudePluginsDir(): string {
  return join(claudeHome(), ".claude", "plugins");
}

/**
 * Bridge-owned directory for per-session preference files.
 *
 * Lives under `~/.claude` because that is the only durable location the bridge
 * already depends on in both container and local modes; the bridge process
 * itself dies with the backend, so anything that must survive an app restart
 * cannot live in bridge memory. Namespaced under `orkestrator/` so nothing here
 * can be mistaken for (or collide with) files the Claude CLI owns.
 */
export function claudeSessionPreferencesDir(): string {
  return join(claudeHome(), ".claude", "orkestrator", "session-preferences");
}

/**
 * Point every resolver at a different home directory.
 *
 * Exported for tests. Mocking `node:os` instead would be visible to every
 * other suite sharing the module registry — including the codex bridge, which
 * resolves its own home through it.
 */
export function setClaudeHomeForTesting(home: string | null): void {
  overrideHome = home;
}

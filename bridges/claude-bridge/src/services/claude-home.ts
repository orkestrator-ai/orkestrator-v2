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

/**
 * User settings as the CLI reads them: `$CLAUDE_CONFIG_DIR/settings.json`,
 * else `~/.claude/settings.json`. The CLI inherits this process's environment
 * (`runtimeEnvironmentForAgentQuery`), so this is the file it reads. A test
 * home ignores the environment, so no test reads the developer's settings.
 */
export function claudeUserSettingsPath(): string {
  const configDir = overrideHome === null ? process.env.CLAUDE_CONFIG_DIR?.trim() : undefined;
  return join(configDir || join(claudeHome(), ".claude"), "settings.json");
}

/** Directory the Claude CLI installs marketplace plugins into. */
export function claudePluginsDir(): string {
  return join(claudeHome(), ".claude", "plugins");
}

/** Bridge-owned files that are not per session (see `claude-terminal-commands.ts`). */
export function claudeOrkestratorDir(): string {
  return join(claudeHome(), ".claude", "orkestrator");
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
 * Bridge-owned directory for the per-session journals of what each shell
 * command changed (see `command-changes.ts`). Beside the preference files for
 * the same reason they live here.
 */
export function claudeCommandChangesDir(): string {
  return join(claudeHome(), ".claude", "orkestrator", "command-changes");
}

/**
 * Bridge-owned directory for unacknowledged change evidence (see
 * `change-evidence.ts`), beside the command-change journals. Each bridge
 * instance keeps its spool in a subdirectory of its own.
 */
export function claudeChangeEvidenceDir(): string {
  return join(claudeHome(), ".claude", "orkestrator", "change-evidence");
}

/**
 * Bridge-owned directory for the plugins that carry a coordinator's mirrored
 * skills (see `coordinator-skills.ts`). Inside the CLI's own config directory,
 * which for a coordinator is private to its conversation, so two conversations
 * never share or prune each other's mirrors. A test home ignores the
 * environment, as `claudeUserSettingsPath` does.
 */
export function claudeCoordinatorSkillPluginsDir(): string {
  const configDir = overrideHome === null ? process.env.CLAUDE_CONFIG_DIR?.trim() : undefined;
  return join(configDir || join(claudeHome(), ".claude"), "orkestrator", "coordinator-skills");
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

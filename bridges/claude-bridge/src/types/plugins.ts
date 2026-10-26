/**
 * Plugin configuration types.
 * These match the format used in ~/.claude.json and project plugin configs.
 */

/**
 * Plugin configuration entry
 */
export interface PluginConfig {
  type: "local";
  path: string;
  /** The `installed_plugins.json` id an install is recorded under. */
  installedId?: string;
}

/**
 * Structure of ~/.claude.json file (plugin-related fields)
 */
export interface ClaudeJsonPluginsConfig {
  plugins?: PluginConfig[];
  projects?: Record<
    string,
    {
      plugins?: PluginConfig[];
    }
  >;
}

/**
 * Structure of ~/.claude/plugins/installed_plugins.json
 * This is the registry of all CLI/marketplace-installed plugins.
 */
export interface InstalledPluginsFile {
  version: number;
  plugins: Record<
    string,
    Array<{
      scope: string;
      installPath: string;
      version: string;
      installedAt: string;
      lastUpdated: string;
      gitCommitSha: string;
    }>
  >;
}

/**
 * Plugin info for frontend display
 */
export interface PluginInfo {
  name: string;
  path: string;
  description?: string;
  source: "global" | "project" | "cli";
  enabled: boolean;
}

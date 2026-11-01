/**
 * Plugin Configuration Service
 *
 * Loads plugin configurations from:
 * 1. ~/.claude.json (global configuration)
 * 2. <project>/.claude/plugins.json (project-specific configuration)
 * 3. ~/.claude/plugins/ (CLI-installed plugins), only those Claude Code's own
 *    `enabledPlugins` settings enable for the session's settings sources
 *
 * Project-specific configs override global configs for plugins with the same name.
 */

import { readdir, access } from "node:fs/promises";
import { join } from "node:path";
import {
  claudePluginConfigList,
  claudePluginSettingSources,
  enabledInstalledPlugins,
  mergeClaudePluginLayers,
  remapInstalledPlugins as remapInstalledPluginPaths,
  resolveClaudePluginPath,
  type ClaudePluginSettingSource,
} from "@orkestrator/protocol/node/claude-plugin-set";
import type {
  PluginInfo,
  PluginConfig,
  ClaudeJsonPluginsConfig,
  InstalledPluginsFile,
} from "../types/plugins.js";
import {
  claudeHome,
  claudeJsonPath,
  claudePluginsDir,
  claudeUserSettingsPath,
} from "./claude-home.js";
import { readJsonSliceCached } from "./json-file-cache.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

/**
 * SDK plugin config type - matching the SDK's expected format
 */
export interface SdkPluginConfig {
  type: "local";
  path: string;
}

/**
 * Check if a path exists
 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fallback scan of ~/.claude/plugins/ for installations that don't have
 * installed_plugins.json available.
 */
async function scanCliPluginsDirectory(pluginsDir: string): Promise<PluginConfig[]> {
  if (!(await pathExists(pluginsDir))) {
    return [];
  }

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const plugins: PluginConfig[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pluginPath = join(pluginsDir, entry.name);
      const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");

      if (await pathExists(manifestPath)) {
        plugins.push({
          type: "local",
          path: pluginPath,
        });
      }
    }

    return plugins;
  } catch {
    return [];
  }
}

/**
 * Load global plugin configurations from ~/.claude.json
 *
 * Reads through a stat-validated slice cache so only the `plugins` array is
 * retained, not the project history that dominates this file.
 */
export async function loadGlobalPlugins(): Promise<PluginConfig[]> {
  const plugins = await readJsonSliceCached<ClaudeJsonPluginsConfig, PluginConfig[]>(
    claudeJsonPath(),
    "plugins",
    (config) => claudePluginConfigList(config?.plugins),
  );

  return plugins ?? [];
}

/**
 * Load project-specific plugin configurations from <cwd>/.claude/plugins.json
 */
export async function loadProjectPlugins(cwd: string): Promise<PluginConfig[]> {
  const plugins = await readJsonSliceCached<{ plugins?: PluginConfig[] }, PluginConfig[]>(
    join(cwd, ".claude", "plugins.json"),
    "plugins",
    (config) => claudePluginConfigList(config?.plugins),
  );

  return plugins ?? [];
}

/**
 * Load CLI/marketplace-installed plugins from ~/.claude/plugins/installed_plugins.json
 *
 * The install paths in this file may contain host-specific absolute paths
 * (e.g. /Users/username/.claude/plugins/...) which won't exist inside a container.
 * We detect the common `.claude/plugins/` segment and remap to the local home directory.
 */
export async function loadCliInstalledPlugins(): Promise<PluginConfig[]> {
  const pluginsDir = claudePluginsDir();
  const installedPluginsPath = join(pluginsDir, "installed_plugins.json");

  const plugins = await readJsonSliceCached<InstalledPluginsFile, InstalledPluginsFile["plugins"]>(
    installedPluginsPath,
    "plugins",
    (config) => config?.plugins,
  );

  if (!plugins) {
    return scanCliPluginsDirectory(pluginsDir);
  }

  return remapInstalledPlugins(pluginsDir, { plugins });
}

/** Where the CLI reads each settings layer that can carry `enabledPlugins`. */
function pluginSettingsPath(source: ClaudePluginSettingSource, cwd: string): string {
  switch (source) {
    case "user":
      return claudeUserSettingsPath();
    case "project":
      return join(cwd, ".claude", "settings.json");
    case "local":
      return join(cwd, ".claude", "settings.local.json");
  }
}

/**
 * The `enabledPlugins` of each settings layer a session loads, as the CLI
 * reads them. A missing or malformed file names nothing.
 */
export async function loadPluginSettings(
  cwd: string,
  sources: readonly ClaudePluginSettingSource[],
): Promise<Partial<Record<ClaudePluginSettingSource, unknown>>> {
  const entries = await Promise.all(
    sources.map(async (source) => {
      const enabledPlugins = await readJsonSliceCached<{ enabledPlugins?: unknown }, unknown>(
        pluginSettingsPath(source, cwd),
        "enabledPlugins",
        (config) => config?.enabledPlugins ?? null,
      );
      return [source, enabledPlugins === null ? undefined : { enabledPlugins }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Remap the install paths recorded in installed_plugins.json onto the local
 * plugins directory.
 *
 * The recorded paths are host-absolute (e.g. /Users/alice/.claude/plugins/...),
 * which won't exist inside a container. We detect the common `.claude/plugins/`
 * segment and rebase the remainder onto `pluginsDir`. Entries whose rebased
 * path escapes `pluginsDir` (path traversal) are dropped.
 */
export function remapInstalledPlugins(
  pluginsDir: string,
  // Only the `plugins` record is used, and that is all the slice cache
  // retains — the file's own `version` field is not needed here.
  installedPlugins: Pick<InstalledPluginsFile, "plugins">,
): PluginConfig[] {
  return remapInstalledPluginPaths(pluginsDir, installedPlugins, (installPath) =>
    log.warn("plugin.unsafe-path", { path: installPath }),
  );
}

/**
 * Also check for project-specific plugin overrides in ~/.claude.json projects section
 */
export async function loadProjectOverridesFromGlobal(cwd: string): Promise<PluginConfig[]> {
  // The slice key carries `cwd` because the selector closes over it — two
  // projects must not serve each other's overrides from the same entry.
  const plugins = await readJsonSliceCached<ClaudeJsonPluginsConfig, PluginConfig[]>(
    claudeJsonPath(),
    `projects:${cwd}:plugins`,
    (config) => claudePluginConfigList(config?.projects?.[cwd]?.plugins),
  );

  return plugins ?? [];
}

/**
 * Read plugin manifest to get name and metadata
 */
export async function readPluginManifest(
  pluginPath: string,
): Promise<{ name: string; description?: string } | null> {
  const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
  const manifest = await readJsonSliceCached<
    { name?: string; description?: string },
    { name?: string; description?: string }
  >(manifestPath, "manifest", (config) =>
    config ? { name: config.name, description: config.description } : null,
  );

  if (!manifest) {
    return null;
  }

  // Default name to directory name if not specified
  const name = manifest.name || pluginPath.split("/").pop() || "unknown";

  return {
    name,
    description: manifest.description,
  };
}

/** Resolve a plugin path (handles relative paths and ~). */
function resolvePath(pluginPath: string, cwd: string): string {
  return resolveClaudePluginPath(pluginPath, cwd, claudeHome());
}

/** The settings sources a session loads when it loads project resources, and when it does not. */
function defaultSettingSources(includeProjectSources: boolean): string[] {
  return includeProjectSources ? ["user", "project"] : ["user"];
}

/**
 * Get merged plugins for a project.
 * Priority (highest to lowest):
 * 1. Project .claude/plugins.json
 * 2. Project entry in ~/.claude.json
 * 3. CLI-installed plugins (~/.claude/plugins/) that Claude Code enables
 * 4. Global plugins in ~/.claude.json
 *
 * `settingSources` are the session's (the SDK option): an install is passed
 * only when the first of those layers whose `enabledPlugins` names its exact
 * `<name>@<marketplace>` id sets it to `true`, the CLI's rule for its own
 * installs. Every plugin passed here gets the id `<name>@inline`, where the
 * marketplace id Claude Code's `/plugin` toggles never applies, so an install
 * passed regardless would load after the user turned it off.
 *
 * Deduplicates by resolved path. The merge itself is shared with the
 * backend's MCP editor (`@orkestrator/protocol/node/claude-plugin-set`), so
 * the editor lists exactly the plugins a session loads.
 */
export async function getMergedPlugins(
  cwd: string,
  includeProjectSources = true,
  settingSources: readonly string[] = defaultSettingSources(includeProjectSources),
): Promise<PluginConfig[]> {
  const sources = claudePluginSettingSources(settingSources);
  const [global, cliInstalled, projectGlobal, projectLocal, settings] = await Promise.all([
    loadGlobalPlugins(),
    loadCliInstalledPlugins(),
    includeProjectSources ? loadProjectOverridesFromGlobal(cwd) : [],
    includeProjectSources ? loadProjectPlugins(cwd) : [],
    loadPluginSettings(cwd, sources),
  ]);
  return mergeClaudePluginLayers(
    {
      global,
      cliInstalled: enabledInstalledPlugins(cliInstalled, settings, sources),
      projectGlobal,
      projectLocal,
    },
    { cwd, home: claudeHome(), includeProjectSources },
  ).map((path) => ({ type: "local", path }));
}

/**
 * Convert merged configs to SDK-compatible plugin config array
 */
export async function getPluginsForSdk(
  cwd: string,
  includeProjectSources = true,
  settingSources: readonly string[] = defaultSettingSources(includeProjectSources),
): Promise<SdkPluginConfig[]> {
  const configs = await getMergedPlugins(cwd, includeProjectSources, settingSources);

  // Filter to only include plugins that exist
  const validPlugins: SdkPluginConfig[] = [];

  for (const config of configs) {
    if (await pathExists(config.path)) {
      validPlugins.push({
        type: "local",
        path: config.path,
      });
    } else {
      const pluginName = config.path.split("/").pop() || "unknown";
      log.warn("plugin.path-missing", { pluginName, path: config.path });
    }
  }

  return validPlugins;
}

/**
 * Get plugin info for frontend display
 */
export async function getPluginInfo(cwd: string): Promise<PluginInfo[]> {
  // Load all config sources in parallel
  const [global, cliInstalled, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalPlugins(),
    loadCliInstalledPlugins(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectPlugins(cwd),
  ]);

  // Track which paths came from which source
  const globalPaths = new Set(global.map((p) => resolvePath(p.path, cwd)));
  const cliPaths = new Set(cliInstalled.map((p) => resolvePath(p.path, cwd)));
  const projectGlobalPaths = new Set(projectGlobal.map((p) => resolvePath(p.path, cwd)));
  const projectLocalPaths = new Set(projectLocal.map((p) => resolvePath(p.path, cwd)));

  // Get merged plugins
  const merged = await getMergedPlugins(cwd);
  const result: PluginInfo[] = [];

  for (const config of merged) {
    const manifest = await readPluginManifest(config.path);
    const exists = await pathExists(config.path);

    // Determine source (highest priority that has this path)
    let source: "global" | "project" | "cli" = "global";
    if (projectLocalPaths.has(config.path) || projectGlobalPaths.has(config.path)) {
      source = "project";
    } else if (cliPaths.has(config.path)) {
      source = "cli";
    } else if (globalPaths.has(config.path)) {
      source = "global";
    }

    result.push({
      name: manifest?.name || config.path.split("/").pop() || "unknown",
      path: config.path,
      description: manifest?.description,
      source,
      enabled: exists,
    });
  }

  return result;
}

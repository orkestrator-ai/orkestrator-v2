/**
 * Plugin Configuration Service
 *
 * Loads plugin configurations from:
 * 1. ~/.claude.json (global configuration)
 * 2. <project>/.claude/plugins.json (project-specific configuration)
 * 3. ~/.claude/plugins/ (CLI-installed plugins)
 *
 * Project-specific configs override global configs for plugins with the same name.
 */

import { readdir, access } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import type {
  PluginInfo,
  PluginConfig,
  ClaudeJsonPluginsConfig,
  InstalledPluginsFile,
} from "../types/plugins.js";
import { claudeHome, claudeJsonPath, claudePluginsDir } from "./claude-home.js";
import { readJsonSliceCached } from "./json-file-cache.js";

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
 * Check whether a candidate path is contained within a parent directory.
 */
function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relativePath = relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
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
    (config) => config?.plugins,
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
    (config) => config?.plugins,
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
  const plugins: PluginConfig[] = [];
  const CLAUDE_PLUGINS_MARKER = "/.claude/plugins/";
  const pluginsRoot = resolve(pluginsDir);

  for (const entries of Object.values(installedPlugins.plugins)) {
    for (const entry of entries) {
      // Remap host-absolute paths to container-local paths
      // e.g. /Users/arkaydeus/.claude/plugins/marketplaces/... → /home/node/.claude/plugins/marketplaces/...
      const markerIdx = entry.installPath.indexOf(CLAUDE_PLUGINS_MARKER);
      let resolvedPath: string;

      if (markerIdx !== -1) {
        const relativePath = entry.installPath.substring(markerIdx + CLAUDE_PLUGINS_MARKER.length);
        const remappedPath = resolve(pluginsDir, relativePath);
        if (!isPathWithin(pluginsRoot, remappedPath)) {
          console.warn(
            `[plugin-config] Skipping plugin with unsafe install path: "${entry.installPath}"`,
          );
          continue;
        }
        resolvedPath = remappedPath;
      } else {
        resolvedPath = entry.installPath;
      }

      plugins.push({
        type: "local",
        path: resolvedPath,
      });
    }
  }

  return plugins;
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
    (config) => config?.projects?.[cwd]?.plugins,
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

/**
 * Resolve a plugin path (handles relative paths and ~)
 */
function resolvePath(pluginPath: string, cwd: string): string {
  if (pluginPath.startsWith("~")) {
    return join(claudeHome(), pluginPath.slice(1));
  }
  if (pluginPath.startsWith("/")) {
    return pluginPath;
  }
  return join(cwd, pluginPath);
}

/**
 * Get merged plugins for a project.
 * Priority (highest to lowest):
 * 1. Project .claude/plugins.json
 * 2. Project entry in ~/.claude.json
 * 3. CLI-installed plugins (~/.claude/plugins/)
 * 4. Global plugins in ~/.claude.json
 *
 * Deduplicates by resolved path
 */
export async function getMergedPlugins(cwd: string): Promise<PluginConfig[]> {
  const [global, cliInstalled, projectGlobal, projectLocal] = await Promise.all([
    loadGlobalPlugins(),
    loadCliInstalledPlugins(),
    loadProjectOverridesFromGlobal(cwd),
    loadProjectPlugins(cwd),
  ]);

  // Merge with priority: projectLocal > projectGlobal > cliInstalled > global
  // Use a Map to deduplicate by resolved path
  const pluginMap = new Map<string, PluginConfig>();

  // Add in reverse priority order so higher priority overwrites
  for (const plugin of global) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of cliInstalled) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of projectGlobal) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  for (const plugin of projectLocal) {
    const resolved = resolvePath(plugin.path, cwd);
    pluginMap.set(resolved, { ...plugin, path: resolved });
  }

  return Array.from(pluginMap.values());
}

/**
 * Convert merged configs to SDK-compatible plugin config array
 */
export async function getPluginsForSdk(cwd: string): Promise<SdkPluginConfig[]> {
  const configs = await getMergedPlugins(cwd);

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
      console.warn(
        `[plugin-config] Skipping plugin "${pluginName}" - path does not exist: "${config.path}"`,
      );
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

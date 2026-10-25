/**
 * The Claude plugin set Orkestrator passes to the Claude CLI, and the CLI's
 * rule for whether it loads each one.
 *
 * The Claude bridge (`bridges/claude-bridge/src/services/plugin-config.ts`)
 * and the backend's MCP editor (`apps/backend/src/core/mcp-management/
 * claude-plugins.ts`) both build the set here, each with its own bounded
 * reads, so the editor can never list a different set from the one a session
 * loads. Nothing here touches the filesystem.
 *
 * The enablement and MCP rules mirror the pinned Claude CLI (2.1.309, read
 * from the binary on 2026-10-25). Every plugin the bridge passes in the SDK's
 * `plugins` option joins the session as a `--plugin-dir` plugin, whose id is
 * `<name>@inline`; see docs/architecture/mcp-management.md.
 */

import path from "node:path";

/** One plugin entry in `~/.claude.json` or `.claude/plugins.json`. */
export interface ClaudePluginConfig {
  type: "local";
  path: string;
}

/** The plugin layers the bridge reads, each as the file holds it. */
export interface ClaudePluginLayers {
  /** `plugins` in `~/.claude.json`. */
  global: unknown;
  /** `projects[<cwd>].plugins` in `~/.claude.json`. */
  projectGlobal: unknown;
  /** `plugins` in `<cwd>/.claude/plugins.json`. */
  projectLocal: unknown;
  /**
   * CLI-installed plugins: from `installed_plugins.json` (see
   * {@link remapInstalledPlugins}), or the plugins folder scan when that file
   * is missing or unreadable.
   */
  cliInstalled: ClaudePluginConfig[];
}

const CLAUDE_PLUGINS_MARKER = "/.claude/plugins/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The usable entries of a `plugins` list: objects with a string `path`. */
export function claudePluginConfigList(value: unknown): ClaudePluginConfig[] {
  if (!Array.isArray(value)) return [];
  const plugins: ClaudePluginConfig[] = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.path === "string" && item.path) {
      plugins.push({ type: "local", path: item.path });
    }
  }
  return plugins;
}

function isPathWithin(parentDir: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentDir, candidatePath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

/**
 * Rebase the install paths recorded in `installed_plugins.json` onto the local
 * plugins folder.
 *
 * The recorded paths are host-absolute (e.g. `/Users/alice/.claude/plugins/…`),
 * which do not exist inside a container. The common `.claude/plugins/`
 * segment is detected and the remainder rebased onto `pluginsDir`. Entries
 * whose rebased path escapes `pluginsDir` are dropped and reported through
 * `onUnsafe`.
 */
export function remapInstalledPlugins(
  pluginsDir: string,
  installedPlugins: { plugins?: unknown },
  onUnsafe?: (installPath: string) => void,
): ClaudePluginConfig[] {
  const plugins: ClaudePluginConfig[] = [];
  const pluginsRoot = path.resolve(pluginsDir);
  if (!isRecord(installedPlugins.plugins)) return plugins;
  for (const entries of Object.values(installedPlugins.plugins)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
      const installPath = entry.installPath;
      const markerIdx = installPath.indexOf(CLAUDE_PLUGINS_MARKER);
      let resolvedPath: string;
      if (markerIdx !== -1) {
        const relativePath = installPath.substring(markerIdx + CLAUDE_PLUGINS_MARKER.length);
        const remappedPath = path.resolve(pluginsDir, relativePath);
        if (!isPathWithin(pluginsRoot, remappedPath)) {
          onUnsafe?.(installPath);
          continue;
        }
        resolvedPath = remappedPath;
      } else {
        resolvedPath = installPath;
      }
      plugins.push({ type: "local", path: resolvedPath });
    }
  }
  return plugins;
}

/** Resolve a configured plugin path: `~` is the Claude home, a relative path is under `cwd`. */
export function resolveClaudePluginPath(pluginPath: string, cwd: string, home: string): string {
  if (pluginPath.startsWith("~")) return path.join(home, pluginPath.slice(1));
  if (pluginPath.startsWith("/")) return pluginPath;
  return path.join(cwd, pluginPath);
}

/**
 * The plugin directories the bridge passes, in the order it passes them,
 * before the existence check.
 *
 * Layers merge global < CLI-installed < project entry in `~/.claude.json` <
 * project `.claude/plugins.json`, de-duplicated by resolved path; a path keeps
 * the position where it first appeared. Without project resources only the
 * global and CLI-installed layers count.
 */
export function mergeClaudePluginLayers(
  layers: ClaudePluginLayers,
  options: { cwd: string; home: string; includeProjectSources: boolean },
): string[] {
  const ordered = [
    claudePluginConfigList(layers.global),
    layers.cliInstalled,
    ...(options.includeProjectSources
      ? [claudePluginConfigList(layers.projectGlobal), claudePluginConfigList(layers.projectLocal)]
      : []),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const layer of ordered) {
    for (const plugin of layer) {
      const resolved = resolveClaudePluginPath(plugin.path, options.cwd, options.home);
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      paths.push(resolved);
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// The pinned CLI's rules for a `--plugin-dir` plugin
// ---------------------------------------------------------------------------

/** Marketplace id the CLI gives every plugin passed in the SDK's `plugins` option. */
export const CLAUDE_INLINE_PLUGIN_MARKETPLACE = "inline";

/** Characters the CLI refuses in a plugin name, invisible and control characters included. */
const INVALID_PLUGIN_NAME = new RegExp(
  "[@:\\s/\\\\\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2064\\ufeff]",
);

/**
 * The plugin's name as the CLI derives it: the manifest's `name`, else the
 * directory name. `null` when the CLI refuses the name (empty, or containing
 * `@`, `:`, whitespace, a path separator or a control character), in which
 * case it does not load the plugin at all.
 */
export function claudePluginName(manifest: unknown, pluginDir: string): string | null {
  const declared = isRecord(manifest) ? manifest.name : undefined;
  const name =
    typeof declared === "string" && declared
      ? declared
      : path.basename(pluginDir.replace(/\/+$/, ""));
  if (!name || INVALID_PLUGIN_NAME.test(name)) return null;
  return name;
}

/** The name the CLI gives one MCP server of a plugin. */
export function claudePluginServerName(pluginName: string, serverName: string): string {
  return `plugin:${pluginName}:${serverName}`;
}

/** Settings files that can carry `enabledPlugins`, highest priority first. */
export const CLAUDE_PLUGIN_SETTING_SOURCES = ["local", "project", "user"] as const;
export type ClaudePluginSettingSource = (typeof CLAUDE_PLUGIN_SETTING_SOURCES)[number];

export interface ClaudePluginEnablement {
  enabled: boolean;
  /** The settings layer and key that decided, when one did. */
  decidedBy?: { source: ClaudePluginSettingSource; key: string };
  /** Disabled by the manifest's `defaultEnabled: false` and no setting enables it. */
  defaultDisabled?: boolean;
}

/**
 * Whether the CLI loads a `--plugin-dir` plugin, mirroring the pinned CLI:
 *
 * - The plugin's id is `<name>@inline`. The first loaded settings layer (local,
 *   then project, then user) whose `enabledPlugins` has that id, compared
 *   without case, decides; within one layer a `false` under any spelling wins.
 * - For an `@inline` id every value except `false` counts as enabled.
 * - With no entry, the manifest's `defaultEnabled` decides; absent means on.
 * - An id under another marketplace (`<name>@<marketplace>`) never applies to
 *   the plugin the bridge passes, even when it names the same plugin.
 *
 * Managed (policy) settings are read by the CLI before every layer here and
 * are not modelled.
 */
export function claudeInlinePluginEnablement(
  pluginName: string,
  manifest: unknown,
  settings: Partial<Record<ClaudePluginSettingSource, unknown>>,
  loadedSources: readonly ClaudePluginSettingSource[],
): ClaudePluginEnablement {
  const id = `${pluginName}@${CLAUDE_INLINE_PLUGIN_MARKETPLACE}`.toLowerCase();
  for (const source of CLAUDE_PLUGIN_SETTING_SOURCES) {
    if (!loadedSources.includes(source)) continue;
    const document = settings[source];
    const enabledPlugins = isRecord(document) ? document.enabledPlugins : undefined;
    if (!isRecord(enabledPlugins)) continue;
    let found: { key: string; enabled: boolean } | undefined;
    for (const [key, value] of Object.entries(enabledPlugins)) {
      if (value === undefined || key.toLowerCase() !== id) continue;
      const enabled = value !== false;
      if (!found || found.enabled) found = { key, enabled: enabled && (found?.enabled ?? true) };
    }
    if (found) return { enabled: found.enabled, decidedBy: { source, key: found.key } };
  }
  const defaultEnabled = isRecord(manifest) ? manifest.defaultEnabled : undefined;
  return defaultEnabled === false ? { enabled: false, defaultDisabled: true } : { enabled: true };
}

/**
 * Claude Code's own installed copy of a plugin, which the CLI loads from its
 * plugin settings independently of the copy the bridge passes.
 *
 * The CLI loads an installed plugin `<name>@<marketplace>` when the first
 * loaded settings layer whose `enabledPlugins` names that exact id sets it to
 * `true`. When the bridge's `@inline` copy is enabled it replaces that copy
 * (same name, same server names); when the `@inline` copy is turned off, the
 * installed copy still loads. `installedIds` are the keys of
 * `installed_plugins.json`.
 */
export function claudeInstalledPluginEnablement(
  pluginName: string,
  installedIds: readonly string[],
  settings: Partial<Record<ClaudePluginSettingSource, unknown>>,
  loadedSources: readonly ClaudePluginSettingSource[],
): { id: string; source: ClaudePluginSettingSource } | undefined {
  for (const id of installedIds) {
    const at = id.lastIndexOf("@");
    if (at <= 0 || id.slice(0, at) !== pluginName) continue;
    if (id.slice(at + 1).toLowerCase() === CLAUDE_INLINE_PLUGIN_MARKETPLACE) continue;
    for (const source of CLAUDE_PLUGIN_SETTING_SOURCES) {
      if (!loadedSources.includes(source)) continue;
      const document = settings[source];
      const enabledPlugins = isRecord(document) ? document.enabledPlugins : undefined;
      if (!isRecord(enabledPlugins) || !Object.hasOwn(enabledPlugins, id)) continue;
      if (enabledPlugins[id] === true) return { id, source };
      break;
    }
  }
  return undefined;
}

/**
 * Where a plugin declares MCP servers, in the order the CLI merges them (a
 * later same-name server replaces an earlier one): the plugin's `.mcp.json`,
 * then the manifest's `mcpServers` — an inline map, a path to a JSON file, an
 * MCPB bundle, or a list of any of those.
 */
export type ClaudePluginMcpDeclaration =
  | { kind: "file"; relativePath: string; origin: ".mcp.json" | "manifest" }
  | { kind: "inline-manifest" }
  | { kind: "unmodelled"; reason: string };

/** MCPB bundles (`.mcpb`, `.dxt`) and URLs: resolved only by the CLI at load time. */
function isMcpBundleSpec(spec: string): boolean {
  return /^https?:\/\//i.test(spec) || /\.(mcpb|dxt)$/i.test(spec);
}

export function claudePluginMcpDeclarations(manifest: unknown): ClaudePluginMcpDeclaration[] {
  const declarations: ClaudePluginMcpDeclaration[] = [
    { kind: "file", relativePath: ".mcp.json", origin: ".mcp.json" },
  ];
  const spec = isRecord(manifest) ? manifest.mcpServers : undefined;
  const fromString = (value: string): ClaudePluginMcpDeclaration =>
    isMcpBundleSpec(value)
      ? {
          kind: "unmodelled",
          reason:
            "an MCPB bundle, whose servers Claude Code reads when it loads the plugin; they are not shown here",
        }
      : { kind: "file", relativePath: value, origin: "manifest" };
  if (typeof spec === "string") declarations.push(fromString(spec));
  else if (Array.isArray(spec)) {
    for (const item of spec) {
      if (typeof item === "string") declarations.push(fromString(item));
      else
        declarations.push({
          kind: "unmodelled",
          reason: "a server map inside the mcpServers list of plugin.json, which is not shown here",
        });
    }
  } else if (isRecord(spec)) declarations.push({ kind: "inline-manifest" });
  return declarations;
}

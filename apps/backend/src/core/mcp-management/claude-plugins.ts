/**
 * Read-only sources for the MCP servers Claude Code plugins add.
 *
 * The plugin set is the Claude bridge's own (`getPluginsForSdk`), built by the
 * same shared merge (`@orkestrator/protocol/node/claude-plugin-set`) over the
 * same files, so the editor cannot list a plugin a session does not get or
 * miss one it does. Each plugin that declares servers contributes one source
 * per place it declares them, named as the CLI names them
 * (`plugin:<plugin>:<server>`), and whether the CLI loads the plugin follows
 * the pinned CLI's `enabledPlugins` rule. Values are shown exactly as written:
 * `${CLAUDE_PLUGIN_ROOT}` and environment references are never expanded.
 *
 * Every read is bounded and passive. Paths come from the provider's own files,
 * never from a client, and leave this module only as display text.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  claudeInlinePluginEnablement,
  claudeInstalledPluginEnablement,
  claudePluginMcpDeclarations,
  claudePluginName,
  claudePluginServerName,
  mergeClaudePluginLayers,
  remapInstalledPlugins,
  type ClaudePluginConfig,
  type ClaudePluginSettingSource,
} from "@orkestrator/protocol/node/claude-plugin-set";

import type { TextReader } from "./native-policy.js";
import type { SourceSpec } from "./types.js";

/** Plugin files are the plugin's; reads are bounded like Cursor's and Pi's files. */
export const CLAUDE_PLUGIN_FILE_MAX_BYTES = 1024 * 1024;
/** Plugin sources one snapshot lists, across every plugin; later plugins are counted, not listed. */
export const CLAUDE_PLUGIN_SOURCES_MAX = 64;
/** Sources one plugin contributes at most (`.mcp.json`, the manifest and its listed files). */
const SOURCES_PER_PLUGIN = 8;
/** Precedence of the first plugin source; plugin servers never share a name with a file entry. */
const PLUGIN_PRECEDENCE_BASE = 100;

export const CLAUDE_PLUGIN_READ_ONLY_REASON = "Managed by Claude Code's plugin settings.";

export interface ClaudePluginSourceInput {
  home: string;
  /** `$CLAUDE_CONFIG_DIR`: the CLI's user settings live here when it is set. */
  claudeConfigDir?: string;
  /** The session's working directory: the worktree or `/workspace`; absent for the backend user. */
  cwd?: string;
  /** Whether sessions here load project resources (project plugin lists and settings). */
  includeProjectSources: boolean;
  /** Bounded read; `null` when the file is absent or unreadable. */
  readText: TextReader;
  exists(filePath: string): Promise<boolean>;
  /** Subdirectories of a folder, for the bridge's plugins-folder scan. Host only. */
  listDirectories?(dir: string): Promise<string[]>;
  /** Display a path the way every other source does. */
  display(filePath: string): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRead = { state: "absent" } | { state: "invalid" } | { state: "ok"; value: unknown };

async function readJson(
  input: ClaudePluginSourceInput,
  filePath: string,
  maxBytes = CLAUDE_PLUGIN_FILE_MAX_BYTES,
): Promise<JsonRead> {
  const text = await input.readText(filePath);
  if (text === null) return { state: "absent" };
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { state: "invalid" };
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "invalid" };
  }
}

const valueOf = (read: JsonRead): unknown => (read.state === "ok" ? read.value : undefined);

/** Host subdirectories, for the plugins-folder scan. */
export async function listHostDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/**
 * The bridge's CLI-installed layer: `installed_plugins.json` remapped onto the
 * local plugins folder, or, when that file has no readable `plugins`, the
 * folders holding `.claude-plugin/plugin.json`.
 */
async function cliInstalledPlugins(
  input: ClaudePluginSourceInput,
  pluginsDir: string,
): Promise<{ plugins: ClaudePluginConfig[]; installedIds: string[] }> {
  const installed = valueOf(await readJson(input, path.join(pluginsDir, "installed_plugins.json")));
  const record = isRecord(installed) ? installed.plugins : undefined;
  if (record) {
    return {
      plugins: remapInstalledPlugins(pluginsDir, { plugins: record }),
      installedIds: isRecord(record) ? Object.keys(record) : [],
    };
  }
  const plugins: ClaudePluginConfig[] = [];
  for (const dir of (await input.listDirectories?.(pluginsDir)) ?? []) {
    if (await input.exists(path.join(dir, ".claude-plugin", "plugin.json")))
      plugins.push({ type: "local", path: dir });
  }
  return { plugins, installedIds: [] };
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Where the CLI reads each settings layer. */
function settingsFile(
  source: ClaudePluginSettingSource,
  input: ClaudePluginSourceInput,
): string | null {
  switch (source) {
    case "user":
      return path.join(input.claudeConfigDir ?? path.join(input.home, ".claude"), "settings.json");
    case "project":
      return input.cwd ? path.join(input.cwd, ".claude", "settings.json") : null;
    case "local":
      return input.cwd ? path.join(input.cwd, ".claude", "settings.local.json") : null;
  }
}

interface PluginSettings {
  documents: Partial<Record<ClaudePluginSettingSource, unknown>>;
  paths: Partial<Record<ClaudePluginSettingSource, string>>;
}

async function readPluginSettings(input: ClaudePluginSourceInput): Promise<PluginSettings> {
  const settings: PluginSettings = { documents: {}, paths: {} };
  for (const source of ["user", "project", "local"] as const) {
    const filePath = settingsFile(source, input);
    if (!filePath) continue;
    settings.paths[source] = filePath;
    settings.documents[source] = valueOf(await readJson(input, filePath));
  }
  return settings;
}

interface PluginState {
  disabledReason?: string;
  notes: string[];
}

/**
 * Whether Orkestrator's sessions load a plugin, and why. Sessions load user
 * and project settings (project only with project resources); local settings
 * only when a session turns on "Include local settings", which is noted.
 */
function pluginState(
  name: string,
  manifest: unknown,
  settings: PluginSettings,
  installedIds: readonly string[],
  input: ClaudePluginSourceInput,
): PluginState {
  const loaded: ClaudePluginSettingSource[] = input.includeProjectSources
    ? ["project", "user"]
    : ["user"];
  const where = (source: ClaudePluginSettingSource) =>
    input.display(settings.paths[source] ?? source);
  const describe = (sources: readonly ClaudePluginSettingSource[]) => {
    const inline = claudeInlinePluginEnablement(name, manifest, settings.documents, sources);
    if (inline.enabled) return { enabled: true, inline };
    const installed = claudeInstalledPluginEnablement(
      name,
      installedIds,
      settings.documents,
      sources,
    );
    if (installed) return { enabled: true, inline, installed };
    return { enabled: false, inline };
  };
  const notes: string[] = [];
  const state = describe(loaded);
  let disabledReason: string | undefined;
  if (!state.enabled) {
    disabledReason = state.inline.decidedBy
      ? `Disabled: enabledPlugins["${state.inline.decidedBy.key}"] is false in ${where(state.inline.decidedBy.source)}.`
      : `Disabled: the plugin's manifest sets defaultEnabled to false, and no enabledPlugins setting turns on "${name}@inline".`;
  } else if (state.installed) {
    notes.push(
      `enabledPlugins["${state.inline.decidedBy?.key ?? `${name}@inline`}"] turns off the copy Orkestrator passes, but Claude Code still loads its own installed copy, enabled by enabledPlugins["${state.installed.id}"] in ${where(state.installed.source)}.`,
    );
  }
  if (state.enabled && !state.installed) {
    // A marketplace id never applies to the copy Orkestrator passes.
    const ignored = loaded.flatMap((source) => {
      const document = settings.documents[source];
      const enabledPlugins = isRecord(document) ? document.enabledPlugins : undefined;
      if (!isRecord(enabledPlugins)) return [];
      return Object.entries(enabledPlugins)
        .filter(([key, value]) => {
          const at = key.lastIndexOf("@");
          return (
            value === false &&
            at > 0 &&
            key.slice(0, at) === name &&
            key.slice(at + 1).toLowerCase() !== "inline"
          );
        })
        .map(([key]) => key);
    });
    if (ignored.length) {
      notes.push(
        `enabledPlugins["${ignored[0]}"] is false, but Orkestrator passes this plugin to Claude Code directly, where only enabledPlugins["${name}@inline"] applies. Set that to false to turn it off for Orkestrator's sessions.`,
      );
    }
  }
  if (input.includeProjectSources && settings.paths.local) {
    const withLocal = describe(["local", ...loaded]);
    if (withLocal.enabled !== state.enabled) {
      notes.push(
        `Sessions with "Include local settings" on ${withLocal.enabled ? "load" : "do not load"} this plugin: ${
          withLocal.inline.decidedBy?.source === "local"
            ? `enabledPlugins["${withLocal.inline.decidedBy.key}"] in ${where("local")}`
            : `settings in ${where("local")}`
        }.`,
      );
    }
  }
  if (!input.cwd) {
    notes.push(
      "A project's .claude/settings.json can also turn this plugin off for that environment.",
    );
  }
  return { disabledReason, notes };
}

/**
 * The read-only plugin sources for one Claude target, in the bridge's plugin
 * order, each plugin's sources in the order the CLI merges them.
 */
export async function claudePluginSources(input: ClaudePluginSourceInput): Promise<SourceSpec[]> {
  const cwd = input.cwd ?? input.home;
  const pluginsDir = path.join(input.home, ".claude", "plugins");
  const claudeJson = valueOf(
    await readJson(input, path.join(input.home, ".claude.json"), Number.POSITIVE_INFINITY),
  );
  const projects = isRecord(claudeJson) ? claudeJson.projects : undefined;
  const project = input.cwd && isRecord(projects) ? projects[input.cwd] : undefined;
  const projectLocal =
    input.cwd && input.includeProjectSources
      ? valueOf(await readJson(input, path.join(input.cwd, ".claude", "plugins.json")))
      : undefined;
  const installed = await cliInstalledPlugins(input, pluginsDir);
  const pluginDirs = mergeClaudePluginLayers(
    {
      global: isRecord(claudeJson) ? claudeJson.plugins : undefined,
      cliInstalled: installed.plugins,
      projectGlobal: isRecord(project) ? project.plugins : undefined,
      projectLocal: isRecord(projectLocal) ? projectLocal.plugins : undefined,
    },
    { cwd, home: input.home, includeProjectSources: input.includeProjectSources && !!input.cwd },
  );
  const settings = await readPluginSettings(input);
  const specs: SourceSpec[] = [];
  const names = new Map<string, number>();
  let inspected = 0;
  let omitted = 0;
  for (const pluginDir of pluginDirs) {
    if (specs.length >= CLAUDE_PLUGIN_SOURCES_MAX) {
      omitted += 1;
      continue;
    }
    const manifestPath = path.join(pluginDir, ".claude-plugin", "plugin.json");
    const manifestRead = await readJson(input, manifestPath);
    const mcpJsonPath = path.join(pluginDir, ".mcp.json");
    if (manifestRead.state === "absent" && !(await input.exists(mcpJsonPath))) continue;
    inspected += 1;
    const manifest = valueOf(manifestRead);
    const pluginIndex = inspected - 1;
    // Each plugin's sources stay together, in the order the CLI merges them;
    // earlier plugins rank higher so the editor lists plugins in the bridge's
    // order. Plugin names are namespaced, so this decides nothing except
    // between two plugins with the same name, which the source notes.
    const precedence = (offset: number) =>
      PLUGIN_PRECEDENCE_BASE + (CLAUDE_PLUGIN_SOURCES_MAX - pluginIndex) * 16 + offset;
    const base = (key: string, filePath: string, label: string): SourceSpec => ({
      sourceId: `claude:plugin-${shortHash(`${pluginDir}\u0000${key}`)}`,
      provider: "claude",
      scope: "plugin",
      owner: "plugin",
      format: "json",
      label,
      path: filePath,
      displayPath: input.display(filePath),
      subtree: ["mcpServers"],
      precedence: precedence(0),
      writable: false,
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
      sharedWith: [],
      maxBytes: CLAUDE_PLUGIN_FILE_MAX_BYTES,
      createMode: 0o600,
    });
    if (manifestRead.state === "invalid") {
      specs.push({
        ...base("plugin.json", manifestPath, `Plugin at ${input.display(pluginDir)}`),
        note: "Claude Code does not load this plugin: its .claude-plugin/plugin.json is not valid JSON.",
        noEntries: true,
      });
      continue;
    }
    const name = claudePluginName(manifest, pluginDir);
    if (!name) {
      specs.push({
        ...base("plugin.json", manifestPath, `Plugin at ${input.display(pluginDir)}`),
        note: 'Claude Code does not load this plugin: its name is empty or contains "@", ":", whitespace, a path separator or an invisible character.',
        noEntries: true,
      });
      continue;
    }
    const state = pluginState(name, manifest, settings, installed.installedIds, input);
    const seen = names.get(name) ?? 0;
    names.set(name, seen + 1);
    const notes = [...state.notes];
    if (seen) {
      notes.push(
        `Another plugin Orkestrator passes is also named "${name}"; Claude Code gives their servers the same names, and this editor does not model which one it keeps.`,
      );
    }
    const unmodelled: string[] = [];
    const pluginSpecs: SourceSpec[] = [];
    let offset = 0;
    for (const declaration of claudePluginMcpDeclarations(manifest)) {
      if (declaration.kind === "unmodelled") {
        unmodelled.push(declaration.reason);
        continue;
      }
      if (declaration.kind === "inline-manifest") {
        pluginSpecs.push({
          ...base("manifest", manifestPath, `Plugin ${name} (plugin.json)`),
          precedence: precedence(++offset),
        });
        continue;
      }
      const filePath = path.resolve(pluginDir, declaration.relativePath);
      if (!isWithin(pluginDir, filePath)) {
        unmodelled.push(
          `${declaration.relativePath}, which is outside the plugin's folder and not shown here`,
        );
        continue;
      }
      if (declaration.origin === ".mcp.json" && !(await input.exists(filePath))) continue;
      pluginSpecs.push({
        ...base(
          declaration.origin === ".mcp.json" ? ".mcp.json" : `file:${declaration.relativePath}`,
          filePath,
          declaration.origin === ".mcp.json"
            ? `Plugin ${name}`
            : `Plugin ${name} (${declaration.relativePath})`,
        ),
        // The CLI accepts `{ "mcpServers": … }` or a bare map in these files.
        bareMapFallback: true,
        precedence: precedence(++offset),
      });
    }
    if (unmodelled.length) {
      notes.push(`plugin.json also declares servers in ${unmodelled.join("; and ")}.`);
      if (!pluginSpecs.length) {
        pluginSpecs.push({
          ...base("manifest", manifestPath, `Plugin ${name} (plugin.json)`),
          noEntries: true,
        });
      }
    }
    // With no rows to carry it, the source says the plugin is off.
    if (state.disabledReason && pluginSpecs.every((spec) => spec.noEntries))
      notes.unshift(state.disabledReason);
    for (const spec of pluginSpecs) {
      spec.entryNamePrefix = claudePluginServerName(name, "");
      if (state.disabledReason) spec.disabledReason = state.disabledReason;
    }
    if (notes.length && pluginSpecs[0]) pluginSpecs[0].note = notes.join(" ");
    specs.push(...pluginSpecs.slice(0, SOURCES_PER_PLUGIN));
  }
  const last = specs.at(-1);
  if (omitted && last) {
    const more = `${omitted} more plugin folder${omitted === 1 ? "" : "s"} Orkestrator passes to Claude Code ${omitted === 1 ? "was" : "were"} not checked for MCP servers.`;
    last.note = last.note ? `${last.note} ${more}` : more;
  }
  return specs;
}

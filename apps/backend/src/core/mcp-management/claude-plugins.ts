/**
 * Read-only sources for the MCP servers Claude Code plugins add.
 *
 * The plugin set is the Claude bridge's own (`getPluginsForSdk`), built by the
 * same shared merge (`@orkestrator/protocol/node/claude-plugin-set`) over the
 * same files, so the editor cannot list a plugin a session does not get or
 * miss one it does. Installs the bridge does not pass, because Claude Code's
 * own settings turn them off, are still listed, disabled, so the row says why
 * the plugin is off. Each plugin that declares servers contributes one source
 * per place it declares them, named as the CLI names them
 * (`plugin:<plugin>:<server>`), and whether the CLI loads the plugin follows
 * the pinned CLI's `enabledPlugins` rule. Values are shown exactly as written:
 * `${CLAUDE_PLUGIN_ROOT}` and environment references are never expanded.
 *
 * Every read is bounded and passive. Paths come from the provider's own files,
 * never from a client, and leave this module only as display text.
 */

import { truncateUtf8 } from "@orkestrator/protocol/mcp-management";

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {
  claudeInlinePluginEnablement,
  claudeInstalledPluginEnablement,
  claudeInstalledPluginIdEnablement,
  claudePluginMcpDeclarations,
  claudePluginName,
  claudePluginServerName,
  enabledInstalledPlugins,
  mergeClaudePluginLayers,
  remapInstalledPlugins,
  resolveClaudePluginPath,
  type ClaudePluginConfig,
  type ClaudePluginEnablement,
  type ClaudePluginLayers,
  type ClaudePluginSettingSource,
} from "@orkestrator/protocol/node/claude-plugin-set";

import type { TextReader } from "./native-policy.js";
import type { PluginDirectoryListing, SourceSpec } from "./types.js";

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
  /** Subdirectories of a folder, for the bridge's plugins-folder scan. */
  listDirectories?(dir: string): Promise<PluginDirectoryListing>;
  /** Display a path the way every other source does. */
  display(filePath: string): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JsonRead =
  { state: "absent" | "unavailable" | "oversized" | "invalid" } | { state: "ok"; value: unknown };

async function readJson(
  input: ClaudePluginSourceInput,
  filePath: string,
  maxBytes = CLAUDE_PLUGIN_FILE_MAX_BYTES,
): Promise<JsonRead> {
  const text = await input.readText(filePath);
  if (text === null) return { state: (await input.exists(filePath)) ? "unavailable" : "absent" };
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { state: "oversized" };
  try {
    return { state: "ok", value: JSON.parse(text) };
  } catch {
    return { state: "invalid" };
  }
}

const valueOf = (read: JsonRead): unknown => (read.state === "ok" ? read.value : undefined);

/** Host subdirectories, for the plugins-folder scan. */
export async function listHostDirectories(dir: string): Promise<PluginDirectoryListing> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return {
      directories: entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name)),
    };
  } catch {
    return { directories: [] };
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
): Promise<{ plugins: ClaudePluginConfig[]; installedIds: string[]; scanIncomplete?: boolean }> {
  const installed = valueOf(await readJson(input, path.join(pluginsDir, "installed_plugins.json")));
  const record = isRecord(installed) ? installed.plugins : undefined;
  if (record) {
    return {
      plugins: remapInstalledPlugins(pluginsDir, { plugins: record }),
      installedIds: isRecord(record) ? Object.keys(record) : [],
    };
  }
  const plugins: ClaudePluginConfig[] = [];
  const listing = await input.listDirectories?.(pluginsDir);
  for (const dir of listing?.directories ?? []) {
    if (await input.exists(path.join(dir, ".claude-plugin", "plugin.json")))
      plugins.push({ type: "local", path: dir });
  }
  return { plugins, installedIds: [], scanIncomplete: listing?.incomplete };
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

/** How the CLI treats one plugin for one set of loaded settings layers. */
interface PluginDecision {
  enabled: boolean;
  /** The `@inline` rule, when the bridge passes the plugin. */
  inline?: ClaudePluginEnablement;
  /** Claude Code's own installed copy that loads while the `@inline` copy is off. */
  installed?: { id: string; source: ClaudePluginSettingSource };
  /** The bridge does not pass it: the install's own id is not enabled. */
  notPassed?: { id: string; decidedBy?: { source: ClaudePluginSettingSource; key: string } };
}

/**
 * Whether the bridge passes one plugin folder, for a set of loaded settings
 * layers: `passed` says so, and `installedIds` are the `installed_plugins.json`
 * ids the folder is recorded under (the ids whose settings decide it when only
 * the installed layer lists it).
 */
interface PluginPassing {
  installedIds: readonly string[];
  passed(sources: readonly ClaudePluginSettingSource[]): boolean;
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
  passing: PluginPassing,
  input: ClaudePluginSourceInput,
): PluginState {
  const loaded: ClaudePluginSettingSource[] = input.includeProjectSources
    ? ["project", "user"]
    : ["user"];
  const where = (source: ClaudePluginSettingSource) =>
    input.display(settings.paths[source] ?? source);
  const describe = (sources: readonly ClaudePluginSettingSource[]): PluginDecision => {
    if (!passing.passed(sources)) {
      // Only the installed layer lists it, and Claude Code's settings leave
      // every id it is recorded under off: the CLI's own copy is off too.
      const id = passing.installedIds[0] ?? `${name}@`;
      const install = claudeInstalledPluginIdEnablement(id, settings.documents, sources);
      return { enabled: false, notPassed: { id, decidedBy: install.decidedBy } };
    }
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
  /** The setting in local settings that decides `described`, for the local-settings note. */
  const localDecider = (described: PluginDecision) => {
    const key =
      described.notPassed?.decidedBy?.source === "local"
        ? described.notPassed.decidedBy.key
        : described.inline?.decidedBy?.source === "local"
          ? described.inline.decidedBy.key
          : described.installed?.source === "local"
            ? described.installed.id
            : // An install that local settings alone enable is passed because of them.
              passing.installedIds.find(
                (id) =>
                  claudeInstalledPluginIdEnablement(id, settings.documents, ["local"]).decidedBy,
              );
    return key ? `enabledPlugins["${key}"] in ${where("local")}` : `settings in ${where("local")}`;
  };
  const notes: string[] = [];
  const state = describe(loaded);
  let disabledReason: string | undefined;
  if (state.notPassed) {
    const decided = state.notPassed.decidedBy;
    const value = decided
      ? (settings.documents[decided.source] as { enabledPlugins: Record<string, unknown> })
          .enabledPlugins[decided.key]
      : undefined;
    disabledReason = decided
      ? `Disabled: enabledPlugins["${decided.key}"] is ${value === false ? "false" : "not true"} in ${where(decided.source)}, so Orkestrator does not pass this installed plugin to Claude Code.`
      : `Disabled: no settings file these sessions load sets enabledPlugins["${state.notPassed.id}"] to true, so Orkestrator does not pass this installed plugin to Claude Code.`;
  } else if (!state.enabled) {
    disabledReason = state.inline?.decidedBy
      ? `Disabled: enabledPlugins["${state.inline.decidedBy.key}"] is false in ${where(state.inline.decidedBy.source)}.`
      : `Disabled: the plugin's manifest sets defaultEnabled to false, and no enabledPlugins setting turns on "${name}@inline".`;
  } else if (state.installed) {
    notes.push(
      `enabledPlugins["${state.inline?.decidedBy?.key ?? `${name}@inline`}"] turns off the copy Orkestrator passes, but Claude Code still loads its own installed copy, enabled by enabledPlugins["${state.installed.id}"] in ${where(state.installed.source)}.`,
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
        `Sessions with "Include local settings" on ${withLocal.enabled ? "load" : "do not load"} this plugin: ${localDecider(withLocal)}.`,
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
  const claudeJsonPath = path.join(input.home, ".claude.json");
  const claudeJsonRead = await readJson(input, claudeJsonPath, Number.POSITIVE_INFINITY);
  const claudeJson = valueOf(claudeJsonRead);
  const projects = isRecord(claudeJson) ? claudeJson.projects : undefined;
  const project = input.cwd && isRecord(projects) ? projects[input.cwd] : undefined;
  const projectLocal =
    input.cwd && input.includeProjectSources
      ? valueOf(await readJson(input, path.join(input.cwd, ".claude", "plugins.json")))
      : undefined;
  const installed = await cliInstalledPlugins(input, pluginsDir);
  const layers: ClaudePluginLayers = {
    global: isRecord(claudeJson) ? claudeJson.plugins : undefined,
    cliInstalled: installed.plugins,
    projectGlobal: isRecord(project) ? project.plugins : undefined,
    projectLocal: isRecord(projectLocal) ? projectLocal.plugins : undefined,
  };
  const mergeOptions = {
    cwd,
    home: input.home,
    includeProjectSources: input.includeProjectSources && !!input.cwd,
  };
  // Every folder, including installs the bridge leaves out, so their rows can
  // say why they are off; `passedBy` is the bridge's own set for those layers.
  const pluginDirs = mergeClaudePluginLayers(layers, mergeOptions);
  const settings = await readPluginSettings(input);
  const passedSets = new Map<string, Set<string>>();
  const passedBy = (sources: readonly ClaudePluginSettingSource[]) => {
    const key = sources.join(",");
    let passed = passedSets.get(key);
    if (!passed) {
      const cliInstalled = enabledInstalledPlugins(installed.plugins, settings.documents, sources);
      passed = new Set(mergeClaudePluginLayers({ ...layers, cliInstalled }, mergeOptions));
      passedSets.set(key, passed);
    }
    return passed;
  };
  const installedIdsByDir = new Map<string, string[]>();
  for (const plugin of installed.plugins) {
    if (!plugin.installedId) continue;
    const dir = resolveClaudePluginPath(plugin.path, cwd, input.home);
    installedIdsByDir.set(dir, [...(installedIdsByDir.get(dir) ?? []), plugin.installedId]);
  }
  const specs: SourceSpec[] = [];
  const discoveryNotes: string[] = [];
  if (claudeJsonRead.state !== "ok" && claudeJsonRead.state !== "absent")
    discoveryNotes.push(
      "Plugin discovery is incomplete: ~/.claude.json could not be read as JSON within the source file size limit. Global and project plugin layers may be missing.",
    );
  if (installed.scanIncomplete)
    discoveryNotes.push(
      "Plugin discovery is incomplete: the plugins folder scan hit its directory limit or could not finish. Additional plugin folders may be missing.",
    );
  if (discoveryNotes.length) {
    specs.push({
      sourceId: "claude:plugin-discovery",
      provider: "claude",
      scope: "plugin",
      owner: "plugin",
      format: "json",
      label: "Plugin discovery",
      path: claudeJsonPath,
      displayPath: input.display(claudeJsonPath),
      subtree: [],
      precedence: PLUGIN_PRECEDENCE_BASE,
      writable: false,
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
      sharedWith: [],
      maxBytes: CLAUDE_PLUGIN_FILE_MAX_BYTES,
      createMode: 0o600,
      noEntries: true,
      discoveryIncomplete: true,
      note: discoveryNotes.join(" "),
    });
  }
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
    if (["invalid", "oversized", "unavailable"].includes(manifestRead.state)) {
      specs.push({
        ...base("plugin.json", manifestPath, `Plugin at ${input.display(pluginDir)}`),
        note:
          manifestRead.state === "invalid"
            ? "Claude Code does not load this plugin: its .claude-plugin/plugin.json is not valid JSON."
            : `Plugin discovery is incomplete: .claude-plugin/plugin.json ${manifestRead.state === "oversized" ? `exceeds the ${CLAUDE_PLUGIN_FILE_MAX_BYTES}-byte plugin file size limit` : "could not be read within the source file size limit"}.`,
        discoveryIncomplete: true,
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
    const state = pluginState(
      name,
      manifest,
      settings,
      installed.installedIds,
      {
        installedIds: installedIdsByDir.get(pluginDir) ?? [],
        passed: (sources) => passedBy(sources).has(pluginDir),
      },
      input,
    );
    const seen = names.get(name) ?? 0;
    names.set(name, seen + 1);
    const notes = [...state.notes];
    if (seen) {
      notes.push(
        `Another plugin Orkestrator passes is also named "${name}"; Claude Code gives their servers the same names, and this editor does not model which one it keeps.`,
      );
    }
    const unmodelled = new Map<string, number>();
    let unsupportedCount = 0;
    const unsupported = (reason: string) => {
      unsupportedCount += 1;
      const short = truncateUtf8(reason, 160);
      if (unmodelled.has(short) || unmodelled.size < 3)
        unmodelled.set(short, (unmodelled.get(short) ?? 0) + 1);
    };
    const pluginSpecs: SourceSpec[] = [];
    for (const declaration of claudePluginMcpDeclarations(manifest)) {
      if (declaration.kind === "unmodelled") {
        unsupported(declaration.reason);
        continue;
      }
      if (declaration.kind === "inline-manifest") {
        pluginSpecs.push({
          ...base("manifest", manifestPath, `Plugin ${name} (plugin.json)`),
        });
        continue;
      }
      const filePath = path.resolve(pluginDir, declaration.relativePath);
      if (!isWithin(pluginDir, filePath)) {
        unsupported(
          `${declaration.relativePath}, which is outside the plugin's folder and not shown here`,
        );
        continue;
      }
      if (declaration.origin === ".mcp.json" && !(await input.exists(filePath))) continue;
      pluginSpecs.push({
        ...base(
          declaration.origin === ".mcp.json" ? ".mcp.json" : `file:${filePath}`,
          filePath,
          declaration.origin === ".mcp.json"
            ? `Plugin ${name}`
            : `Plugin ${name} (${declaration.relativePath})`,
        ),
        // The CLI accepts `{ "mcpServers": … }` or a bare map in these files.
        bareMapFallback: true,
      });
    }
    if (unsupportedCount) {
      notes.push(
        `${unsupportedCount} unsupported declaration${unsupportedCount === 1 ? "" : "s"} omitted from plugin.json; examples: ${[...unmodelled].map(([reason, count]) => `${reason}${count > 1 ? ` (${count} occurrences)` : ""}`).join("; ")}.`,
      );
      if (!pluginSpecs.length) {
        pluginSpecs.push({
          ...base("manifest", manifestPath, `Plugin ${name} (plugin.json)`),
          noEntries: true,
        });
      }
    }
    // A repeated path has the same contents each time; only its final merge
    // position matters (A, B, A must still let A override B).
    const seenSources = new Set<string>();
    const unique = pluginSpecs
      .toReversed()
      .filter((spec) => {
        if (seenSources.has(spec.path)) return false;
        seenSources.add(spec.path);
        return true;
      })
      .reverse();
    const capacity = Math.min(SOURCES_PER_PLUGIN, CLAUDE_PLUGIN_SOURCES_MAX - specs.length);
    const retained = unique.slice(-capacity);
    const omittedDeclarations = unique.length - retained.length;
    if (omittedDeclarations) {
      notes.unshift(
        `${omittedDeclarations} earlier MCP declaration source${omittedDeclarations === 1 ? "" : "s"} omitted by the catalog source limit; this plugin's view is incomplete. The final declarations are shown so listed servers retain their merge winners.`,
      );
      for (const spec of retained) spec.discoveryIncomplete = true;
    }
    // With no rows to carry it, the source says the plugin is off.
    if (state.disabledReason && retained.every((spec) => spec.noEntries))
      notes.unshift(state.disabledReason);
    for (const [index, spec] of retained.entries()) {
      if (unsupportedCount) spec.discoveryIncomplete = true;
      spec.precedence = precedence(index + 1);
      spec.entryNamePrefix = claudePluginServerName(name, "");
      if (state.disabledReason) spec.disabledReason = state.disabledReason;
    }
    if (notes.length && retained[0]) retained[0].note = notes.join(" ");
    specs.push(...retained);
  }
  const last = specs.at(-1);
  if (omitted && last) {
    const more = `${omitted} more plugin folder${omitted === 1 ? "" : "s"} Orkestrator passes to Claude Code ${omitted === 1 ? "was" : "were"} not checked for MCP servers.`;
    last.note = last.note ? `${more} ${last.note}` : more;
    last.discoveryIncomplete = true;
  }
  // Bound all plugin-derived display text, including names and paths, before
  // any source metadata competes with ordinary editable definition rows.
  for (const spec of specs) {
    spec.label = truncateUtf8(spec.label, 256);
    spec.displayPath = truncateUtf8(spec.displayPath, 512);
    if (spec.note) spec.note = truncateUtf8(spec.note, 1024);
    if (spec.disabledReason) spec.disabledReason = truncateUtf8(spec.disabledReason, 512);
  }
  return specs;
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MCP_MANAGEMENT_LIMITS,
  utf8ByteLength,
  type McpManagementSnapshot,
} from "@orkestrator/protocol/mcp-management";

import {
  CLAUDE_PLUGIN_FILE_MAX_BYTES,
  CLAUDE_PLUGIN_READ_ONLY_REASON,
  claudePluginSources,
} from "./claude-plugins.js";
import { fitSnapshotBudget } from "./service.js";
import { joinLiveMcpServer } from "../../../../web/src/components/settings/mcp-servers/mcp-live-join.js";
import { createFixture, mutation, targetIdFor, type Fixture } from "./test-support.js";

/**
 * Claude plugin MCP servers: one read-only source per place a loaded plugin
 * declares servers, named as the CLI names them, disabled when the CLI's
 * `enabledPlugins` rule turns the plugin off, values shown as written.
 */

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
});

afterEach(async () => {
  await fixture.cleanup();
});

/** Install a plugin the way `claude plugin install` records it, under the fixture home. */
function installPlugin(
  name: string,
  files: { manifest?: unknown; mcpJson?: unknown; extra?: Record<string, unknown> },
  marketplace = "market",
): string {
  const relative = `home/.claude/plugins/cache/${marketplace}/${name}/1.0.0`;
  if (files.manifest !== undefined)
    fixture.write(`${relative}/.claude-plugin/plugin.json`, JSON.stringify(files.manifest));
  if (files.mcpJson !== undefined)
    fixture.write(`${relative}/.mcp.json`, JSON.stringify(files.mcpJson));
  for (const [file, content] of Object.entries(files.extra ?? {}))
    fixture.write(
      `${relative}/${file}`,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  return path.join(fixture.root, relative);
}

/** User settings, with every install's id enabled as `claude plugin install` records it. */
function writeUserSettings(
  enabledPlugins: Record<string, unknown>,
  installed: readonly string[] = [],
): void {
  fixture.write(
    "home/.claude/settings.json",
    JSON.stringify({
      enabledPlugins: {
        ...Object.fromEntries(installed.map((id) => [id, true])),
        ...enabledPlugins,
      },
    }),
  );
}

/**
 * Record installs as `claude plugin install` does: in `installed_plugins.json`,
 * and enabled in user settings unless `enable` is false.
 */
function writeInstalled(ids: Record<string, string>, enable = true): void {
  if (enable) writeUserSettings({}, Object.keys(ids));
  fixture.write(
    "home/.claude/plugins/installed_plugins.json",
    JSON.stringify({
      version: 2,
      plugins: Object.fromEntries(
        Object.entries(ids).map(([id, installPath]) => [
          id,
          [{ scope: "user", installPath, version: "1.0.0" }],
        ]),
      ),
    }),
  );
}

const stdio = (command: string, extra: Record<string, unknown> = {}) => ({ command, ...extra });

/**
 * Plugins listed in `~/.claude.json` (not installed), under `~/listed/<name>`:
 * only the `@inline` rule applies to them, since no install id exists.
 */
function listPlugins(plugins: Record<string, { manifest?: unknown; mcpJson: unknown }>): void {
  for (const [name, files] of Object.entries(plugins)) {
    if (files.manifest !== undefined)
      fixture.write(
        `home/listed/${name}/.claude-plugin/plugin.json`,
        JSON.stringify(files.manifest),
      );
    fixture.write(`home/listed/${name}/.mcp.json`, JSON.stringify(files.mcpJson));
  }
  fixture.write(
    "home/.claude.json",
    JSON.stringify({
      plugins: Object.keys(plugins).map((name) => ({ type: "local", path: `~/listed/${name}` })),
    }),
  );
}

function pluginSources(snapshot: McpManagementSnapshot) {
  return snapshot.sources.filter((source) => source.scope === "plugin");
}

function row(snapshot: McpManagementSnapshot, name: string) {
  const found = snapshot.definitions.find((definition) => definition.name === name);
  if (!found)
    throw new Error(`no row ${name}: ${snapshot.definitions.map((d) => d.name).join(", ")}`);
  return found;
}

/** Sessions in the environment load project resources (host default: off). */
function projectResourcesOn(): void {
  fixture.environment.agentSettings = { executionPolicy: { projectResources: true } };
}

async function snapshotFor(kind: "backend" | "environment" = "environment") {
  return fixture.service.snapshot({ targetId: await targetIdFor(fixture, "claude", kind) });
}

describe("Claude plugin MCP sources", () => {
  test("lists each loaded plugin's servers read-only under the CLI's names", async () => {
    const docs = installPlugin("docs", {
      manifest: { name: "docs" },
      mcpJson: { mcpServers: { search: stdio("${CLAUDE_PLUGIN_ROOT}/bin/search") } },
    });
    writeInstalled({ "docs@market": docs });
    const snapshot = await snapshotFor();
    const [source] = pluginSources(snapshot);
    expect(source).toMatchObject({
      scope: "plugin",
      owner: "plugin",
      label: "Plugin docs",
      displayPath: "~/.claude/plugins/cache/market/docs/1.0.0/.mcp.json",
      writable: false,
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
      state: "ok",
    });
    // No path from a client: the id is opaque.
    expect(source!.sourceId).toMatch(/^claude:plugin-[0-9a-f]{16}$/);
    const search = row(snapshot, "plugin:docs:search");
    expect(search).toMatchObject({
      status: "effective",
      enabled: null,
      command: { kind: "visible", value: "${CLAUDE_PLUGIN_ROOT}/bin/search" },
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
    });
    for (const action of ["edit", "rename", "remove", "setEnabled"] as const)
      expect(search.actions[action]).toEqual({
        supported: false,
        reason: CLAUDE_PLUGIN_READ_ONLY_REASON,
      });
    expect(snapshot.effective["plugin:docs:search"]).toBe(search.entryId);
    // The backend-user target lists the same plugin, with the project caveat.
    const backend = await snapshotFor("backend");
    expect(row(backend, "plugin:docs:search").status).toBe("effective");
    expect(pluginSources(backend)[0]!.note).toContain(".claude/settings.json");
  });

  test("a plugin row is never mistaken for, or shadows, a file entry of the same server name", async () => {
    fixture.write("worktree/.mcp.json", JSON.stringify({ mcpServers: { search: stdio("local") } }));
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs" },
        mcpJson: { search: stdio("plugin") },
      }),
    });
    const snapshot = await snapshotFor();
    expect(row(snapshot, "search").status).toBe("effective");
    expect(row(snapshot, "plugin:docs:search").status).toBe("effective");
    expect(row(snapshot, "plugin:docs:search").shadows).toEqual([]);
  });

  test("manifest servers follow .mcp.json, and replace a same-name server in it", async () => {
    const docs = installPlugin("docs", {
      manifest: {
        name: "docs",
        mcpServers: { search: stdio("from-manifest"), extra: stdio("x") },
      },
      mcpJson: { mcpServers: { search: stdio("from-mcp-json"), only: stdio("y") } },
    });
    writeInstalled({ "docs@market": docs });
    const snapshot = await snapshotFor();
    expect(pluginSources(snapshot).map((source) => source.label)).toEqual([
      "Plugin docs",
      "Plugin docs (plugin.json)",
    ]);
    const winner = snapshot.effective["plugin:docs:search"];
    const manifestRow = snapshot.definitions.find(
      (definition) =>
        definition.name === "plugin:docs:search" &&
        definition.command?.kind === "visible" &&
        definition.command.value === "from-manifest",
    )!;
    expect(winner).toBe(manifestRow.entryId);
    expect(
      snapshot.definitions
        .filter((definition) => definition.name === "plugin:docs:search")
        .map((definition) => definition.status),
    ).toEqual(expect.arrayContaining(["effective", "shadowed"]));
    expect(row(snapshot, "plugin:docs:only").status).toBe("effective");
    expect(row(snapshot, "plugin:docs:extra").status).toBe("effective");
  });

  test("ranked highest first, plugins read in the bridge's order and each plugin's manifest above its .mcp.json", async () => {
    writeInstalled({
      "zulu@market": installPlugin("zulu", {
        manifest: { name: "zulu" },
        mcpJson: { a: stdio("a") },
      }),
      "alpha@market": installPlugin("alpha", {
        manifest: { name: "alpha", mcpServers: { b: stdio("b") } },
        mcpJson: { a: stdio("a") },
      }),
    });
    const ranked = [...pluginSources(await snapshotFor())].sort(
      (left, right) => right.precedence - left.precedence,
    );
    expect(ranked.map((source) => source.label)).toEqual([
      "Plugin zulu",
      "Plugin alpha (plugin.json)",
      "Plugin alpha",
    ]);
  });

  test("a manifest path inside the plugin is read; MCPB bundles and outside paths are noted", async () => {
    const docs = installPlugin("docs", {
      manifest: { name: "docs", mcpServers: ["./servers.json", "../escape.json", "tool.mcpb"] },
      extra: { "servers.json": { remote: { type: "sse", url: "https://example.test/sse" } } },
    });
    writeInstalled({ "docs@market": docs });
    const snapshot = await snapshotFor();
    const sources = pluginSources(snapshot);
    expect(sources.map((source) => source.label)).toEqual(["Plugin docs (./servers.json)"]);
    expect(sources[0]!.note).toContain("MCPB bundle");
    expect(sources[0]!.note).toContain("../escape.json");
    // The CLI loads plugin SSE servers itself, so they are in use, not unsupported.
    expect(row(snapshot, "plugin:docs:remote").status).toBe("effective");
  });

  test("environment references are shown as written, never resolved", async () => {
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs" },
        mcpJson: {
          mcpServers: {
            search: stdio("node", {
              args: ["${CLAUDE_PLUGIN_ROOT}/server.js", "--data", "${CLAUDE_PLUGIN_DATA}"],
              env: { ROOT: "${CLAUDE_PLUGIN_ROOT}", TOKEN: "${DOCS_TOKEN}" },
            }),
          },
        },
      }),
    });
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const search = row(snapshot, "plugin:docs:search");
    expect(search.secretCount).toBe(0);
    const definition = await fixture.service.getDefinition({ targetId, entryId: search.entryId });
    expect(definition.args.map((arg) => arg.value)).toEqual([
      { kind: "visible", value: "${CLAUDE_PLUGIN_ROOT}/server.js" },
      { kind: "visible", value: "--data" },
      { kind: "visible", value: "${CLAUDE_PLUGIN_DATA}" },
    ]);
    expect(definition.env).toEqual([
      { key: "ROOT", presence: "reference", reference: "${CLAUDE_PLUGIN_ROOT}" },
      { key: "TOKEN", presence: "reference", reference: "${DOCS_TOKEN}" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(fixture.root);
    expect(definition.readOnlyReason).toBe(CLAUDE_PLUGIN_READ_ONLY_REASON);
  });

  test("a plugin disabled in project settings is shown disabled, naming the setting", async () => {
    projectResourcesOn();
    listPlugins({ docs: { manifest: { name: "docs" }, mcpJson: { search: stdio("s") } } });
    fixture.write(
      "worktree/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@inline": false } }),
    );
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:docs:search")).toMatchObject({
      status: "disabled",
      enabled: false,
      statusReason:
        'Disabled: enabledPlugins["docs@inline"] is false in <worktree>/.claude/settings.json.',
    });
    // Disabled rows own no name.
    expect(snapshot.effective["plugin:docs:search"]).toBeUndefined();
    // The backend user loads no project settings.
    expect(row(await snapshotFor("backend"), "plugin:docs:search").status).toBe("effective");
  });

  test("project settings are ignored when the environment excludes project resources (the host default)", async () => {
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs" },
        mcpJson: { search: stdio("s") },
      }),
    });
    fixture.write(
      "worktree/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@inline": false } }),
    );
    fixture.write(
      "worktree/.claude/plugins.json",
      JSON.stringify({ plugins: [{ type: "local", path: "./tools/plugin" }] }),
    );
    fixture.write("worktree/tools/plugin/.mcp.json", JSON.stringify({ tool: stdio("t") }));
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:docs:search").status).toBe("effective");
    expect(snapshot.definitions.some((definition) => definition.name.includes(":tool"))).toBe(
      false,
    );
  });

  test("project plugin lists add plugins, named from the folder when there is no manifest", async () => {
    projectResourcesOn();
    fixture.write(
      "worktree/.claude/plugins.json",
      JSON.stringify({ plugins: [{ type: "local", path: "./tools/helper" }] }),
    );
    fixture.write("worktree/tools/helper/.mcp.json", JSON.stringify({ tool: stdio("t") }));
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:helper:tool").status).toBe("effective");
    expect(pluginSources(snapshot)[0]!.displayPath).toBe("<worktree>/tools/helper/.mcp.json");
  });

  test("user settings, the manifest default and the local-settings caveat", async () => {
    projectResourcesOn();
    listPlugins({
      off: { manifest: { name: "off" }, mcpJson: { a: stdio("a") } },
      quiet: { manifest: { name: "quiet", defaultEnabled: false }, mcpJson: { a: stdio("a") } },
      local: { manifest: { name: "local" }, mcpJson: { a: stdio("a") } },
    });
    writeUserSettings({ "OFF@inline": false });
    fixture.write(
      "worktree/.claude/settings.local.json",
      JSON.stringify({ enabledPlugins: { "local@inline": false } }),
    );
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:off:a").statusReason).toBe(
      'Disabled: enabledPlugins["OFF@inline"] is false in ~/.claude/settings.json.',
    );
    expect(row(snapshot, "plugin:quiet:a").statusReason).toContain("defaultEnabled");
    expect(row(snapshot, "plugin:local:a").status).toBe("effective");
    const localSource = pluginSources(snapshot).find((source) => source.label === "Plugin local")!;
    expect(localSource.note).toContain(
      '"Include local settings" on do not load this plugin: enabledPlugins["local@inline"] in <worktree>/.claude/settings.local.json.',
    );
  });

  test("user settings come from CLAUDE_CONFIG_DIR when the backend sets it, as the CLI reads them", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "mcp-claude-config-"));
    try {
      await fixture.cleanup();
      fixture = createFixture({ env: { CLAUDE_CONFIG_DIR: configDir } });
      writeInstalled(
        {
          "docs@market": installPlugin("docs", {
            manifest: { name: "docs" },
            mcpJson: { a: stdio("a") },
          }),
        },
        false,
      );
      // The bridge's plugin set still comes from ~/.claude; only the settings move.
      writeUserSettings({ "docs@market": false });
      writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "docs@market": true } }),
      );
      expect(row(await snapshotFor(), "plugin:docs:a").status).toBe("effective");
      writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "docs@market": false } }),
      );
      const snapshot = await snapshotFor();
      expect(row(snapshot, "plugin:docs:a").status).toBe("disabled");
      expect(row(snapshot, "plugin:docs:a").statusReason).toContain(`${configDir}/settings.json`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an install Claude Code turned off is not passed, and its row names the setting", async () => {
    const docs = installPlugin("docs", { manifest: { name: "docs" }, mcpJson: { a: stdio("a") } });
    const never = installPlugin("never", {
      manifest: { name: "never" },
      mcpJson: { a: stdio("a") },
    });
    writeInstalled({ "docs@market": docs, "never@market": never }, false);
    writeUserSettings({ "docs@market": false });
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:docs:a")).toMatchObject({
      status: "disabled",
      enabled: false,
      statusReason:
        'Disabled: enabledPlugins["docs@market"] is false in ~/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    });
    expect(snapshot.effective["plugin:docs:a"]).toBeUndefined();
    // Installed but enabled nowhere: off in Claude Code too.
    expect(row(snapshot, "plugin:never:a").statusReason).toBe(
      'Disabled: no settings file these sessions load sets enabledPlugins["never@market"] to true, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
    // Only `true` enables an install.
    writeUserSettings({ "docs@market": "yes" });
    expect(row(await snapshotFor(), "plugin:docs:a").statusReason).toContain(
      'enabledPlugins["docs@market"] is not true in ~/.claude/settings.json',
    );
  });

  test("the first loaded layer naming an install's id decides, and local settings are noted", async () => {
    projectResourcesOn();
    const plugins = {
      project: installPlugin("project", {
        manifest: { name: "project" },
        mcpJson: { a: stdio("a") },
      }),
      localOff: installPlugin("lo", { manifest: { name: "lo" }, mcpJson: { a: stdio("a") } }),
      localOn: installPlugin("ln", { manifest: { name: "ln" }, mcpJson: { a: stdio("a") } }),
    };
    writeInstalled(
      {
        "project@market": plugins.project,
        "lo@market": plugins.localOff,
        "ln@market": plugins.localOn,
      },
      false,
    );
    writeUserSettings({ "project@market": true, "lo@market": true });
    fixture.write(
      "worktree/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "project@market": false } }),
    );
    fixture.write(
      "worktree/.claude/settings.local.json",
      JSON.stringify({ enabledPlugins: { "lo@market": false, "ln@market": true } }),
    );
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:project:a").statusReason).toBe(
      'Disabled: enabledPlugins["project@market"] is false in <worktree>/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
    // The backend user loads no project settings: user settings enable it.
    expect(row(await snapshotFor("backend"), "plugin:project:a").status).toBe("effective");
    const note = (label: string) =>
      pluginSources(snapshot).find((source) => source.label === label)!.note;
    expect(row(snapshot, "plugin:lo:a").status).toBe("effective");
    expect(note("Plugin lo")).toContain(
      'Sessions with "Include local settings" on do not load this plugin: enabledPlugins["lo@market"] in <worktree>/.claude/settings.local.json.',
    );
    expect(row(snapshot, "plugin:ln:a").status).toBe("disabled");
    expect(note("Plugin ln")).toContain(
      'Sessions with "Include local settings" on load this plugin: enabledPlugins["ln@market"] in <worktree>/.claude/settings.local.json.',
    );
  });

  test("a marketplace id never turns off a plugin Orkestrator lists itself, and an enabled installed copy still loads", async () => {
    // The same plugin, listed in ~/.claude.json as well as installed.
    fixture.write("home/mine/.claude-plugin/plugin.json", JSON.stringify({ name: "docs" }));
    fixture.write("home/mine/.mcp.json", JSON.stringify({ a: stdio("a") }));
    fixture.write(
      "home/.claude.json",
      JSON.stringify({ plugins: [{ type: "local", path: "~/mine" }] }),
    );
    const notes = installPlugin("notes", {
      manifest: { name: "notes" },
      mcpJson: { a: stdio("a") },
    });
    writeInstalled({ "notes@market": notes }, false);
    writeUserSettings({ "docs@market": false, "notes@inline": false, "notes@market": true });
    const snapshot = await snapshotFor();
    expect(row(snapshot, "plugin:docs:a").status).toBe("effective");
    const sources = pluginSources(snapshot);
    expect(sources.find((source) => source.label === "Plugin docs")!.note).toContain(
      'only enabledPlugins["docs@inline"] applies',
    );
    expect(row(snapshot, "plugin:notes:a").status).toBe("effective");
    expect(sources.find((source) => source.label === "Plugin notes")!.note).toContain(
      'enabled by enabledPlugins["notes@market"]',
    );
  });

  test("plugins the CLI refuses are listed with the reason and no servers", async () => {
    const broken = installPlugin("broken", { mcpJson: { a: stdio("a") } });
    fixture.write(
      `${path.relative(fixture.root, broken)}/.claude-plugin/plugin.json`,
      "{ not json",
    );
    const badName = installPlugin("bad", {
      manifest: { name: "bad name" },
      mcpJson: { a: stdio("a") },
    });
    writeInstalled({ "broken@market": broken, "bad@market": badName });
    const snapshot = await snapshotFor();
    const sources = pluginSources(snapshot);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ state: "invalid" });
    expect(sources[0]!.note).toContain("not valid JSON");
    expect(sources[1]!.note).toContain("its name");
    expect(
      snapshot.definitions.filter((definition) => definition.name.startsWith("plugin:")),
    ).toEqual([]);
  });

  test("plugin sources are refused as a write target", async () => {
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs" },
        mcpJson: { a: stdio("a") },
      }),
    });
    const targetId = await targetIdFor(fixture, "claude", "environment");
    const snapshot = await fixture.service.snapshot({ targetId });
    const source = pluginSources(snapshot)[0]!;
    const result = fixture.service.mutate(
      mutation(targetId, {
        kind: "add",
        sourceId: source.sourceId,
        expectedRevision: source.revision,
        definition: { name: "new", transport: "stdio", command: "x" },
      }),
    );
    await expect(result).rejects.toThrow("read-only-source");
  });

  test("the plugin sources one snapshot lists are bounded, and the rest counted", async () => {
    const ids: Record<string, string> = {};
    for (let index = 0; index < 70; index += 1) {
      const name = `p${String(index).padStart(2, "0")}`;
      ids[`${name}@market`] = installPlugin(name, {
        manifest: { name },
        mcpJson: { a: stdio("a") },
      });
    }
    writeInstalled(ids);
    const sources = pluginSources(await snapshotFor());
    expect(sources).toHaveLength(64);
    expect(sources.at(-1)!.note).toBe(
      "6 more plugin folders Orkestrator passes to Claude Code were not checked for MCP servers.",
    );
  });

  test("a bounded folder scan reports incomplete discovery even when no plugin rows are available", async () => {
    const sources = await claudePluginSources({
      home: fixture.home,
      includeProjectSources: false,
      readText: async () => null,
      exists: async () => false,
      listDirectories: async () => ({ directories: [], incomplete: true }),
      display: (filePath) => filePath,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ discoveryIncomplete: true, noEntries: true });
    expect(sources[0]!.note).toContain(
      "plugins folder scan hit its directory limit or could not finish",
    );
  });

  test("many unsupported declarations are summarized without evicting editable rows", async () => {
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({ mcpServers: { ordinary: stdio("local") } }),
    );
    const manifest = { name: "bundles", mcpServers: Array(10_000).fill("tool.mcpb") };
    expect(utf8ByteLength(JSON.stringify(manifest))).toBeLessThan(CLAUDE_PLUGIN_FILE_MAX_BYTES);
    writeInstalled({ "bundles@market": installPlugin("bundles", { manifest }) });
    const snapshot = await snapshotFor();
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MCP_MANAGEMENT_LIMITS.catalogMaxBytes,
    );
    expect(row(snapshot, "ordinary").actions.edit.supported).toBe(true);
    expect(snapshot.truncated).toBe(0);
    expect(pluginSources(snapshot)[0]!.note).toContain("10000 unsupported declarations omitted");
    expect(pluginSources(snapshot)[0]!.note).toContain("10000 occurrences");
    expect(utf8ByteLength(pluginSources(snapshot)[0]!.note!)).toBeLessThanOrEqual(1024);
  });

  test("source metadata is bounded before definition rows are fitted", async () => {
    fixture.write(
      "worktree/.mcp.json",
      JSON.stringify({ mcpServers: { ordinary: stdio("local") } }),
    );
    const snapshot = await snapshotFor();
    const template = snapshot.sources[0]!;
    snapshot.sources.push(
      ...Array.from({ length: 64 }, (_, index) => ({
        ...template,
        sourceId: `plugin-${index}`,
        scope: "plugin" as const,
        owner: "plugin" as const,
        label: "name".repeat(10_000),
        displayPath: "path".repeat(10_000),
        note: "reason".repeat(10_000),
      })),
    );
    snapshot.definitions = fitSnapshotBudget(snapshot, snapshot.definitions);
    expect(snapshot.definitions.some((definition) => definition.name === "ordinary")).toBe(true);
    expect(utf8ByteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      MCP_MANAGEMENT_LIMITS.catalogMaxBytes,
    );
  });

  test("retains final declarations and the actual override winner within the per-plugin bound", async () => {
    const files = Array.from({ length: 9 }, (_, index) => `servers-${index}.json`);
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs", mcpServers: files },
        mcpJson: { search: stdio("original") },
        extra: Object.fromEntries(
          files.map((file, index) => [file, { search: stdio(`override-${index}`) }]),
        ),
      }),
    });
    const snapshot = await snapshotFor();
    const sources = pluginSources(snapshot);
    expect(sources).toHaveLength(8);
    expect(sources[0]!.note).toContain("2 earlier MCP declaration sources omitted");
    expect(snapshot.freshness).toBe("incomplete");
    const winner = snapshot.definitions.find(
      (definition) => definition.entryId === snapshot.effective["plugin:docs:search"],
    )!;
    expect(winner.command).toEqual({ kind: "visible", value: "override-8" });
    expect(
      joinLiveMcpServer(snapshot, {
        provider: "claude",
        environmentId: "env-1",
        scope: "plugin",
        serverName: winner.name,
      }),
    ).toMatchObject({ kind: "plugin", entryId: winner.entryId });
  });

  test("a multi-source plugin consumes only the remaining global capacity and counts both omissions", async () => {
    const ids: Record<string, string> = {};
    for (let index = 0; index < 63; index += 1) {
      const name = `p${String(index).padStart(2, "0")}`;
      ids[`${name}@market`] = installPlugin(name, {
        manifest: { name },
        mcpJson: { a: stdio("a") },
      });
    }
    const files = Array.from({ length: 7 }, (_, index) => `servers-${index}.json`);
    ids["tail@market"] = installPlugin("tail", {
      manifest: { name: "tail", mcpServers: files },
      mcpJson: { a: stdio("original") },
      extra: Object.fromEntries(files.map((file, index) => [file, { a: stdio(`last-${index}`) }])),
    });
    ids["unchecked@market"] = installPlugin("unchecked", {
      manifest: { name: "unchecked" },
      mcpJson: { a: stdio("a") },
    });
    writeInstalled(ids);
    const snapshot = await snapshotFor();
    const sources = pluginSources(snapshot);
    expect(sources).toHaveLength(64);
    expect(sources.at(-1)!.note).toContain("7 earlier MCP declaration sources omitted");
    expect(sources.at(-1)!.note).toContain("1 more plugin folder");
    expect(row(snapshot, "plugin:tail:a").command).toEqual({ kind: "visible", value: "last-6" });
    expect(snapshot.freshness).toBe("incomplete");
  });

  test("duplicate and aliased declaration paths have unique IDs and keep their final position", async () => {
    writeInstalled({
      "docs@market": installPlugin("docs", {
        manifest: { name: "docs", mcpServers: ["a.json", "b.json", "./a.json", "a.json"] },
        extra: { "a.json": { search: stdio("a") }, "b.json": { search: stdio("b") } },
      }),
    });
    const snapshot = await snapshotFor();
    expect(pluginSources(snapshot)).toHaveLength(2);
    expect(new Set(snapshot.sources.map((source) => source.sourceId)).size).toBe(
      snapshot.sources.length,
    );
    expect(new Set(snapshot.definitions.map((definition) => definition.entryId)).size).toBe(
      snapshot.definitions.length,
    );
    const winner = snapshot.definitions.find(
      (definition) => definition.entryId === snapshot.effective["plugin:docs:search"],
    );
    expect(winner!.command).toEqual({ kind: "visible", value: "a" });
    for (const definition of snapshot.definitions)
      expect(definition.shadowedBy).not.toBe(definition.entryId);
  });

  test("oversized manifests name the size limit, not a JSON parse failure", async () => {
    const dir = installPlugin("large", { mcpJson: { a: stdio("a") } });
    fixture.write(
      `${path.relative(fixture.root, dir)}/.claude-plugin/plugin.json`,
      JSON.stringify({ name: "large", padding: "x".repeat(CLAUDE_PLUGIN_FILE_MAX_BYTES) }),
    );
    writeInstalled({ "large@market": dir });
    const snapshot = await snapshotFor();
    expect(pluginSources(snapshot)[0]!.note).toContain(
      `${CLAUDE_PLUGIN_FILE_MAX_BYTES}-byte plugin file size limit`,
    );
    expect(pluginSources(snapshot)[0]!.note).not.toContain("not valid JSON");
    expect(snapshot.freshness).toBe("incomplete");
  });

  test("a container lists the plugins in its own home", async () => {
    fixture.environment.environmentType = "containerized";
    fixture.environment.containerId = "container-1";
    const pluginDir = "/home/node/.claude/plugins/cache/market/docs/1.0.0";
    fixture.containerFiles.set(
      "/home/node/.claude/plugins/installed_plugins.json",
      JSON.stringify({
        version: 2,
        plugins: {
          "docs@market": [
            { installPath: "/Users/someone/.claude/plugins/cache/market/docs/1.0.0" },
          ],
        },
      }),
    );
    fixture.containerFiles.set(`${pluginDir}/.claude-plugin/plugin.json`, '{"name":"docs"}');
    fixture.containerFiles.set(`${pluginDir}/.mcp.json`, JSON.stringify({ a: stdio("a") }));
    // The container's copy of the user settings, as staged from the host.
    fixture.containerFiles.set(
      "/home/node/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@market": true } }),
    );
    const snapshot = await snapshotFor();
    expect(pluginSources(snapshot)[0]).toMatchObject({
      displayPath: `container:${pluginDir}/.mcp.json`,
      writable: false,
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
    });
    expect(row(snapshot, "plugin:docs:a")).toMatchObject({ status: "effective" });
    // Container sessions load project resources; `<worktree>` is /workspace.
    fixture.containerFiles.set(
      "/workspace/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@market": false } }),
    );
    expect(row(await snapshotFor(), "plugin:docs:a").statusReason).toBe(
      'Disabled: enabledPlugins["docs@market"] is false in <worktree>/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
    // Turned off in Claude Code: the container's sessions do not get it either.
    fixture.containerFiles.set(
      "/home/node/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@market": false } }),
    );
    fixture.containerFiles.delete("/workspace/.claude/settings.json");
    expect(row(await snapshotFor(), "plugin:docs:a").statusReason).toBe(
      'Disabled: enabledPlugins["docs@market"] is false in ~/.claude/settings.json, so Orkestrator does not pass this installed plugin to Claude Code.',
    );
  });
});

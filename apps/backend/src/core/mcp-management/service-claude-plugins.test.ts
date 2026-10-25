import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { McpManagementSnapshot } from "@orkestrator/protocol/mcp-management";

import { CLAUDE_PLUGIN_READ_ONLY_REASON } from "./claude-plugins.js";
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

afterEach(() => {
  fixture.cleanup();
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

function writeInstalled(ids: Record<string, string>): void {
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
    const plugins = {
      off: installPlugin("off", { manifest: { name: "off" }, mcpJson: { a: stdio("a") } }),
      quiet: installPlugin("quiet", {
        manifest: { name: "quiet", defaultEnabled: false },
        mcpJson: { a: stdio("a") },
      }),
      local: installPlugin("local", { manifest: { name: "local" }, mcpJson: { a: stdio("a") } }),
    };
    writeInstalled({
      "off@market": plugins.off,
      "quiet@market": plugins.quiet,
      "local@market": plugins.local,
    });
    fixture.write(
      "home/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "OFF@inline": false } }),
    );
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
    expect(localSource.note).toContain('"Include local settings" on do not load this plugin');
  });

  test("user settings come from CLAUDE_CONFIG_DIR when the backend sets it, as the CLI reads them", async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), "mcp-claude-config-"));
    try {
      fixture.cleanup();
      fixture = createFixture({ env: { CLAUDE_CONFIG_DIR: configDir } });
      writeInstalled({
        "docs@market": installPlugin("docs", {
          manifest: { name: "docs" },
          mcpJson: { a: stdio("a") },
        }),
      });
      // The bridge's plugin set still comes from ~/.claude; only the settings move.
      fixture.write(
        "home/.claude/settings.json",
        JSON.stringify({ enabledPlugins: { "docs@inline": false } }),
      );
      expect(row(await snapshotFor(), "plugin:docs:a").status).toBe("effective");
      writeFileSync(
        path.join(configDir, "settings.json"),
        JSON.stringify({ enabledPlugins: { "docs@inline": false } }),
      );
      const snapshot = await snapshotFor();
      expect(row(snapshot, "plugin:docs:a").status).toBe("disabled");
      expect(row(snapshot, "plugin:docs:a").statusReason).toContain(`${configDir}/settings.json`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a marketplace id does not turn off the copy Orkestrator passes, and an enabled installed copy still loads", async () => {
    const docs = installPlugin("docs", { manifest: { name: "docs" }, mcpJson: { a: stdio("a") } });
    const notes = installPlugin("notes", {
      manifest: { name: "notes" },
      mcpJson: { a: stdio("a") },
    });
    writeInstalled({ "docs@market": docs, "notes@market": notes });
    fixture.write(
      "home/.claude/settings.json",
      JSON.stringify({
        enabledPlugins: { "docs@market": false, "notes@inline": false, "notes@market": true },
      }),
    );
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
    fixture.containerFiles.set(
      "/workspace/.claude/settings.json",
      JSON.stringify({ enabledPlugins: { "docs@inline": false } }),
    );
    const snapshot = await snapshotFor();
    expect(pluginSources(snapshot)[0]).toMatchObject({
      displayPath: `container:${pluginDir}/.mcp.json`,
      writable: false,
      readOnlyReason: CLAUDE_PLUGIN_READ_ONLY_REASON,
    });
    expect(row(snapshot, "plugin:docs:a")).toMatchObject({ status: "disabled" });
    // Container sessions load project resources; `<worktree>` is /workspace.
    expect(row(snapshot, "plugin:docs:a").statusReason).toContain(
      "<worktree>/.claude/settings.json",
    );
  });
});

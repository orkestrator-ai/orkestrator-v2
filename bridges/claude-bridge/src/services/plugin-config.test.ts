import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InstalledPluginsFile } from "../types/plugins.js";
import {
  getMergedPlugins,
  getPluginInfo,
  getPluginsForSdk,
  loadCliInstalledPlugins,
  loadGlobalPlugins,
  loadProjectOverridesFromGlobal,
  loadProjectPlugins,
  readPluginManifest,
  remapInstalledPlugins,
} from "./plugin-config.js";
import { claudeUserSettingsPath, setClaudeHomeForTesting } from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";

const PLUGINS_DIR = "/home/node/.claude/plugins";

function installed(plugins: InstalledPluginsFile["plugins"]): InstalledPluginsFile {
  return { version: 1, plugins };
}

function entry(installPath: string) {
  return {
    scope: "user",
    installPath,
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00Z",
    lastUpdated: "2026-01-01T00:00:00Z",
    gitCommitSha: "abc123",
  };
}

describe("remapInstalledPlugins", () => {
  test("rebases a host-absolute path onto the local plugins dir", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        market: [entry("/Users/alice/.claude/plugins/marketplaces/foo")],
      }),
    );

    expect(result).toEqual([
      {
        type: "local",
        path: "/home/node/.claude/plugins/marketplaces/foo",
        installedId: "market",
      },
    ]);
  });

  test("passes through paths that lack the .claude/plugins marker unchanged", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({ custom: [entry("/opt/custom/my-plugin")] }),
    );

    expect(result).toEqual([
      { type: "local", path: "/opt/custom/my-plugin", installedId: "custom" },
    ]);
  });

  test("drops entries whose rebased path escapes the plugins dir (traversal)", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        evil: [
          entry("/x/.claude/plugins/../../../../../../../etc/passwd"),
          entry("/Users/bob/.claude/plugins/marketplaces/safe"),
        ],
      }),
    );

    // Only the safe, in-bounds entry survives; the traversal entry is skipped.
    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/safe", installedId: "evil" },
    ]);
  });

  test("flattens every entry across every plugin group", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        groupA: [
          entry("/Users/a/.claude/plugins/marketplaces/one"),
          entry("/Users/a/.claude/plugins/marketplaces/two"),
        ],
        groupB: [entry("/opt/external/three")],
      }),
    );

    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/one", installedId: "groupA" },
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/two", installedId: "groupA" },
      { type: "local", path: "/opt/external/three", installedId: "groupB" },
    ]);
  });

  test("returns an empty array when there are no installed plugins", () => {
    expect(remapInstalledPlugins(PLUGINS_DIR, installed({}))).toEqual([]);
  });
});

/**
 * These loaders read `~/.claude.json` and `~/.claude/plugins/`, which belong
 * to whoever is running the suite — so they are pointed at a scratch home
 * instead. Everything below exercises the real directory walking and the real
 * slice cache.
 */
describe("plugin config resolution", () => {
  let home: string;
  let cwd: string;

  const writeClaudeJson = (value: unknown) =>
    writeFile(join(home, ".claude.json"), JSON.stringify(value));

  /** Create a plugin directory complete with the manifest that makes it real. */
  const makePlugin = async (path: string, manifest?: { name?: string; description?: string }) => {
    await mkdir(join(path, ".claude-plugin"), { recursive: true });
    if (manifest) {
      await writeFile(join(path, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
    }
    return path;
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "claude-bridge-plugin-home-"));
    cwd = await mkdtemp(join(tmpdir(), "claude-bridge-plugin-project-"));
    setClaudeHomeForTesting(home);
    clearJsonFileCache();
  });

  afterEach(async () => {
    setClaudeHomeForTesting(null);
    await rm(home, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
    clearJsonFileCache();
  });

  test("returns empty lists when nothing is configured", async () => {
    expect(await loadGlobalPlugins()).toEqual([]);
    expect(await loadProjectPlugins(cwd)).toEqual([]);
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([]);
    expect(await loadCliInstalledPlugins()).toEqual([]);
    expect(await getMergedPlugins(cwd)).toEqual([]);
  });

  test("loads global and project-entry plugins from their own slices", async () => {
    await writeClaudeJson({
      plugins: [{ type: "local", path: "/opt/global-plugin" }],
      projects: { [cwd]: { plugins: [{ type: "local", path: "/opt/entry-plugin" }] } },
    });

    expect(await loadGlobalPlugins()).toEqual([{ type: "local", path: "/opt/global-plugin" }]);
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([
      { type: "local", path: "/opt/entry-plugin" },
    ]);
  });

  test("does not serve one project's plugin overrides to another", async () => {
    const otherCwd = "/somewhere/else";
    await writeClaudeJson({
      projects: {
        [cwd]: { plugins: [{ type: "local", path: "/opt/mine" }] },
        [otherCwd]: { plugins: [{ type: "local", path: "/opt/theirs" }] },
      },
    });

    // Both slices come from the same file; a shared cache key would cross them.
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([
      { type: "local", path: "/opt/mine" },
    ]);
    expect(await loadProjectOverridesFromGlobal(otherCwd)).toEqual([
      { type: "local", path: "/opt/theirs" },
    ]);
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([
      { type: "local", path: "/opt/mine" },
    ]);
  });

  test("loads project plugins from .claude/plugins.json", async () => {
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "plugins.json"),
      JSON.stringify({ plugins: [{ type: "local", path: "/opt/project-plugin" }] }),
    );

    expect(await loadProjectPlugins(cwd)).toEqual([{ type: "local", path: "/opt/project-plugin" }]);
  });

  test("remaps CLI-installed plugins recorded with host-absolute paths", async () => {
    const pluginsDir = join(home, ".claude", "plugins");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify(
        installed({ market: [entry("/Users/alice/.claude/plugins/marketplaces/foo")] }),
      ),
    );

    expect(await loadCliInstalledPlugins()).toEqual([
      { type: "local", path: join(pluginsDir, "marketplaces", "foo"), installedId: "market" },
    ]);
  });

  test("passes an install only when Claude Code's own settings for the session enable it", async () => {
    const pluginsDir = join(home, ".claude", "plugins");
    const dir = (name: string) => join(pluginsDir, "cache", "m", name, "1.0.0");
    const ids = ["on", "off", "unnamed", "project-off", "local-on"];
    for (const name of ids) await makePlugin(dir(name), { name });
    await writeFile(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify(
        installed(
          Object.fromEntries(
            ids.map((name) => [
              `${name}@m`,
              // Recorded on another machine, as a container's copy is.
              [entry(`/Users/alice/.claude/plugins/cache/m/${name}/1.0.0`)],
            ]),
          ),
        ),
      ),
    );
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        enabledPlugins: {
          "on@m": true,
          "off@m": false,
          // Only the install's own id applies, never `@inline`.
          "unnamed@inline": true,
          "project-off@m": true,
        },
      }),
    );
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "project-off@m": false } }),
    );
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "local-on@m": true } }),
    );
    const paths = async (includeProjectSources: boolean, sources?: string[]) =>
      (await getPluginsForSdk(cwd, includeProjectSources, sources)).map((plugin) => plugin.path);

    expect(await paths(false, ["user"])).toEqual([dir("on"), dir("project-off")]);
    // The defaults are the sources a session loads without local settings.
    expect(await paths(false)).toEqual([dir("on"), dir("project-off")]);
    expect(await paths(true)).toEqual([dir("on")]);
    expect(await paths(true, ["user", "project", "local"])).toEqual([dir("on"), dir("local-on")]);
    // A coordinator loads no settings sources, so no install is passed.
    expect(await paths(true, [])).toEqual([]);

    // Turning a plugin off in Claude Code reaches the next turn.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "on@m": false, "project-off@m": true } }),
    );
    expect(await paths(false, ["user"])).toEqual([dir("project-off")]);
  });

  test("reads user settings from CLAUDE_CONFIG_DIR as the CLI does, but never in a test home", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "claude-bridge-config-dir-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    try {
      process.env.CLAUDE_CONFIG_DIR = configDir;
      // A test home ignores the environment, so the developer's settings stay unread.
      expect(claudeUserSettingsPath()).toBe(join(home, ".claude", "settings.json"));
      setClaudeHomeForTesting(null);
      expect(claudeUserSettingsPath()).toBe(join(configDir, "settings.json"));
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  test("the /plugins display excludes turned-off, never-enabled and local-only installs by default", async () => {
    const pluginsDir = join(home, ".claude", "plugins");
    const plugins: InstalledPluginsFile["plugins"] = {};
    for (const id of ["on", "off", "never", "local-only"]) {
      const plugin = await makePlugin(join(pluginsDir, id), { name: id });
      plugins[`${id}@market`] = [entry(plugin)];
    }
    await writeFile(join(pluginsDir, "installed_plugins.json"), JSON.stringify(installed(plugins)));
    await writeFile(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ enabledPlugins: { "on@market": true, "off@market": false } }),
    );
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "settings.local.json"),
      JSON.stringify({ enabledPlugins: { "local-only@market": true } }),
    );
    expect(await getMergedPlugins(cwd)).toEqual([{ type: "local", path: join(pluginsDir, "on") }]);
    expect(await getPluginInfo(cwd)).toEqual([
      {
        name: "on",
        path: join(pluginsDir, "on"),
        source: "cli",
        enabled: true,
        description: undefined,
      },
    ]);
    expect(await getMergedPlugins(cwd, true, ["user", "project", "local"])).toEqual([
      { type: "local", path: join(pluginsDir, "on") },
      { type: "local", path: join(pluginsDir, "local-only") },
    ]);
  });

  test("falls back to scanning the plugins directory when the manifest file is absent", async () => {
    const pluginsDir = join(home, ".claude", "plugins");
    const scanned = await makePlugin(join(pluginsDir, "scanned"), { name: "scanned" });
    // A directory without a manifest is not a plugin and must be ignored.
    await mkdir(join(pluginsDir, "not-a-plugin"), { recursive: true });

    expect(await loadCliInstalledPlugins()).toEqual([{ type: "local", path: scanned }]);
  });

  test("deduplicates by resolved path, with the highest-priority source winning", async () => {
    // The same path from two sources must appear once. Relative and `~` paths
    // resolve before comparison, so they collide with their absolute forms.
    await writeClaudeJson({
      plugins: [{ type: "local", path: "~/shared-plugin" }],
      projects: { [cwd]: { plugins: [{ type: "local", path: join(home, "shared-plugin") }] } },
    });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "plugins.json"),
      JSON.stringify({ plugins: [{ type: "local", path: "relative-plugin" }] }),
    );

    expect(await getMergedPlugins(cwd)).toEqual([
      { type: "local", path: join(home, "shared-plugin") },
      { type: "local", path: join(cwd, "relative-plugin") },
    ]);
  });

  test("keeps only plugins whose directory actually exists", async () => {
    const real = await makePlugin(join(cwd, "real-plugin"), { name: "real" });
    await writeClaudeJson({
      plugins: [
        { type: "local", path: real },
        { type: "local", path: join(cwd, "missing-plugin") },
      ],
    });

    expect(await getPluginsForSdk(cwd)).toEqual([{ type: "local", path: real }]);
  });

  test("excludes project plugin sources while retaining global plugins", async () => {
    const global = await makePlugin(join(home, "global-plugin"), { name: "global" });
    const projectEntry = await makePlugin(join(cwd, "entry-plugin"), { name: "entry" });
    const projectFile = await makePlugin(join(cwd, "file-plugin"), { name: "file" });
    await writeClaudeJson({
      plugins: [{ type: "local", path: global }],
      projects: { [cwd]: { plugins: [{ type: "local", path: projectEntry }] } },
    });
    await mkdir(join(cwd, ".claude"), { recursive: true });
    await writeFile(
      join(cwd, ".claude", "plugins.json"),
      JSON.stringify({ plugins: [{ type: "local", path: projectFile }] }),
    );

    expect(await getPluginsForSdk(cwd, false)).toEqual([{ type: "local", path: global }]);
  });

  test("reads a plugin manifest, defaulting the name to the directory", async () => {
    const named = await makePlugin(join(cwd, "named"), {
      name: "declared-name",
      description: "does things",
    });
    const unnamed = await makePlugin(join(cwd, "unnamed"), {});
    const bare = await makePlugin(join(cwd, "bare"));

    expect(await readPluginManifest(named)).toEqual({
      name: "declared-name",
      description: "does things",
    });
    expect(await readPluginManifest(unnamed)).toEqual({
      name: "unnamed",
      description: undefined,
    });
    // No manifest file at all is a different answer from an empty manifest.
    expect(await readPluginManifest(bare)).toBeNull();
  });

  test("picks up an edit made while the bridge is running", async () => {
    await writeClaudeJson({ plugins: [{ type: "local", path: "/opt/before" }] });
    expect(await loadGlobalPlugins()).toEqual([{ type: "local", path: "/opt/before" }]);

    // Past coarse mtime granularity; the size differs here too.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeClaudeJson({ plugins: [{ type: "local", path: "/opt/after-edit" }] });

    expect(await loadGlobalPlugins()).toEqual([{ type: "local", path: "/opt/after-edit" }]);
  });

  test("treats a malformed config file as absent rather than failing the turn", async () => {
    await writeFile(join(home, ".claude.json"), "{ not json");

    expect(await loadGlobalPlugins()).toEqual([]);
    expect(await getMergedPlugins(cwd)).toEqual([]);
  });
});

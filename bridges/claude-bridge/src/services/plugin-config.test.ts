import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InstalledPluginsFile } from "../types/plugins.js";
import {
  getMergedPlugins,
  getPluginsForSdk,
  loadCliInstalledPlugins,
  loadGlobalPlugins,
  loadProjectOverridesFromGlobal,
  loadProjectPlugins,
  readPluginManifest,
  remapInstalledPlugins,
} from "./plugin-config.js";
import { setClaudeHomeForTesting } from "./claude-home.js";
import { clearJsonFileCache } from "./json-file-cache.js";

const PLUGINS_DIR = "/home/node/.claude/plugins";

function installed(
  plugins: InstalledPluginsFile["plugins"]
): InstalledPluginsFile {
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
      })
    );

    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/foo" },
    ]);
  });

  test("passes through paths that lack the .claude/plugins marker unchanged", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({ custom: [entry("/opt/custom/my-plugin")] })
    );

    expect(result).toEqual([{ type: "local", path: "/opt/custom/my-plugin" }]);
  });

  test("drops entries whose rebased path escapes the plugins dir (traversal)", () => {
    const result = remapInstalledPlugins(
      PLUGINS_DIR,
      installed({
        evil: [
          entry("/x/.claude/plugins/../../../../../../../etc/passwd"),
          entry("/Users/bob/.claude/plugins/marketplaces/safe"),
        ],
      })
    );

    // Only the safe, in-bounds entry survives; the traversal entry is skipped.
    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/safe" },
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
      })
    );

    expect(result).toEqual([
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/one" },
      { type: "local", path: "/home/node/.claude/plugins/marketplaces/two" },
      { type: "local", path: "/opt/external/three" },
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
  const makePlugin = async (
    path: string,
    manifest?: { name?: string; description?: string },
  ) => {
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
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([{ type: "local", path: "/opt/mine" }]);
    expect(await loadProjectOverridesFromGlobal(otherCwd)).toEqual([
      { type: "local", path: "/opt/theirs" },
    ]);
    expect(await loadProjectOverridesFromGlobal(cwd)).toEqual([{ type: "local", path: "/opt/mine" }]);
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
      JSON.stringify(installed({ market: [entry("/Users/alice/.claude/plugins/marketplaces/foo")] })),
    );

    expect(await loadCliInstalledPlugins()).toEqual([
      { type: "local", path: join(pluginsDir, "marketplaces", "foo") },
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

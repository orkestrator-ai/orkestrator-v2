import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MCP_MANAGEMENT_LIMITS } from "@orkestrator/protocol/mcp-management";

import { existsSync } from "node:fs";
import path from "node:path";

import { setClaudeHomeForTesting } from "../../../../../bridges/claude-bridge/src/services/claude-home.js";
import { clearJsonFileCache } from "../../../../../bridges/claude-bridge/src/services/json-file-cache.js";
import { getPluginsForSdk } from "../../../../../bridges/claude-bridge/src/services/plugin-config.js";
import { createFixture, targetIdFor, type Fixture } from "./test-support.js";

/**
 * The editor lists exactly the plugins the Claude bridge passes to the CLI,
 * plus the installs it leaves out because Claude Code's settings turn them
 * off, which it lists disabled with that reason. Both build the set through
 * `@orkestrator/protocol/node/claude-plugin-set`; this runs the bridge's own
 * `getPluginsForSdk` and the catalogue over the same files, with project
 * resources on and off, so neither side's reads can drift. Whether the CLI
 * then loads each plugin is proven against the pinned CLI by
 * `apps/backend/tests/claude-plugin-mcp-live.test.ts`.
 */

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture({ env: {} });
  clearJsonFileCache();
  setClaudeHomeForTesting(fixture.home);
});

afterEach(() => {
  setClaudeHomeForTesting(null);
  clearJsonFileCache();
  fixture.cleanup();
});

interface ParityFixture {
  name: string;
  /** Files relative to the fixture root (`home/…`, `worktree/…`); `{HOME}` and `{WORKTREE}` expand. */
  files: Record<string, unknown>;
}

const mcp = (server: string) => ({ mcpServers: { [server]: { command: server } } });

/** A plugin folder holding `.mcp.json`, and optionally a manifest. */
function plugin(dir: string, name?: string): Record<string, unknown> {
  return {
    [`${dir}/.mcp.json`]: mcp("s"),
    ...(name ? { [`${dir}/.claude-plugin/plugin.json`]: { name } } : {}),
  };
}

const FIXTURES: ParityFixture[] = [
  {
    name: "installed plugins, host paths remapped onto the local plugins folder",
    files: {
      "home/.claude/plugins/installed_plugins.json": {
        version: 2,
        plugins: {
          "a@m": [{ installPath: "/Users/someone/.claude/plugins/cache/m/a/1.0.0" }],
          "b@m": [
            { installPath: "/Users/someone/.claude/plugins/cache/m/b/1.0.0" },
            { installPath: "/elsewhere/.claude/plugins/../../../../etc" },
          ],
        },
      },
      "home/.claude/settings.json": { enabledPlugins: { "a@m": true, "b@m": true } },
      ...plugin("home/.claude/plugins/cache/m/a/1.0.0", "a"),
      ...plugin("home/.claude/plugins/cache/m/b/1.0.0", "b"),
    },
  },
  {
    name: "installs Claude Code's settings turn off, or never enable, are not passed",
    files: {
      "home/.claude/plugins/installed_plugins.json": {
        version: 2,
        plugins: {
          "on@m": [{ installPath: "/Users/someone/.claude/plugins/cache/m/on/1.0.0" }],
          "off@m": [{ installPath: "/Users/someone/.claude/plugins/cache/m/off/1.0.0" }],
          "unnamed@m": [{ installPath: "/Users/someone/.claude/plugins/cache/m/unnamed/1.0.0" }],
          "project-off@m": [
            { installPath: "/Users/someone/.claude/plugins/cache/m/project-off/1.0.0" },
          ],
          "project-on@m": [
            { installPath: "/Users/someone/.claude/plugins/cache/m/project-on/1.0.0" },
          ],
        },
      },
      "home/.claude/settings.json": {
        enabledPlugins: {
          "on@m": true,
          "off@m": false,
          // The @inline id does not enable an install.
          "unnamed@inline": true,
          "project-off@m": true,
        },
      },
      "worktree/.claude/settings.json": {
        enabledPlugins: { "project-off@m": false, "project-on@m": true },
      },
      // Only "Include local settings" loads these; the default session does not.
      "worktree/.claude/settings.local.json": { enabledPlugins: { "on@m": false } },
      ...plugin("home/.claude/plugins/cache/m/on/1.0.0", "on"),
      ...plugin("home/.claude/plugins/cache/m/off/1.0.0", "off"),
      ...plugin("home/.claude/plugins/cache/m/unnamed/1.0.0", "unnamed"),
      ...plugin("home/.claude/plugins/cache/m/project-off/1.0.0", "project-off"),
      ...plugin("home/.claude/plugins/cache/m/project-on/1.0.0", "project-on"),
    },
  },
  {
    name: "no installed_plugins.json: the plugins folder scan",
    files: {
      ...plugin("home/.claude/plugins/scanned", "scanned"),
      // No manifest: the scan skips it.
      "home/.claude/plugins/bare/.mcp.json": mcp("s"),
    },
  },
  {
    name: "an unreadable installed_plugins.json falls back to the scan",
    files: {
      "home/.claude/plugins/installed_plugins.json": "{ broken",
      ...plugin("home/.claude/plugins/scanned", "scanned"),
    },
  },
  {
    name: "every layer, de-duplicated, relative and ~ paths, missing folders",
    files: {
      "home/.claude.json": {
        plugins: [
          { type: "local", path: "~/mine" },
          { type: "local", path: "{WORKTREE}/shared" },
          { type: "local", path: "/does/not/exist" },
        ],
        projects: {
          "{WORKTREE}": { plugins: [{ type: "local", path: "rel" }, { path: "~/mine" }] },
        },
      },
      "worktree/.claude/plugins.json": {
        plugins: [
          { type: "local", path: "./local" },
          { type: "local", path: "./shared" },
        ],
      },
      ...plugin("home/mine", "mine"),
      ...plugin("worktree/shared", "shared"),
      ...plugin("worktree/rel"),
      ...plugin("worktree/local", "local"),
      // Listed but declares no servers: passed to the CLI, not listed here.
      "home/.claude/plugins/installed_plugins.json": {
        plugins: { "quiet@m": [{ installPath: "{HOME}/quiet" }] },
      },
      "home/.claude/settings.json": { enabledPlugins: { "quiet@m": true } },
      "home/quiet/README.md": "no servers",
    },
  },
  {
    name: "malformed plugin lists are skipped",
    files: {
      "home/.claude.json": { plugins: { path: "/not-a-list" } },
      "worktree/.claude/plugins.json": { plugins: ["x", { path: 3 }, { path: "./ok" }] },
      ...plugin("worktree/ok", "ok"),
    },
  },
];

function materialise(files: ParityFixture["files"]): void {
  for (const [relative, content] of Object.entries(files)) {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    fixture.write(
      relative,
      text.replaceAll("{HOME}", fixture.home).replaceAll("{WORKTREE}", fixture.worktree),
    );
  }
}

/** What the bridge passes, limited to plugins that declare servers. */
async function bridgePlugins(projectResources: boolean): Promise<string[]> {
  // The settings sources a default session loads (`claudeSettingSources`).
  const plugins = await getPluginsForSdk(
    fixture.worktree,
    projectResources,
    projectResources ? ["user", "project"] : ["user"],
  );
  return plugins
    .map((entry) => entry.path)
    .filter(
      (dir) =>
        existsSync(path.join(dir, ".mcp.json")) ||
        existsSync(path.join(dir, ".claude-plugin", "plugin.json")),
    );
}

/** Installs the editor lists only to say Orkestrator leaves them out. */
const NOT_PASSED = "so Orkestrator does not pass this installed plugin";

/** The plugin folders the catalogue lists as passed, in order, from its display paths. */
async function cataloguePlugins(): Promise<string[]> {
  const snapshot = await fixture.service.snapshot({
    targetId: await targetIdFor(fixture, "claude", "environment"),
  });
  const dirs: string[] = [];
  for (const source of snapshot.sources) {
    if (source.scope !== "plugin") continue;
    const rows = snapshot.definitions.filter((row) => row.sourceId === source.sourceId);
    if (rows.length && rows.every((row) => row.statusReason?.includes(NOT_PASSED))) continue;
    const shown = source.displayPath
      .replace(/^~/, fixture.home)
      .replace(/^<worktree>/, fixture.worktree);
    const dir = shown.endsWith("/.claude-plugin/plugin.json")
      ? path.dirname(path.dirname(shown))
      : path.dirname(shown);
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

describe("the catalogue lists exactly the plugins the Claude bridge passes", () => {
  test("an oversized .claude.json reports the plugin layer the bridge can still read", async () => {
    materialise({
      "home/.claude.json": {
        padding: "x".repeat(MCP_MANAGEMENT_LIMITS.sourceFileMaxBytes),
        plugins: [{ path: "~/mine" }],
      },
      ...plugin("home/mine", "mine"),
    });
    expect(await bridgePlugins(false)).toEqual([path.join(fixture.home, "mine")]);
    const snapshot = await fixture.service.snapshot({
      targetId: await targetIdFor(fixture, "claude", "environment"),
    });
    expect(
      snapshot.sources.find((source) => source.sourceId === "claude:plugin-discovery"),
    ).toMatchObject({ state: "oversized" });
    expect(
      snapshot.sources.find((source) => source.sourceId === "claude:plugin-discovery")!.note,
    ).toContain("Global and project plugin layers may be missing");
    expect(snapshot.freshness).toBe("incomplete");
  });

  test("installs pass by Claude Code's own settings, in the layers sessions load", async () => {
    materialise(FIXTURES.find((config) => config.name.startsWith("installs Claude Code"))!.files);
    const cache = (name: string) =>
      path.join(fixture.home, ".claude/plugins/cache/m", name, "1.0.0");
    expect(await bridgePlugins(false)).toEqual([cache("on"), cache("project-off")]);
    expect(await bridgePlugins(true)).toEqual([cache("on"), cache("project-on")]);
    // "Include local settings" adds the local layer, which turns "on" off.
    const withLocal = await getPluginsForSdk(fixture.worktree, true, ["user", "project", "local"]);
    expect(withLocal.map((entry) => entry.path)).toEqual([cache("project-on")]);
    // A coordinator loads no settings, so no install is passed.
    expect(await getPluginsForSdk(fixture.worktree, true, [])).toEqual([]);
  });

  for (const config of FIXTURES) {
    for (const projectResources of [false, true]) {
      test(`project resources ${projectResources ? "on" : "off"}: ${config.name}`, async () => {
        fixture.environment.agentSettings = { executionPolicy: { projectResources } };
        materialise(config.files);
        const bridge = await bridgePlugins(projectResources);
        // Every fixture lists at least one plugin once project resources are on.
        if (projectResources) expect(bridge.length).toBeGreaterThan(0);
        expect(await cataloguePlugins()).toEqual(bridge);
      });
    }
  }
});

import { describe, expect, test } from "bun:test";

import {
  claudeInlinePluginEnablement,
  claudeInstalledPluginEnablement,
  claudePluginConfigList,
  claudePluginMcpDeclarations,
  claudePluginName,
  claudePluginServerName,
  mergeClaudePluginLayers,
  remapInstalledPlugins,
} from "./claude-plugin-set";

const HOME = "/home/node";
const CWD = "/workspace";

describe("the bridge's plugin set", () => {
  test("keeps only entries with a string path", () => {
    expect(
      claudePluginConfigList([{ path: "/a" }, { path: 3 }, "x", null, { type: "local", path: "" }]),
    ).toEqual([{ type: "local", path: "/a" }]);
    expect(claudePluginConfigList({ path: "/a" })).toEqual([]);
  });

  test("remaps install paths and drops traversal and malformed entries", () => {
    const unsafe: string[] = [];
    expect(
      remapInstalledPlugins(
        `${HOME}/.claude/plugins`,
        {
          plugins: {
            "a@m": [{ installPath: "/Users/x/.claude/plugins/cache/m/a/1.0.0" }],
            "b@m": [{ installPath: "/x/.claude/plugins/../../../etc" }],
            "c@m": [{ installPath: "/opt/c" }, { installPath: 4 }],
            "d@m": "nope",
          },
        },
        (installPath) => unsafe.push(installPath),
      ),
    ).toEqual([
      { type: "local", path: `${HOME}/.claude/plugins/cache/m/a/1.0.0` },
      { type: "local", path: "/opt/c" },
    ]);
    expect(unsafe).toEqual(["/x/.claude/plugins/../../../etc"]);
    expect(remapInstalledPlugins(`${HOME}/.claude/plugins`, { plugins: [] })).toEqual([]);
  });

  test("merges global < installed < project layers, first position wins, project only when loaded", () => {
    const layers = {
      global: [{ path: "~/g" }, { path: "/shared" }],
      cliInstalled: [{ type: "local" as const, path: "/i" }],
      projectGlobal: [{ path: "rel" }, { path: "/shared" }],
      projectLocal: [{ path: "/p" }, { path: `${HOME}/g` }],
    };
    expect(
      mergeClaudePluginLayers(layers, { cwd: CWD, home: HOME, includeProjectSources: true }),
    ).toEqual([`${HOME}/g`, "/shared", "/i", `${CWD}/rel`, "/p"]);
    expect(
      mergeClaudePluginLayers(layers, { cwd: CWD, home: HOME, includeProjectSources: false }),
    ).toEqual([`${HOME}/g`, "/shared", "/i"]);
  });
});

describe("the pinned CLI's rules for a --plugin-dir plugin", () => {
  test("names the plugin from its manifest, else its folder, and refuses names the CLI refuses", () => {
    expect(claudePluginName({ name: "docs" }, "/p/folder")).toBe("docs");
    expect(claudePluginName({}, "/p/folder/")).toBe("folder");
    expect(claudePluginName(null, "/p/folder")).toBe("folder");
    for (const bad of ["a@b", "a:b", "a b", "a/b", "a​b", "a\u0007b"])
      expect(claudePluginName({ name: bad }, "/p/x")).toBeNull();
    expect(claudePluginServerName("docs", "search")).toBe("plugin:docs:search");
  });

  test("the first loaded layer naming <name>@inline decides, without case", () => {
    const settings = {
      local: { enabledPlugins: { "docs@inline": true } },
      project: { enabledPlugins: { "Docs@Inline": false } },
      user: { enabledPlugins: { "docs@inline": true } },
    };
    expect(claudeInlinePluginEnablement("docs", {}, settings, ["project", "user"])).toEqual({
      enabled: false,
      decidedBy: { source: "project", key: "Docs@Inline" },
    });
    expect(
      claudeInlinePluginEnablement("docs", {}, settings, ["local", "project", "user"]),
    ).toEqual({ enabled: true, decidedBy: { source: "local", key: "docs@inline" } });
    expect(claudeInlinePluginEnablement("docs", {}, settings, ["user"]).enabled).toBe(true);
  });

  test("only false turns an @inline id off, and false wins within one layer", () => {
    const one = (value: unknown) =>
      claudeInlinePluginEnablement(
        "docs",
        {},
        { user: { enabledPlugins: { "docs@inline": value } } },
        ["user"],
      ).enabled;
    expect(one(true)).toBe(true);
    expect(one("yes")).toBe(true);
    expect(one(["x"])).toBe(true);
    expect(one(false)).toBe(false);
    expect(
      claudeInlinePluginEnablement(
        "docs",
        {},
        { user: { enabledPlugins: { "docs@inline": true, "DOCS@inline": false } } },
        ["user"],
      ).enabled,
    ).toBe(false);
  });

  test("a marketplace id never applies; the manifest default decides when nothing names it", () => {
    const settings = { user: { enabledPlugins: { "docs@market": false } } };
    expect(claudeInlinePluginEnablement("docs", {}, settings, ["user"])).toEqual({ enabled: true });
    expect(
      claudeInlinePluginEnablement("docs", { defaultEnabled: false }, settings, ["user"]),
    ).toEqual({ enabled: false, defaultDisabled: true });
    expect(
      claudeInlinePluginEnablement(
        "docs",
        { defaultEnabled: false },
        { user: { enabledPlugins: { "docs@inline": true } } },
        ["user"],
      ).enabled,
    ).toBe(true);
  });

  test("Claude Code's own installed copy loads when its exact id is true in the deciding layer", () => {
    const installed = ["docs@market", "other@market", "docs@inline"];
    expect(
      claudeInstalledPluginEnablement(
        "docs",
        installed,
        { user: { enabledPlugins: { "docs@market": true } } },
        ["user"],
      ),
    ).toEqual({ id: "docs@market", source: "user" });
    // A higher layer that names the id decides, even to turn it off.
    expect(
      claudeInstalledPluginEnablement(
        "docs",
        installed,
        {
          project: { enabledPlugins: { "docs@market": false } },
          user: { enabledPlugins: { "docs@market": true } },
        },
        ["project", "user"],
      ),
    ).toBeUndefined();
    // Not installed, or only a truthy non-boolean: not loaded.
    expect(
      claudeInstalledPluginEnablement(
        "docs",
        [],
        { user: { enabledPlugins: { "docs@market": true } } },
        ["user"],
      ),
    ).toBeUndefined();
    expect(
      claudeInstalledPluginEnablement(
        "docs",
        installed,
        { user: { enabledPlugins: { "docs@market": "yes" } } },
        ["user"],
      ),
    ).toBeUndefined();
  });

  test("lists MCP declarations in the CLI's merge order", () => {
    expect(claudePluginMcpDeclarations({})).toEqual([
      { kind: "file", relativePath: ".mcp.json", origin: ".mcp.json" },
    ]);
    expect(claudePluginMcpDeclarations({ mcpServers: { a: {} } })[1]).toEqual({
      kind: "inline-manifest",
    });
    expect(claudePluginMcpDeclarations({ mcpServers: "./servers.json" })[1]).toEqual({
      kind: "file",
      relativePath: "./servers.json",
      origin: "manifest",
    });
    const list = claudePluginMcpDeclarations({
      mcpServers: ["a.json", "bundle.mcpb", "https://x/y.dxt", { b: {} }],
    });
    expect(list.map((item) => item.kind)).toEqual([
      "file",
      "file",
      "unmodelled",
      "unmodelled",
      "unmodelled",
    ]);
  });
});

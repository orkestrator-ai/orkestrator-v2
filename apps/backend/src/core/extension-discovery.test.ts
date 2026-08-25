import { describe, expect, test } from "bun:test";
import {
  createExtensionDiscoveryCache,
  discoverAgentExtensions,
  parseClaudeMcpList,
  parseClaudePlugins,
  parseCodexMcpList,
  parseCodexPlugins,
  parseCursorMcpList,
  parseCursorPlugins,
  parseGrokMcpList,
  parseGrokPlugins,
  parseOpenCodeConfig,
  parseOpenCodeMcpServers,
  parseOpenCodePlugins,
  type AgentExtensionCatalog,
  type AgentExtensionId,
} from "./extension-discovery.js";

/** Answers from a fixed `<command> <args...>` -> stdout table; throws otherwise. */
function fixtureRunner(responses: Record<string, string>) {
  const calls: string[] = [];
  const run = async (command: AgentExtensionId, args: string[]) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key];
    if (response === undefined) throw new Error(`missing fixture: ${key}`);
    return response;
  };
  return { run, calls };
}

const EMPTY_CLAUDE = {
  "claude mcp list": "No MCP servers configured. Use `claude mcp add` to add a server.",
  "claude plugin list --json": "[]",
};
const EMPTY_CODEX = {
  "codex mcp list --json": "[]",
  "codex plugin list --json": "[]",
};
const EMPTY_CURSOR = {
  "cursor mcp list --format json": '{"mcpServers":{}}',
  "cursor plugin list --format json": "[]",
};
const EMPTY_GROK = {
  "grok mcp list --json": "[]",
  "grok plugin list --json": "[]",
};
const EMPTY_OPENCODE = { "opencode debug config": "{}" };
const EMPTY_PI = { "pi list --no-approve": "No packages installed." };
const EMPTY_ALL = {
  ...EMPTY_CLAUDE,
  ...EMPTY_CODEX,
  ...EMPTY_CURSOR,
  ...EMPTY_GROK,
  ...EMPTY_OPENCODE,
  ...EMPTY_PI,
};

function catalogFor(
  catalogs: AgentExtensionCatalog[],
  agent: AgentExtensionId,
): AgentExtensionCatalog | undefined {
  return catalogs.find((catalog) => catalog.agent === agent);
}

describe("extension discovery parsers", () => {
  test("parses Claude MCP names and health without retaining command details", () => {
    const output = [
      "Checking MCP server health…",
      "docs: npx docs-mcp --token hidden - ✔ Connected",
      "plugin:github:github: https://example.test/mcp (HTTP) - ✘ Failed",
      "review: command - ⏸ Pending approval",
    ].join("\n");

    expect(parseClaudeMcpList(output)).toEqual([
      { name: "docs", status: "connected" },
      { name: "plugin:github:github", status: "failed" },
      { name: "review", status: "pending" },
    ]);
  });

  test("parses Claude plugin IDs, scopes, and disabled state", () => {
    expect(
      parseClaudePlugins(
        JSON.stringify([
          { id: "review@official", enabled: true, scope: "user" },
          { id: "lint@team", enabled: false, scope: "project" },
        ]),
      ),
    ).toEqual([
      { name: "lint", status: "disabled", source: "project" },
      { name: "review", status: "configured", source: "user" },
    ]);
  });

  test("parses Codex MCP JSON", () => {
    expect(
      parseCodexMcpList(
        JSON.stringify([
          { name: "github", enabled: true },
          { name: "legacy", enabled: false },
        ]),
      ),
    ).toEqual([
      { name: "github", status: "configured" },
      { name: "legacy", status: "disabled" },
    ]);
  });

  test("finds installed Codex plugins in the nested CLI response", () => {
    const output = JSON.stringify([
      [
        {
          pluginId: "documents@runtime",
          name: "documents",
          installed: true,
          enabled: true,
          marketplaceName: "runtime",
        },
        {
          pluginId: "optional@runtime",
          name: "optional",
          installed: false,
          enabled: true,
          marketplaceName: "runtime",
        },
      ],
      [],
    ]);

    expect(parseCodexPlugins(output)).toEqual([
      {
        name: "documents",
        status: "configured",
        source: "runtime",
      },
    ]);
  });

  test("supports current and v2 OpenCode config shapes", () => {
    expect(
      parseOpenCodeConfig(
        JSON.stringify({
          mcp: {
            docs: { type: "remote", url: "https://example.test/mcp" },
            local: { type: "local", command: ["bun", "server.ts"], disabled: true },
          },
          plugin: ["@team/review", "file:///project/plugin.ts"],
          plugin_origins: [{ spec: "@team/review" }],
        }),
      ),
    ).toEqual({
      mcpServers: [
        { name: "docs", status: "configured" },
        { name: "local", status: "disabled" },
      ],
      plugins: [
        { name: "@team/review", status: "configured" },
        { name: "file:///project/plugin.ts", status: "configured" },
      ],
    });

    expect(
      parseOpenCodeConfig(
        JSON.stringify({
          mcp: {
            timeout: { startup: 30_000 },
            servers: {
              github: { type: "remote", url: "https://example.test/mcp" },
            },
          },
        }),
      ).mcpServers,
    ).toEqual([{ name: "github", status: "configured" }]);
  });
});

describe("parseClaudeMcpList edge cases", () => {
  test("returns nothing for the no-servers-configured message", () => {
    expect(
      parseClaudeMcpList("No MCP servers configured. Use `claude mcp add` to add a server."),
    ).toEqual([]);
    expect(parseClaudeMcpList("")).toEqual([]);
  });

  test("ignores lines without a status separator instead of inventing servers", () => {
    const output = [
      "Checking MCP server health…",
      "github: npx server - ✘ Failed to connect",
      // The indented detail printed under a failed server. Naively splitting on
      // ": " would render a phantom server named "Error".
      "  Error: spawn npx ENOENT",
      "  Caused by: missing binary",
      "",
    ].join("\n");

    expect(parseClaudeMcpList(output)).toEqual([{ name: "github", status: "failed" }]);
  });

  test("reads status only from the trailing field, never from the command", () => {
    // `--header Authorization: Bearer ...` is the documented way to add an HTTP
    // server, so "auth" in the command text must not imply pending approval.
    const output = [
      "corridor: https://app.corridor.dev/api/mcp --header Authorization: Bearer x - ✔ Connected",
      "errors: npx @acme/error-reporter-mcp - ✔ Connected",
    ].join("\n");

    expect(parseClaudeMcpList(output)).toEqual([
      { name: "corridor", status: "connected" },
      { name: "errors", status: "connected" },
    ]);
  });

  test("strips ANSI colour sequences before parsing", () => {
    const output = "[1mdocs[0m: npx docs-mcp - [32m✔ Connected[0m";
    expect(parseClaudeMcpList(output)).toEqual([{ name: "docs", status: "connected" }]);
  });

  test("collapses duplicate server names", () => {
    const output = ["docs: a - ✔ Connected", "docs: b - ✘ Failed"].join("\n");
    expect(parseClaudeMcpList(output)).toEqual([{ name: "docs", status: "failed" }]);
  });
});

describe("plugin identity", () => {
  test("keeps npm-scoped plugin names instead of dropping them", () => {
    expect(
      parseClaudePlugins(JSON.stringify([{ id: "@team/review@official" }, { id: "@team/lint" }])),
    ).toEqual([
      { name: "@team/lint", status: "configured" },
      { name: "@team/review", status: "configured" },
    ]);
  });

  test("keeps same-named plugins from different marketplaces apart", () => {
    expect(
      parseClaudePlugins(
        JSON.stringify([
          { id: "review@official", scope: "user" },
          { id: "review@internal", scope: "project" },
        ]),
      ),
    ).toEqual([
      { name: "review", status: "configured", source: "project" },
      { name: "review", status: "configured", source: "user" },
    ]);
  });

  test("prefers an explicit name field over the id", () => {
    expect(
      parseClaudePlugins(JSON.stringify([{ id: "review@official", name: "Review Helper" }])),
    ).toEqual([{ name: "Review Helper", status: "configured" }]);
  });

  test("drops records that carry neither an id nor a name", () => {
    expect(
      parseClaudePlugins(JSON.stringify([{ enabled: true }, { id: "   " }, "not-a-record", null])),
    ).toEqual([]);
  });

  test("returns nothing when the CLI emits a non-array payload", () => {
    expect(parseClaudePlugins(JSON.stringify({ plugins: [] }))).toEqual([]);
    expect(parseCodexMcpList(JSON.stringify({ servers: {} }))).toEqual([]);
    expect(parseCodexPlugins(JSON.stringify("nope"))).toEqual([]);
  });

  test("throws on invalid JSON so the caller can report a read failure", () => {
    expect(() => parseClaudePlugins("not-json")).toThrow("The CLI returned invalid JSON");
    expect(() => parseCodexMcpList("<html>")).toThrow("The CLI returned invalid JSON");
    expect(() => parseOpenCodeConfig("")).toThrow("The CLI returned invalid JSON");
  });
});

describe("parseCodexMcpList edge cases", () => {
  test("drops entries without a usable name", () => {
    expect(
      parseCodexMcpList(JSON.stringify([{ enabled: true }, { name: "  " }, { name: "github" }])),
    ).toEqual([{ name: "github", status: "configured" }]);
  });
});

describe("parseCodexPlugins edge cases", () => {
  test("walks nested objects, not just arrays, to find plugin records", () => {
    const output = JSON.stringify({
      marketplaces: {
        runtime: {
          plugins: [
            {
              pluginId: "@team/docs@runtime",
              installed: true,
              enabled: true,
              marketplaceName: "runtime",
            },
            {
              pluginId: "legacy@runtime",
              installed: true,
              enabled: false,
              marketplaceName: "runtime",
            },
          ],
        },
      },
    });

    expect(parseCodexPlugins(output)).toEqual([
      { name: "@team/docs", status: "configured", source: "runtime" },
      { name: "legacy", status: "disabled", source: "runtime" },
    ]);
  });

  test("returns nothing when no record looks like a plugin", () => {
    expect(parseCodexPlugins(JSON.stringify({ marketplaces: { runtime: {} } }))).toEqual([]);
    expect(parseCodexPlugins(JSON.stringify([]))).toEqual([]);
  });
});

describe("parseOpenCodeConfig edge cases", () => {
  test("returns empty collections for a non-object payload", () => {
    expect(parseOpenCodeConfig(JSON.stringify([1, 2]))).toEqual({
      mcpServers: [],
      plugins: [],
    });
    expect(parseOpenCodeConfig(JSON.stringify({}))).toEqual({
      mcpServers: [],
      plugins: [],
    });
  });

  test("ignores mcp entries that are settings rather than servers", () => {
    expect(
      parseOpenCodeConfig(
        JSON.stringify({
          mcp: {
            timeout: { startup: 30_000 },
            enabled: true,
            docs: { type: "remote", url: "https://example.test/mcp" },
          },
        }),
      ).mcpServers,
    ).toEqual([{ name: "docs", status: "configured" }]);
  });

  test("treats both disabled and enabled:false as disabled", () => {
    expect(
      parseOpenCodeConfig(
        JSON.stringify({
          mcp: {
            a: { type: "local", command: "a", disabled: true },
            b: { type: "local", command: "b", enabled: false },
            c: { type: "local", command: "c" },
          },
        }),
      ).mcpServers,
    ).toEqual([
      { name: "a", status: "disabled" },
      { name: "b", status: "disabled" },
      { name: "c", status: "configured" },
    ]);
  });

  test("each surface parser only rejects its own section", () => {
    const brokenMcp = JSON.stringify({ mcp: 42, plugin: ["@team/review"] });
    expect(() => parseOpenCodeMcpServers(brokenMcp)).toThrow("unreadable mcp section");
    expect(parseOpenCodePlugins(brokenMcp)).toEqual([
      { name: "@team/review", status: "configured" },
    ]);

    const brokenPlugins = JSON.stringify({
      mcp: { docs: { type: "local", command: ["docs"] } },
      plugin_origins: "nope",
    });
    expect(() => parseOpenCodePlugins(brokenPlugins)).toThrow("unreadable plugin_origins section");
    expect(parseOpenCodeMcpServers(brokenPlugins)).toEqual([
      { name: "docs", status: "configured" },
    ]);
  });

  test("treats an absent or null section as configured-with-nothing", () => {
    expect(parseOpenCodeConfig(JSON.stringify({ mcp: null, plugin: null }))).toEqual({
      mcpServers: [],
      plugins: [],
    });
  });

  test("reads plugin entries given as strings or as objects", () => {
    expect(
      parseOpenCodeConfig(
        JSON.stringify({
          plugin: ["@team/review", { name: "named" }, { spec: "@team/spec" }, "   ", 7],
        }),
      ).plugins,
    ).toEqual([
      { name: "@team/review", status: "configured" },
      { name: "@team/spec", status: "configured" },
      { name: "named", status: "configured" },
    ]);
  });

  test("parses Cursor mcp.json maps and plugin arrays", () => {
    expect(
      parseCursorMcpList(
        JSON.stringify({
          mcpServers: {
            github: { command: "npx", args: ["-y", "github"] },
            linear: { url: "https://mcp.linear.app/mcp", disabled: true },
          },
        }),
      ),
    ).toEqual([
      { name: "github", status: "configured" },
      { name: "linear", status: "disabled" },
    ]);
    expect(
      parseCursorPlugins(
        JSON.stringify([
          { name: "cursor-review", enabled: true, source: "user" },
          { id: "lint@cursor", enabled: false },
        ]),
      ),
    ).toEqual([
      { name: "cursor-review", status: "configured", source: "user" },
      { name: "lint", status: "disabled" },
    ]);
  });

  test("parses Grok MCP and plugin JSON lists", () => {
    expect(
      parseGrokMcpList(
        JSON.stringify([
          { name: "filesystem", enabled: true },
          { name: "linear", enabled: false, scope: "project" },
        ]),
      ),
    ).toEqual([
      { name: "filesystem", status: "configured" },
      { name: "linear", status: "disabled", source: "project" },
    ]);
    expect(
      parseGrokPlugins(
        JSON.stringify({
          plugins: [
            { name: "superpowers", enabled: true },
            { name: "review", enabled: false },
          ],
        }),
      ),
    ).toEqual([
      { name: "review", status: "disabled" },
      { name: "superpowers", status: "configured" },
    ]);
  });

  // Neither CLI documents its output, so the map shapes are read for both
  // agents rather than only for the one whose shape happened to be observed.
  // A map that vanished into an empty list would be indistinguishable from
  // "none configured" and would carry no error to show beside it.
  for (const parse of [
    { label: "Cursor", run: parseCursorMcpList },
    { label: "Grok", run: parseGrokMcpList },
  ] as const) {
    test(`reads a ${parse.label} MCP map under any known wrapper key`, () => {
      for (const key of ["mcpServers", "servers", "mcp"]) {
        expect(
          parse.run(
            JSON.stringify({
              [key]: {
                github: { command: "npx", args: ["-y", "github"] },
                linear: { url: "https://mcp.linear.app/mcp", disabled: true },
              },
            }),
          ),
        ).toEqual([
          { name: "github", status: "configured" },
          { name: "linear", status: "disabled" },
        ]);
      }
    });

    test(`reads an unwrapped ${parse.label} MCP map`, () => {
      expect(
        parse.run(
          JSON.stringify({
            github: { command: "npx", args: ["-y", "github"] },
            linear: { url: "https://mcp.linear.app/mcp", enabled: false },
          }),
        ),
      ).toEqual([
        { name: "github", status: "configured" },
        { name: "linear", status: "disabled" },
      ]);
    });

    test(`still walks a ${parse.label} wrapper whose value is a list`, () => {
      // `{ mcp: { servers: [...] } }` is not a name → config map, so taking the
      // map branch on the `mcp` key would answer with nothing at all.
      expect(
        parse.run(
          JSON.stringify({
            mcp: { servers: [{ name: "github" }, { name: "linear", enabled: false }] },
          }),
        ),
      ).toEqual([
        { name: "github", status: "configured" },
        { name: "linear", status: "disabled" },
      ]);
    });

    test(`answers an empty ${parse.label} map with an empty list`, () => {
      expect(parse.run(JSON.stringify({ mcpServers: {} }))).toEqual([]);
    });
  }

  test("does not read an unrelated object as a Cursor or Grok server map", () => {
    // No entry resembles a server, so the unwrapped-map fallback must decline
    // and leave the recursive walk to find the one named record present.
    const output = JSON.stringify({
      meta: { generatedAt: "2026-08-16" },
      entry: { name: "github" },
    });
    expect(parseCursorMcpList(output)).toEqual([{ name: "github", status: "configured" }]);
    expect(parseGrokMcpList(output)).toEqual([{ name: "github", status: "configured" }]);
  });

  // Valid JSON of a shape no branch recognises is reported as an empty list
  // rather than an error: unlike OpenCode's named `mcp`/`plugin` sections there
  // is no key whose presence proves the surface exists and could not be read.
  test("answers unrecognised Cursor and Grok JSON with an empty list", () => {
    for (const output of ["{}", '"a string"', "42", "null", "[[]]"]) {
      expect(parseCursorMcpList(output)).toEqual([]);
      expect(parseCursorPlugins(output)).toEqual([]);
      expect(parseGrokMcpList(output)).toEqual([]);
      expect(parseGrokPlugins(output)).toEqual([]);
    }
  });

  test("reports invalid Cursor and Grok JSON as an error rather than an empty list", () => {
    for (const parse of [
      parseCursorMcpList,
      parseCursorPlugins,
      parseGrokMcpList,
      parseGrokPlugins,
    ]) {
      expect(() => parse("cursor-agent: command not found")).toThrow(
        "The CLI returned invalid JSON",
      );
    }
  });
});

describe("discoverAgentExtensions", () => {
  test("returns independent catalogs and preserves partial failures", async () => {
    const responses = new Map<string, string>([
      ["claude mcp list", "docs: command - ✔ Connected"],
      ["claude plugin list --json", "not-json"],
      ["codex mcp list --json", "[]"],
      ["codex plugin list --json", "[]"],
      ["cursor mcp list --format json", JSON.stringify({ mcpServers: {} })],
      ["cursor plugin list --format json", "[]"],
      ["grok mcp list --json", "[]"],
      ["grok plugin list --json", "[]"],
      [
        "opencode debug config",
        JSON.stringify({ mcp: { docs: { type: "local", command: ["docs"] } } }),
      ],
    ]);

    const result = await discoverAgentExtensions(
      async (command: AgentExtensionId, args: string[]) => {
        const key = [command, ...args].join(" ");
        const response = responses.get(key);
        if (response === undefined) throw new Error("missing fixture");
        return response;
      },
    );

    expect(result.map((catalog) => catalog.agent)).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    expect(catalogFor(result, "claude")).toMatchObject({
      agent: "claude",
      mcpServers: [{ name: "docs", status: "connected" }],
      plugins: [],
      pluginError: "Could not read Claude plugins.",
    });
    expect(catalogFor(result, "codex")).toMatchObject({
      agent: "codex",
      mcpServers: [],
      plugins: [],
    });
    expect(catalogFor(result, "opencode")).toMatchObject({
      agent: "opencode",
      mcpServers: [{ name: "docs", status: "configured" }],
      plugins: [],
    });
  });

  test("reports every collection as unreadable when no CLI is available", async () => {
    const { run } = fixtureRunner({});

    const result = await discoverAgentExtensions(run);

    expect(result.map((catalog) => catalog.agent)).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
    for (const catalog of result) {
      expect(catalog.mcpServers).toEqual([]);
      expect(catalog.plugins).toEqual([]);
      expect(catalog.pluginError).toBeTruthy();
      // Pi ships no MCP client of its own — MCP is something one of its
      // packages adds — so there is no command to fail. Reporting an error
      // there would say something is broken when the feature does not exist.
      if (catalog.agent === "pi") expect(catalog.mcpError).toBeUndefined();
      else expect(catalog.mcpError).toBeTruthy();
    }
  });

  test("never leaks CLI output or error text into the reported errors", async () => {
    const secret = "sk-test-DO-NOT-LEAK";
    const run = async () => {
      throw new Error(`spawn failed: --token ${secret}`);
    };

    const result = await discoverAgentExtensions(run);

    const reported = JSON.stringify(result);
    expect(reported).not.toContain(secret);
    expect(reported).not.toContain("spawn failed");
  });

  // Locally, Cursor and Grok reject outright when no managed binary exists
  // rather than falling back to a PATH lookup. That rejection must be contained
  // to the agent that is missing.
  test("keeps every other agent readable when Cursor and Grok cannot be launched", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CODEX,
      "claude mcp list": "docs: npx docs-mcp - ✔ Connected",
      "opencode debug config": JSON.stringify({
        mcp: { docs: { type: "local", command: ["docs"] } },
      }),
    });

    const result = await discoverAgentExtensions(run);

    for (const agent of ["cursor", "grok"] as const) {
      expect(catalogFor(result, agent)).toEqual({
        agent,
        mcpServers: [],
        plugins: [],
        mcpError:
          agent === "cursor"
            ? "Could not read Cursor MCP servers."
            : "Could not read Grok MCP servers.",
        pluginError:
          agent === "cursor" ? "Could not read Cursor plugins." : "Could not read Grok plugins.",
      });
    }
    expect(catalogFor(result, "claude")).toMatchObject({
      mcpServers: [{ name: "docs", status: "connected" }],
    });
    expect(catalogFor(result, "opencode")).toMatchObject({
      mcpServers: [{ name: "docs", status: "configured" }],
    });
    expect(catalogFor(result, "codex")?.mcpError).toBeUndefined();
  });

  test("marks both OpenCode collections unreadable when the config dump fails", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CODEX,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
    });

    expect(catalogFor(await discoverAgentExtensions(run), "opencode")).toEqual({
      agent: "opencode",
      mcpServers: [],
      plugins: [],
      mcpError: "Could not read OpenCode MCP servers.",
      pluginError: "Could not read OpenCode plugins.",
    });
  });

  test("marks both OpenCode collections unreadable when the config dump is not JSON", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CODEX,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
      "opencode debug config": "opencode: command not found",
    });

    const opencode = catalogFor(await discoverAgentExtensions(run), "opencode");

    expect(opencode?.mcpError).toBe("Could not read OpenCode MCP servers.");
    expect(opencode?.pluginError).toBe("Could not read OpenCode plugins.");
  });

  test("keeps Codex MCP servers when only its plugin listing fails", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
      ...EMPTY_OPENCODE,
      "codex mcp list --json": JSON.stringify([{ name: "github" }]),
    });

    expect(catalogFor(await discoverAgentExtensions(run), "codex")).toEqual({
      agent: "codex",
      mcpServers: [{ name: "github", status: "configured" }],
      plugins: [],
      pluginError: "Could not read Codex plugins.",
    });
  });

  test("keeps Claude plugins when only its MCP listing fails", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CODEX,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
      ...EMPTY_OPENCODE,
      "claude plugin list --json": JSON.stringify([{ id: "review@official" }]),
    });

    expect(catalogFor(await discoverAgentExtensions(run), "claude")).toEqual({
      agent: "claude",
      mcpServers: [],
      plugins: [{ name: "review", status: "configured" }],
      mcpError: "Could not read Claude MCP servers.",
    });
  });

  test("keeps OpenCode plugins when only its mcp section is unreadable", async () => {
    // One `debug config` dump feeds both OpenCode surfaces, so a single
    // try/catch around both parses reported this partial success as a total
    // failure: the plugin list was blanked and marked unreadable because the
    // mcp section beside it had drifted.
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CODEX,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
      "opencode debug config": JSON.stringify({
        mcp: "servers-moved-elsewhere",
        plugin: ["@team/review"],
      }),
    });

    expect(catalogFor(await discoverAgentExtensions(run), "opencode")).toEqual({
      agent: "opencode",
      mcpServers: [],
      plugins: [{ name: "@team/review", status: "configured" }],
      mcpError: "Could not read OpenCode MCP servers.",
    });
  });

  test("keeps OpenCode MCP servers when only its plugin section is unreadable", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_CLAUDE,
      ...EMPTY_CODEX,
      ...EMPTY_CURSOR,
      ...EMPTY_GROK,
      ...EMPTY_PI,
      "opencode debug config": JSON.stringify({
        mcp: { docs: { type: "local", command: ["docs"] } },
        plugin: { "@team/review": true },
      }),
    });

    expect(catalogFor(await discoverAgentExtensions(run), "opencode")).toEqual({
      agent: "opencode",
      mcpServers: [{ name: "docs", status: "configured" }],
      plugins: [],
      pluginError: "Could not read OpenCode plugins.",
    });
  });

  test("reads Pi packages and reports no MCP surface", async () => {
    const { run } = fixtureRunner({
      ...EMPTY_ALL,
      "pi list --no-approve": [
        "Installed packages:",
        "  @team/review-pack (user)",
        "  ./local-extension (project)",
        "  npm:pi-mcp-adapter",
      ].join("\n"),
    });

    expect(catalogFor(await discoverAgentExtensions(run), "pi")).toEqual({
      agent: "pi",
      // Empty and *not* an error: Pi has no `mcp list` because it has no MCP
      // client. The section is honestly empty rather than reported as broken.
      mcpServers: [],
      plugins: [
        { name: "@team/review-pack", status: "configured", source: "user" },
        { name: "./local-extension", status: "configured", source: "project" },
        { name: "npm:pi-mcp-adapter", status: "configured" },
      ],
    });
  });

  test("reads Pi's empty state as no packages rather than a failure", async () => {
    const { run } = fixtureRunner(EMPTY_ALL);
    expect(catalogFor(await discoverAgentExtensions(run), "pi")).toEqual({
      agent: "pi",
      mcpServers: [],
      plugins: [],
    });
  });

  test("omits error fields entirely when every CLI succeeds", async () => {
    const { run, calls } = fixtureRunner(EMPTY_ALL);

    const result = await discoverAgentExtensions(run);

    for (const catalog of result) {
      expect(catalog).not.toHaveProperty("mcpError");
      expect(catalog).not.toHaveProperty("pluginError");
    }
    expect(calls.sort()).toEqual([
      "claude mcp list",
      "claude plugin list --json",
      "codex mcp list --json",
      "codex plugin list --json",
      "cursor mcp list --format json",
      "cursor plugin list --format json",
      "grok mcp list --json",
      "grok plugin list --json",
      "opencode debug config",
      // `--no-approve` because this discovery runs against whatever repository
      // is open, and a project-local package must not be trusted just because
      // someone opened a settings pane.
      "pi list --no-approve",
    ]);
  });
});

describe("createExtensionDiscoveryCache", () => {
  const catalogs = (agent: AgentExtensionId): AgentExtensionCatalog[] => [
    { agent, mcpServers: [], plugins: [] },
  ];

  test("serves a cached result inside the TTL and reruns after it", async () => {
    let now = 1_000;
    const cache = createExtensionDiscoveryCache({ ttlMs: 500, now: () => now });
    let runs = 0;
    const load = async () => {
      runs += 1;
      return catalogs("claude");
    };

    expect(await cache.get("env-1", load)).toEqual(catalogs("claude"));
    now = 1_400;
    expect(await cache.get("env-1", load)).toEqual(catalogs("claude"));
    expect(runs).toBe(1);

    now = 1_501;
    await cache.get("env-1", load);
    expect(runs).toBe(2);
  });

  test("keys the cache per environment", async () => {
    const cache = createExtensionDiscoveryCache({ now: () => 0 });
    let runs = 0;
    const load = async () => {
      runs += 1;
      return catalogs("codex");
    };

    await cache.get("env-1", load);
    await cache.get("env-2", load);
    await cache.get("env-1", load);

    expect(runs).toBe(2);
  });

  test("collapses concurrent callers into a single discovery run", async () => {
    const cache = createExtensionDiscoveryCache({ now: () => 0 });
    let runs = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      runs += 1;
      await gate;
      return catalogs("claude");
    };

    const inFlight = Promise.all([
      cache.get("env-1", load),
      cache.get("env-1", load),
      cache.get("env-1", load),
    ]);
    release?.();

    expect(await inFlight).toEqual([catalogs("claude"), catalogs("claude"), catalogs("claude")]);
    expect(runs).toBe(1);
  });

  test("reruns when the caller explicitly refreshes", async () => {
    const cache = createExtensionDiscoveryCache({ now: () => 0 });
    let runs = 0;
    const load = async () => {
      runs += 1;
      return catalogs("opencode");
    };

    await cache.get("env-1", load);
    await cache.get("env-1", load, { refresh: false });
    expect(runs).toBe(1);

    await cache.get("env-1", load, { refresh: true });
    expect(runs).toBe(2);

    // The refreshed result becomes the new cached value.
    await cache.get("env-1", load);
    expect(runs).toBe(2);
  });

  test("does not cache a failed run", async () => {
    const cache = createExtensionDiscoveryCache({ now: () => 0 });
    let runs = 0;
    const load = async () => {
      runs += 1;
      if (runs === 1) throw new Error("environment unavailable");
      return catalogs("claude");
    };

    await expect(cache.get("env-1", load)).rejects.toThrow("environment unavailable");
    expect(await cache.get("env-1", load)).toEqual(catalogs("claude"));
    expect(runs).toBe(2);
  });

  test("drops the entry on invalidate", async () => {
    const cache = createExtensionDiscoveryCache({ now: () => 0 });
    let runs = 0;
    const load = async () => {
      runs += 1;
      return catalogs("claude");
    };

    await cache.get("env-1", load);
    cache.invalidate("env-1");
    await cache.get("env-1", load);

    expect(runs).toBe(2);
    // Invalidating an environment that was never cached is a no-op.
    expect(() => cache.invalidate("env-unknown")).not.toThrow();
  });

  test("prunes expired entries so the map does not grow without bound", async () => {
    let now = 0;
    const cache = createExtensionDiscoveryCache({ ttlMs: 100, now: () => now });
    const load = async () => catalogs("claude");

    for (let index = 0; index < 50; index += 1) {
      now = index * 200;
      await cache.get(`env-${index}`, load);
    }

    // Every earlier entry has expired; re-reading the newest still hits cache.
    let runs = 0;
    await cache.get("env-49", async () => {
      runs += 1;
      return catalogs("claude");
    });
    expect(runs).toBe(0);
  });
});

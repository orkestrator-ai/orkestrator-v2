import { describe, expect, test } from "bun:test";
import {
  discoverAgentExtensions,
  parseClaudeMcpList,
  parseClaudePlugins,
  parseCodexMcpList,
  parseCodexPlugins,
  parseOpenCodeConfig,
  type AgentExtensionId,
} from "./extension-discovery.js";

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
    expect(parseClaudePlugins(JSON.stringify([
      { id: "review@official", enabled: true, scope: "user" },
      { id: "lint@team", enabled: false, scope: "project" },
    ]))).toEqual([
      { name: "lint", status: "disabled", source: "project" },
      { name: "review", status: "configured", source: "user" },
    ]);
  });

  test("parses Codex MCP JSON", () => {
    expect(parseCodexMcpList(JSON.stringify([
      { name: "github", enabled: true },
      { name: "legacy", enabled: false },
    ]))).toEqual([
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
    expect(parseOpenCodeConfig(JSON.stringify({
      mcp: {
        docs: { type: "remote", url: "https://example.test/mcp" },
        local: { type: "local", command: ["bun", "server.ts"], disabled: true },
      },
      plugin: ["@team/review", "file:///project/plugin.ts"],
      plugin_origins: [{ spec: "@team/review" }],
    }))).toEqual({
      mcpServers: [
        { name: "docs", status: "configured" },
        { name: "local", status: "disabled" },
      ],
      plugins: [
        { name: "@team/review", status: "configured" },
        { name: "file:///project/plugin.ts", status: "configured" },
      ],
    });

    expect(parseOpenCodeConfig(JSON.stringify({
      mcp: {
        timeout: { startup: 30_000 },
        servers: {
          github: { type: "remote", url: "https://example.test/mcp" },
        },
      },
    })).mcpServers).toEqual([
      { name: "github", status: "configured" },
    ]);
  });
});

describe("discoverAgentExtensions", () => {
  test("returns independent catalogs and preserves partial failures", async () => {
    const responses = new Map<string, string>([
      ["claude mcp list", "docs: command - ✔ Connected"],
      ["claude plugin list --json", "not-json"],
      ["codex mcp list --json", "[]"],
      ["codex plugin list --json", "[]"],
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

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      agent: "claude",
      mcpServers: [{ name: "docs", status: "connected" }],
      plugins: [],
      pluginError: "Could not read Claude plugins.",
    });
    expect(result[1]).toMatchObject({
      agent: "codex",
      mcpServers: [],
      plugins: [],
    });
    expect(result[2]).toMatchObject({
      agent: "opencode",
      mcpServers: [{ name: "docs", status: "configured" }],
      plugins: [],
    });
  });
});

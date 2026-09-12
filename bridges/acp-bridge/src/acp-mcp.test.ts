import { afterEach, describe, expect, test } from "bun:test";
import {
  configuredAcpMcpServers,
  mcpConnectionKey,
  parseAgentMcpConnection,
} from "./acp-context.js";

const previousUrl = process.env.ORKESTRATOR_AGENT_MCP_URL;
const previousToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;

afterEach(() => {
  if (previousUrl === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_URL;
  else process.env.ORKESTRATOR_AGENT_MCP_URL = previousUrl;
  if (previousToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
  else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = previousToken;
});

describe("ACP Orkestrator MCP", () => {
  test("a per-tab connection wins over process env and is not written back to env", () => {
    process.env.ORKESTRATOR_AGENT_MCP_URL = "http://127.0.0.1:4321/mcp";
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "env-token";
    const first = configuredAcpMcpServers({
      url: "http://127.0.0.1:4567/mcp",
      token: "tab-a",
    });
    const second = configuredAcpMcpServers({
      url: "http://127.0.0.1:4567/mcp",
      token: "tab-b",
    });
    expect(first).toEqual([
      {
        name: "orkestrator",
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: { Authorization: "Bearer tab-a" },
      },
    ]);
    expect(second[0]).toMatchObject({ headers: { Authorization: "Bearer tab-b" } });
    expect(process.env.ORKESTRATOR_AGENT_MCP_TOKEN).toBe("env-token");
  });

  test("falls back to process env when no override is present", () => {
    process.env.ORKESTRATOR_AGENT_MCP_URL = "http://127.0.0.1:4321/mcp";
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "env-token";
    expect(configuredAcpMcpServers()).toMatchObject([
      { url: "http://127.0.0.1:4321/mcp", headers: { Authorization: "Bearer env-token" } },
    ]);
  });

  test("ignores a malformed override", () => {
    expect(
      parseAgentMcpConnection({ url: "http://127.0.0.1:4567/mcp", token: "x".repeat(1025) }),
    ).toBeUndefined();
    expect(mcpConnectionKey({ url: "http://127.0.0.1/mcp", token: "a" })).not.toBe(
      mcpConnectionKey({ url: "http://127.0.0.1/mcp", token: "b" }),
    );
  });
});

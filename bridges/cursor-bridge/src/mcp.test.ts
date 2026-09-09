import { afterEach, describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { cursorMcpServers, publicCursorMcpServers } from "./mcp.js";
import { applyInteractionUpdate } from "./translate.js";

const previousUrl = process.env.ORKESTRATOR_AGENT_MCP_URL;
const previousToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;

afterEach(() => {
  if (previousUrl === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_URL;
  else process.env.ORKESTRATOR_AGENT_MCP_URL = previousUrl;
  if (previousToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
  else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = previousToken;
});

describe("Cursor MCP inventory", () => {
  test("injects the private control server but publishes only names and tools", async () => {
    process.env.ORKESTRATOR_AGENT_MCP_URL = "http://127.0.0.1:4321/mcp";
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "private-test-token";
    const configured = await cursorMcpServers();
    expect(configured.orkestrator).toMatchObject({
      type: "http",
      url: "http://127.0.0.1:4321/mcp",
      headers: { Authorization: "Bearer private-test-token" },
    });

    const state = newSessionState();
    state.mcpServerNames = Object.keys(configured);
    state.runTools = ["mcp__orkestrator__send_message", "shell"];
    const published = JSON.stringify(publicCursorMcpServers(state));
    expect(JSON.parse(published)).toEqual([
      {
        id: "orkestrator",
        name: "orkestrator",
        status: "connected",
        scope: "orkestrator",
        toolCount: 1,
        tools: ["send_message"],
        actions: [],
      },
    ]);
    expect(published).not.toContain("private-test-token");
  });

  test("includes servers Cursor loaded from its own settings once their tools are observed", () => {
    const state = newSessionState();
    state.mcpServerNames = ["orkestrator"];
    state.runTools = ["shell", "mcp"];
    applyInteractionUpdate(state, {
      type: "tool-call-completed",
      callId: "paper-list",
      toolCall: {
        type: "mcp",
        args: { providerIdentifier: "paper", toolName: "list_files", args: {} },
        result: { status: "success", value: { content: [] } },
      },
    });

    expect(publicCursorMcpServers(state)).toEqual([
      {
        id: "orkestrator",
        name: "orkestrator",
        status: "unknown",
        scope: "orkestrator",
        actions: [],
      },
      {
        id: "paper",
        name: "paper",
        status: "connected",
        actions: [],
      },
    ]);
  });
});

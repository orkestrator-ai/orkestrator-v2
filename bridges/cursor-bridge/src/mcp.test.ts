import { afterEach, describe, expect, test } from "bun:test";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGES } from "./config.js";
import {
  cursorMcpServers,
  mcpConnectionKey,
  parseAgentMcpConnection,
  publicCursorMcpServers,
  seedObservedMcpTools,
} from "./mcp.js";
import type { SessionState } from "./state.js";
import { boundTranscript } from "./transcript.js";
import { applyInteractionUpdate } from "./translate.js";

function callMcpTool(state: SessionState, args: Record<string, unknown>, callId: string): void {
  applyInteractionUpdate(state, {
    type: "tool-call-completed",
    callId,
    toolCall: { type: "mcp", args, result: { status: "success", value: { content: [] } } },
  });
}

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

  test("a per-tab agentMcp wins over the process environment", async () => {
    process.env.ORKESTRATOR_AGENT_MCP_URL = "http://127.0.0.1:4321/mcp";
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "env-token";
    const configured = await cursorMcpServers({
      url: "http://127.0.0.1:4567/mcp",
      token: "tab-token",
    });
    expect(configured.orkestrator).toMatchObject({
      url: "http://127.0.0.1:4567/mcp",
      headers: { Authorization: "Bearer tab-token" },
    });
  });

  test("ignores a malformed agentMcp override", () => {
    const malformed = {
      url: "http://127.0.0.1:4567/mcp",
      token: "x".repeat(1025),
    };
    expect(parseAgentMcpConnection(malformed)).toBeUndefined();
    expect(parseAgentMcpConnection({ url: "not-a-url", token: "tab-token" })).toBeUndefined();
    expect(mcpConnectionKey({ url: "http://127.0.0.1/mcp", token: "a" })).not.toBe(
      mcpConnectionKey({ url: "http://127.0.0.1/mcp", token: "b" }),
    );
  });

  test("includes servers Cursor loaded from its own settings once their tools are observed", () => {
    const state = newSessionState();
    state.mcpServerNames = ["orkestrator"];
    state.runTools = ["shell", "mcp"];
    callMcpTool(state, { providerIdentifier: "paper", toolName: "list_files", args: {} }, "paper");

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

  test("keeps a discovered server after the card that revealed it is evicted", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    callMcpTool(state, { providerIdentifier: "paper", toolName: "list_files", args: {} }, "paper");
    expect(publicCursorMcpServers(state).map((server) => server.id)).toEqual(["paper"]);

    // The transcript is a display buffer, not the inventory: pushing the card
    // out of the window must not read as the server having disconnected.
    for (let index = 0; index <= MAX_MESSAGES; index += 1) {
      state.messages.push({
        id: `filler-${index}`,
        role: "assistant",
        content: "",
        parts: [],
        createdAt: new Date().toISOString(),
      });
    }
    expect(boundTranscript(state)).toBe(true);
    expect(
      state.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "tool-invocation" && part.toolName === "mcp__paper__list_files",
        ),
      ),
    ).toBe(false);

    expect(publicCursorMcpServers(state)).toEqual([
      { id: "paper", name: "paper", status: "connected", actions: [] },
    ]);
  });

  test("a restore re-observes the calls its recovered transcript still holds", () => {
    const source = newSessionState();
    callMcpTool(source, { providerIdentifier: "paper", toolName: "list_files", args: {} }, "paper");

    // What `restoreSession` rebuilds: the transcript survives, the runtime
    // accumulator does not.
    const restored = newSessionState();
    restored.messages = source.messages;
    expect(publicCursorMcpServers(restored)).toEqual([]);

    seedObservedMcpTools(restored);
    expect(publicCursorMcpServers(restored)).toEqual([
      { id: "paper", name: "paper", status: "connected", actions: [] },
    ]);
  });

  test("a call without a provider identifier does not invent a server", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    callMcpTool(state, { toolName: "list_files", args: {} }, "anonymous");

    expect(publicCursorMcpServers(state)).toEqual([]);
  });

  test("a configured server id containing the separator wins over the generic split", () => {
    const state = newSessionState();
    state.mcpServerNames = ["team__docs"];
    state.runTools = ["mcp__team__docs__search"];

    expect(publicCursorMcpServers(state)).toEqual([
      {
        id: "team__docs",
        name: "team__docs",
        status: "connected",
        scope: "project",
        toolCount: 1,
        tools: ["search"],
        actions: [],
      },
    ]);
  });

  test("a name with no tool segment or no server segment is not a server", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    state.runTools = ["mcp__lonely", "mcp____tool", "mcp__paper__"];

    expect(publicCursorMcpServers(state)).toEqual([]);
  });

  test("discovery stops at the server cap and the per-server tool cap", () => {
    const state = newSessionState();
    state.mcpServerNames = [];
    state.runTools = Array.from({ length: 200 }, (_, index) => `mcp__server-${index}__tool`);

    const published = publicCursorMcpServers(state);
    expect(published).toHaveLength(64);
    expect(published.at(-1)?.id).toBe("server-63");

    const crowded = newSessionState();
    crowded.mcpServerNames = ["paper"];
    crowded.runTools = Array.from({ length: 300 }, (_, index) => `mcp__paper__tool-${index}`);
    expect(publicCursorMcpServers(crowded)[0]?.toolCount).toBe(128);
  });

  test("bounds the tool segment a provider supplies rather than publishing it whole", () => {
    const state = newSessionState();
    state.mcpServerNames = ["paper"];
    state.runTools = ["mcp__paper__list_files"];
    callMcpTool(state, { providerIdentifier: "paper", toolName: "x".repeat(4096) }, "long");

    const tools = publicCursorMcpServers(state)[0]?.tools ?? [];
    expect(tools).toHaveLength(2);
    expect(Math.max(...tools.map((tool) => tool.length))).toBe(128);
  });
});

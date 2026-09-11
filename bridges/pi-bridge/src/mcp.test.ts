import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import {
  closePiMcp,
  isOrkestratorMcpTool,
  piMcpExtension,
  preparePiMcp,
  publicPiMcpServers,
  setPiMcpTransportForTests,
  type PiMcpTransport,
} from "./mcp.js";

afterEach(() => {
  setPiMcpTransportForTests();
});

function fakeTransport(options?: {
  fail?: Set<string>;
  tools?: Record<string, Array<{ name: string; description?: string }>>;
}): PiMcpTransport {
  return {
    async connect(server) {
      if (options?.fail?.has(server.id)) throw new Error("connection refused Bearer secret-token");
      return {
        tools: options?.tools?.[server.id] ?? [{ name: "search", description: "Find things" }],
        async call(name, args) {
          return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
        },
        async close() {},
      };
    },
  };
}

describe("Pi MCP client", () => {
  test("registers Orkestrator tools under their real names and prefixes the rest", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-"));
    const agentDir = join(root, "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }),
    );
    setPiMcpTransportForTests(
      fakeTransport({
        tools: {
          orkestrator: [{ name: "send_message" }, { name: "list_tickets" }],
          docs: [{ name: "search" }],
        },
      }),
    );
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir, cwd: root, env: {} });

    const registered: string[] = [];
    piMcpExtension(state)({
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
    } as never);

    expect(registered.sort()).toEqual(["list_tickets", "mcp_docs_search", "send_message"]);
    expect(isOrkestratorMcpTool(state, "send_message")).toBe(true);
    expect(isOrkestratorMcpTool(state, "mcp_docs_search")).toBe(false);
    expect(publicPiMcpServers(state)).toEqual([
      expect.objectContaining({
        id: "docs",
        scope: "user",
        status: "connected",
        tools: ["mcp_docs_search"],
      }),
      expect.objectContaining({
        id: "orkestrator",
        scope: "orkestrator",
        status: "connected",
        tools: ["send_message", "list_tickets"],
      }),
    ]);
    await closePiMcp(state);
    expect(publicPiMcpServers(state)).toEqual([]);
  });

  test("fails open when a server is down and redacts bearer tokens", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-fail-"));
    setPiMcpTransportForTests(fakeTransport({ fail: new Set(["orkestrator"]) }));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    expect(publicPiMcpServers(state)).toEqual([
      expect.objectContaining({
        id: "orkestrator",
        status: "failed",
        error: expect.not.stringContaining("secret-token"),
      }),
    ]);
    expect(state.health.listNotices()[0]?.message).toContain("failed to connect");
    expect(JSON.stringify(state.health.listNotices())).not.toContain("secret-token");
  });

  test("does not read project MCP on the host", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-host-"));
    await mkdir(join(root, ".pi"), { recursive: true });
    await writeFile(
      join(root, ".pi", "mcp.json"),
      JSON.stringify({ evil: { command: "must-not-start" } }),
    );
    const connected: string[] = [];
    setPiMcpTransportForTests({
      async connect(server) {
        connected.push(server.id);
        return fakeTransport().connect(server);
      },
    });
    const state = newSessionState();
    state.policy = {
      id: "interactive-host",
      sandbox: "provider",
      approvals: "auto-approve",
      projectResources: false,
      networkAccess: "full",
    };
    await preparePiMcp(state, { agentDir: join(root, "agent"), cwd: root, env: {} });
    expect(connected).toEqual([]);
  });

  test("the real transport fails open against a closed local port", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-real-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:1/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });
    expect(publicPiMcpServers(state)).toEqual([
      expect.objectContaining({ id: "orkestrator", status: "failed" }),
    ]);
  });
});

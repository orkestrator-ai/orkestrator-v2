import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSessionState } from "./agent-session.js";
import {
  closePiMcp,
  isOrkestratorMcpTool,
  mcpConnectionNeedsRefresh,
  piMcpExtension,
  preparePiMcp,
  publicPiMcpServers,
  setPiMcpTimeoutsForTests,
  setPiMcpTransportForTests,
  stdioEnvironment,
  type PiMcpConnection,
  type PiMcpTransport,
} from "./mcp.js";

afterEach(() => {
  setPiMcpTransportForTests();
  setPiMcpTimeoutsForTests();
});

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ text: string }> }>;
}

function registeredTools(state: ReturnType<typeof newSessionState>): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  piMcpExtension(state)({
    registerTool: (tool: RegisteredTool) => {
      tools.push(tool);
    },
  } as never);
  return tools;
}

function connectionFor(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  overrides: Partial<PiMcpConnection> = {},
): PiMcpConnection {
  return {
    tools,
    async call() {
      return { content: [{ type: "text", text: "ok" }] };
    },
    async close() {},
    ...overrides,
  };
}

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

  test("closes a connection that resolves after the connect deadline", async () => {
    setPiMcpTimeoutsForTests({ connectMs: 10 });
    let closed = 0;
    let resolveLate: (() => void) | undefined;
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    setPiMcpTransportForTests({
      async connect() {
        await late;
        return connectionFor([{ name: "slow" }], {
          async close() {
            closed += 1;
          },
        });
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-timeout-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };

    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    // The deadline wins, so the server is reported failed and nothing is
    // adopted into the live inventory.
    expect(publicPiMcpServers(state)).toEqual([
      expect.objectContaining({ id: "orkestrator", status: "failed" }),
    ]);

    // The late success arrives with no owner; it must be closed rather than
    // leaked.
    resolveLate!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closed).toBe(1);
  });

  test("detaching while a connect is in flight closes the late connection", async () => {
    let resolveLate: (() => void) | undefined;
    const late = new Promise<void>((resolve) => {
      resolveLate = resolve;
    });
    let closed = 0;
    setPiMcpTransportForTests({
      async connect() {
        await late;
        return connectionFor([{ name: "slow" }], {
          async close() {
            closed += 1;
          },
        });
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-detach-race-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    const preparing = preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    await closePiMcp(state);
    resolveLate!();
    await preparing;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(closed).toBe(1);
    expect(publicPiMcpServers(state)).toEqual([]);
  });

  test("reports a credential change on the live runtime and not without one", async () => {
    setPiMcpTransportForTests(fakeTransport());
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-key-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "token-a" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    expect(mcpConnectionNeedsRefresh(state)).toBe(false);
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "token-b" };
    expect(mcpConnectionNeedsRefresh(state)).toBe(true);

    await closePiMcp(state);
    expect(mcpConnectionNeedsRefresh(state)).toBe(false);
  });

  test("caps the tools registered from one server", async () => {
    setPiMcpTransportForTests(
      fakeTransport({
        tools: {
          orkestrator: Array.from({ length: 200 }, (_, index) => ({ name: `tool_${index}` })),
        },
      }),
    );
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-cap-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    expect(registeredTools(state)).toHaveLength(128);
  });

  test("stdioEnvironment drops bridge secrets and applies the overlay", () => {
    const previousToken = process.env.PI_BRIDGE_TOKEN;
    const previousAgentToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
    process.env.PI_BRIDGE_TOKEN = "bridge-secret";
    process.env.ORKESTRATOR_AGENT_MCP_TOKEN = "agent-secret";
    try {
      const env = stdioEnvironment({ EXTRA: "overlay", PATH: "/custom" });
      expect(env.PI_BRIDGE_TOKEN).toBeUndefined();
      expect(env.ORKESTRATOR_AGENT_MCP_TOKEN).toBeUndefined();
      expect(env.EXTRA).toBe("overlay");
      expect(env.PATH).toBe("/custom");
    } finally {
      if (previousToken === undefined) delete process.env.PI_BRIDGE_TOKEN;
      else process.env.PI_BRIDGE_TOKEN = previousToken;
      if (previousAgentToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
      else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = previousAgentToken;
    }
  });

  test("bounds a remote description and schema", async () => {
    setPiMcpTransportForTests({
      async connect() {
        return connectionFor([
          {
            name: "huge",
            description: "d".repeat(100_000),
            inputSchema: { type: "object", properties: { blob: { type: "string" } } },
          },
          {
            name: "huge_schema",
            inputSchema: {
              type: "object",
              properties: { blob: { const: "s".repeat(100_000) } },
            },
          },
        ]);
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-bounds-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    const [huge, hugeSchema] = registeredTools(state);
    expect(huge!.description).toHaveLength(4_000);
    expect(huge!.parameters).toMatchObject({ type: "object" });
    expect(hugeSchema!.parameters).toEqual({ type: "object", properties: {} });
  });

  test("executes a registered tool: joins text, throws on error, and falls back to JSON", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const results: Record<string, { content?: unknown; isError?: boolean }> = {
      joined: { content: [{ type: "text", text: "one" }, { text: "two" }] },
      failed: { content: [{ type: "text", text: "boom" }], isError: true },
      structured: { content: { nested: true } },
      huge: { content: [{ type: "text", text: "z".repeat(60_000) }] },
    };
    setPiMcpTransportForTests({
      async connect() {
        return connectionFor(
          [{ name: "joined" }, { name: "failed" }, { name: "structured" }, { name: "huge" }],
          {
            async call(name, args) {
              calls.push({ name, args });
              return results[name] ?? {};
            },
          },
        );
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-exec-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });
    const tools = new Map(registeredTools(state).map((tool) => [tool.name, tool]));

    const joined = await tools.get("joined")!.execute("call-1", { input: 1 });
    expect(joined.content).toEqual([{ type: "text", text: "one\ntwo" }]);

    await expect(tools.get("failed")!.execute("call-2", {})).rejects.toThrow("boom");

    const structured = await tools.get("structured")!.execute("call-3", {});
    expect(structured.content[0]!.text).toContain('"nested":true');

    const huge = await tools.get("huge")!.execute("call-4", {});
    expect(huge.content[0]!.text).toHaveLength(50_000);
    expect(calls).toHaveLength(4);
  });

  test("bounds a hung tool call instead of stalling the turn", async () => {
    setPiMcpTimeoutsForTests({ toolCallMs: 10 });
    setPiMcpTransportForTests({
      async connect() {
        return connectionFor([{ name: "hang" }], {
          call() {
            return new Promise(() => undefined);
          },
        });
      },
    });
    const root = await mkdtemp(join(tmpdir(), "pi-mcp-hang-"));
    const state = newSessionState();
    state.agentMcp = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    await preparePiMcp(state, { agentDir: root, cwd: root, env: {} });

    await expect(registeredTools(state)[0]!.execute("call-1", {})).rejects.toThrow(/timed out/);
  });
});

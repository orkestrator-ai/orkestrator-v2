import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Client as McpClient } from "@modelcontextprotocol/client";
import { newSessionState } from "./agent-session.js";
import { MAX_MESSAGES, workingDirectory } from "./config.js";
import {
  cursorMcpServers,
  formatMcpContent,
  hostOrkestratorCustomTools,
  MAX_MCP_RESULT_BYTES,
  mcpConnectionKey,
  parseAgentMcpConnection,
  publicCursorMcpServers,
  seedObservedMcpTools,
  setCursorMcpTimeoutsForTests,
  setCursorMcpTransportForTests,
} from "./mcp.js";
import type { SessionState } from "./state.js";
import { boundTranscript } from "./transcript.js";
import { applyInteractionUpdate } from "./translate.js";

const NATIVE_WEB_PLATFORM_KEY = Symbol.for("orkestrator.tests.native-web-platform");
const nativeWebPlatform = (
  globalThis as typeof globalThis & {
    [NATIVE_WEB_PLATFORM_KEY]?: {
      fetch: typeof fetch;
      AbortController: typeof AbortController;
      AbortSignal: typeof AbortSignal;
    };
  }
)[NATIVE_WEB_PLATFORM_KEY];

function withNativeWebPlatform<T>(work: () => Promise<T>): Promise<T> {
  if (!nativeWebPlatform) return work();
  const previous = {
    fetch: globalThis.fetch,
    AbortController: globalThis.AbortController,
    AbortSignal: globalThis.AbortSignal,
  };
  globalThis.fetch = nativeWebPlatform.fetch;
  globalThis.AbortController = nativeWebPlatform.AbortController;
  globalThis.AbortSignal = nativeWebPlatform.AbortSignal;
  return work().finally(() => {
    globalThis.fetch = previous.fetch;
    globalThis.AbortController = previous.AbortController;
    globalThis.AbortSignal = previous.AbortSignal;
  });
}

function callMcpTool(state: SessionState, args: Record<string, unknown>, callId: string): void {
  applyInteractionUpdate(state, {
    type: "tool-call-completed",
    callId,
    toolCall: { type: "mcp", args, result: { status: "success", value: { content: [] } } },
  });
}

const previousUrl = process.env.ORKESTRATOR_AGENT_MCP_URL;
const previousToken = process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
const previousProjectSettings = process.env.CURSOR_BRIDGE_PROJECT_SETTINGS;

afterEach(() => {
  setCursorMcpTransportForTests();
  setCursorMcpTimeoutsForTests();
  if (previousUrl === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_URL;
  else process.env.ORKESTRATOR_AGENT_MCP_URL = previousUrl;
  if (previousToken === undefined) delete process.env.ORKESTRATOR_AGENT_MCP_TOKEN;
  else process.env.ORKESTRATOR_AGENT_MCP_TOKEN = previousToken;
  if (previousProjectSettings === undefined) delete process.env.CURSOR_BRIDGE_PROJECT_SETTINGS;
  else process.env.CURSOR_BRIDGE_PROJECT_SETTINGS = previousProjectSettings;
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

  test("a read-only policy returns only the Orkestrator entry when project MCP is present", async () => {
    process.env.CURSOR_BRIDGE_PROJECT_SETTINGS = "1";
    const mcpPath = join(workingDirectory, ".cursor", "mcp.json");
    await mkdir(join(workingDirectory, ".cursor"), { recursive: true });
    await writeFile(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          "review-untrusted": { command: "must-not-start" },
        },
      }),
    );
    const connection = { url: "http://127.0.0.1:4567/mcp", token: "tab-token" };
    try {
      const allowed = await cursorMcpServers(connection, { projectResources: true });
      expect(Object.keys(allowed).sort()).toEqual(["orkestrator", "review-untrusted"]);

      const denied = await cursorMcpServers(connection, {
        readOnly: true,
        projectResources: false,
      });
      expect(Object.keys(denied)).toEqual(["orkestrator"]);
      expect(denied.orkestrator).toEqual({
        type: "http",
        url: "http://127.0.0.1:4567/mcp",
        headers: { Authorization: "Bearer tab-token" },
      });
    } finally {
      await rm(mcpPath, { force: true });
    }
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

  test("a custom-user-tools call is published as the Orkestrator server", () => {
    const state = newSessionState();
    state.mcpServerNames = ["orkestrator"];
    callMcpTool(
      state,
      { providerIdentifier: "custom-user-tools", toolName: "launch_environment", args: {} },
      "hosted",
    );

    expect(publicCursorMcpServers(state)).toEqual([
      {
        id: "orkestrator",
        name: "orkestrator",
        status: "connected",
        scope: "orkestrator",
        actions: [],
      },
    ]);
  });
});

describe("hosted Orkestrator custom tools", () => {
  test("registers Control MCP tools for in-process execution", async () => {
    setCursorMcpTransportForTests({
      async connect() {
        return {
          tools: [
            {
              name: "launch_environment",
              description: "Create a worker",
              inputSchema: { type: "object", properties: { name: { type: "string" } } },
            },
          ],
          async call(name, args) {
            return { content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] };
          },
          async close() {},
        };
      },
    });
    const hosted = await hostOrkestratorCustomTools({
      url: "http://127.0.0.1:4567/mcp",
      token: "coord-token",
    });
    expect(hosted?.toolNames).toEqual(["launch_environment"]);
    expect(hosted?.customTools.launch_environment?.description).toContain("Orkestrator");
    await expect(
      hosted?.customTools.launch_environment?.execute({ name: "worker" }, {}),
    ).resolves.toEqual({
      content: [{ type: "text", text: 'launch_environment:{"name":"worker"}' }],
    });
    await hosted?.close();
  });

  test("a failed connect is a notice, not a thrown attach", async () => {
    setCursorMcpTransportForTests({
      async connect() {
        throw new Error("connection refused Bearer secret-token");
      },
    });
    const state = newSessionState();
    await expect(
      hostOrkestratorCustomTools(
        { url: "http://127.0.0.1:4567/mcp", token: "secret-token" },
        state.health,
      ),
    ).resolves.toBeUndefined();
    const snapshot = JSON.stringify(state.health.snapshot());
    expect(snapshot).toContain("Orkestrator MCP failed to connect");
    expect(snapshot).not.toContain("secret-token");
  });

  test("an empty or all-invalid tool list is not hosted", async () => {
    setCursorMcpTransportForTests({
      async connect() {
        return {
          tools: [{ name: "" }, { name: "x".repeat(200) }],
          async call() {
            return { content: [] };
          },
          async close() {},
        };
      },
    });
    await expect(
      hostOrkestratorCustomTools({ url: "http://127.0.0.1:4567/mcp", token: "coord-token" }),
    ).resolves.toBeUndefined();

    setCursorMcpTransportForTests({
      async connect() {
        return {
          tools: [],
          async call() {
            return { content: [] };
          },
          async close() {},
        };
      },
    });
    await expect(
      hostOrkestratorCustomTools({ url: "http://127.0.0.1:4567/mcp", token: "coord-token" }),
    ).resolves.toBeUndefined();
  });

  test("an oversize input schema is dropped rather than forwarded", async () => {
    setCursorMcpTransportForTests({
      async connect() {
        return {
          tools: [
            {
              name: "launch_environment",
              inputSchema: {
                type: "object",
                properties: { blob: { const: "x".repeat(21_000) } },
              },
            },
          ],
          async call() {
            return { content: [] };
          },
          async close() {},
        };
      },
    });
    const hosted = await hostOrkestratorCustomTools({
      url: "http://127.0.0.1:4567/mcp",
      token: "coord-token",
    });
    expect(hosted?.customTools.launch_environment).toBeDefined();
    expect(hosted?.customTools.launch_environment).not.toHaveProperty("inputSchema");
    await hosted?.close();
  });

  test("execute forwards isError and surfaces a thrown call", async () => {
    setCursorMcpTransportForTests({
      async connect() {
        return {
          tools: [{ name: "boom" }, { name: "failing" }],
          async call(name) {
            if (name === "boom") throw new Error("call exploded");
            return { content: [{ type: "text", text: "nope" }], isError: true };
          },
          async close() {},
        };
      },
    });
    const hosted = await hostOrkestratorCustomTools({
      url: "http://127.0.0.1:4567/mcp",
      token: "coord-token",
    });
    await expect(hosted?.customTools.failing?.execute({}, {})).resolves.toEqual({
      content: [{ type: "text", text: "nope" }],
      isError: true,
    });
    await expect(hosted?.customTools.boom?.execute({}, {})).rejects.toThrow("call exploded");
    await hosted?.close();
  });

  test("a connect timeout aborts the in-flight transport and closes a late success", async () => {
    setCursorMcpTimeoutsForTests({ connectMs: 20 });
    const signals: AbortSignal[] = [];
    let closed = 0;
    setCursorMcpTransportForTests({
      async connect(_url, _token, signal) {
        signals.push(signal ?? new AbortSignal());
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 200);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return {
          tools: [{ name: "late" }],
          async call() {
            return { content: [] };
          },
          async close() {
            closed += 1;
          },
        };
      },
    });
    const state = newSessionState();
    await expect(
      hostOrkestratorCustomTools(
        { url: "http://127.0.0.1:4567/mcp", token: "coord-token" },
        state.health,
      ),
    ).resolves.toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    expect(JSON.stringify(state.health.snapshot())).toContain("Orkestrator MCP timed out");
    await Bun.sleep(250);
    expect(closed).toBe(0);
  });

  test("a hung connect that later succeeds is closed after the deadline", async () => {
    setCursorMcpTimeoutsForTests({ connectMs: 20 });
    let closed = 0;
    setCursorMcpTransportForTests({
      async connect() {
        await Bun.sleep(60);
        return {
          tools: [{ name: "late" }],
          async call() {
            return { content: [] };
          },
          async close() {
            closed += 1;
          },
        };
      },
    });
    await expect(
      hostOrkestratorCustomTools({ url: "http://127.0.0.1:4567/mcp", token: "coord-token" }),
    ).resolves.toBeUndefined();
    await Bun.sleep(80);
    expect(closed).toBe(1);
  });

  test("the default transport closes a hung TCP handshake when the connect deadline fires", async () => {
    await withNativeWebPlatform(async () => {
      setCursorMcpTimeoutsForTests({ connectMs: 40 });
      const originalFetch = globalThis.fetch;
      let fetchAborted = false;
      globalThis.fetch = ((_input, init) => {
        return new Promise((_resolve, reject) => {
          const fail = () => {
            fetchAborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          };
          if (init?.signal?.aborted) fail();
          else init?.signal?.addEventListener("abort", fail, { once: true });
        });
      }) as typeof fetch;
      try {
        const hosted = await hostOrkestratorCustomTools({
          url: "http://127.0.0.1:9/mcp",
          token: "coord-token",
        });
        expect(hosted).toBeUndefined();
        expect(fetchAborted).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});

describe("formatMcpContent", () => {
  test("joins text blocks and stays inside the UTF-8 byte budget", () => {
    expect(
      formatMcpContent({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      }),
    ).toBe("one\ntwo");
    const glyph = "😀";
    expect(Buffer.byteLength(glyph, "utf8")).toBe(4);
    const many = Array.from({ length: 40 }, () => ({
      type: "text",
      text: glyph.repeat(2_000),
    }));
    let processed = 0;
    const content = many.map((item) => {
      let seen = false;
      return {
        get text() {
          if (!seen) {
            seen = true;
            processed += 1;
          }
          return item.text;
        },
      };
    });
    const formatted = formatMcpContent({ content });
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
    expect(processed).toBeLessThan(many.length);
    expect(processed).toBeLessThanOrEqual(Math.ceil(MAX_MCP_RESULT_BYTES / (4 * 2_000)) + 1);
  });

  test("the JSON fallback is also UTF-8 bounded", () => {
    const formatted = formatMcpContent({
      leftover: "x".repeat(80_000),
    } as { content?: unknown });
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
  });
});

describe("Streamable HTTP Control MCP hosting", () => {
  test("hosts tools through the real client against a Control-shaped server", async () => {
    await withNativeWebPlatform(async () => {
      const token = "a".repeat(32);
      const authorization: string[] = [];
      const callArgs: unknown[] = [];
      const originalCallTool = McpClient.prototype.callTool;
      McpClient.prototype.callTool = function (params, options) {
        callArgs.push(options);
        return originalCallTool.call(this, params, options);
      };
      const server = await startControlLikeMcp({
        token,
        onAuthorization: (value) => authorization.push(value),
        tools: [
          {
            name: "launch_environment",
            description: "Create a worker",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
            result: { content: [{ type: "text", text: "launched" }] },
          },
          {
            name: "failing",
            result: { content: [{ type: "text", text: "denied" }], isError: true },
          },
          {
            name: "huge",
            result: {
              content: Array.from({ length: 20 }, () => ({
                type: "text",
                text: "😀".repeat(4_000),
              })),
            },
          },
        ],
      });
      setCursorMcpTimeoutsForTests({ connectMs: 2_000, toolCallMs: 5_000 });
      try {
        const hosted = await hostOrkestratorCustomTools({ url: server.url, token });
        expect(authorization.some((header) => header === `Bearer ${token}`)).toBe(true);
        expect(hosted?.toolNames.sort()).toEqual(["failing", "huge", "launch_environment"]);
        await expect(
          hosted?.customTools.launch_environment?.execute({ name: "worker" }, {}),
        ).resolves.toEqual({
          content: [{ type: "text", text: "launched" }],
        });
        await expect(hosted?.customTools.failing?.execute({}, {})).resolves.toEqual({
          content: [{ type: "text", text: "denied" }],
          isError: true,
        });
        const huge = await hosted?.customTools.huge?.execute({}, {});
        const hugeText =
          huge && typeof huge === "object" && "content" in huge
            ? ((huge.content as Array<{ text?: string }>)[0]?.text ?? "")
            : "";
        expect(Buffer.byteLength(hugeText, "utf8")).toBeLessThanOrEqual(MAX_MCP_RESULT_BYTES);
        expect(
          callArgs.some(
            (options) =>
              options !== undefined &&
              typeof options === "object" &&
              "timeout" in options &&
              options.timeout === 5_000,
          ),
        ).toBe(true);
        await hosted?.close();
      } finally {
        McpClient.prototype.callTool = originalCallTool;
        await server.close();
      }
    });
  });

  test("a slow Control MCP tool call is bounded by the configured timeout", async () => {
    await withNativeWebPlatform(async () => {
      const token = "b".repeat(32);
      const server = await startControlLikeMcp({
        token,
        tools: [
          { name: "slow", delayMs: 200, result: { content: [{ type: "text", text: "late" }] } },
        ],
      });
      setCursorMcpTimeoutsForTests({ connectMs: 2_000, toolCallMs: 40 });
      try {
        const hosted = await hostOrkestratorCustomTools({ url: server.url, token });
        await expect(hosted?.customTools.slow?.execute({}, {})).rejects.toThrow();
        await hosted?.close();
      } finally {
        await server.close();
      }
    });
  });
});

type ControlLikeTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  delayMs?: number;
  result?: { content?: unknown; isError?: boolean };
};

async function startControlLikeMcp(options: {
  token: string;
  tools: ControlLikeTool[];
  onAuthorization?: (value: string) => void;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    void handleControlLikeRequest(request, response, options).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500);
        response.end();
      } else {
        response.destroy();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  server.unref();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function handleControlLikeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    token: string;
    tools: ControlLikeTool[];
    onAuthorization?: (value: string) => void;
  },
): Promise<void> {
  const authorization = request.headers.authorization ?? "";
  options.onAuthorization?.(
    Array.isArray(authorization) ? (authorization[0] ?? "") : authorization,
  );
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }
  if (authorization !== `Bearer ${options.token}`) {
    response.writeHead(401, { "www-authenticate": 'Bearer realm="orkestrator-control"' });
    response.end(JSON.stringify({ error: "Invalid control MCP credential" }));
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    response.writeHead(202);
    response.end();
    return;
  }
  const body = JSON.parse(raw) as {
    jsonrpc?: string;
    id?: unknown;
    method?: string;
    params?: { name?: string };
  };
  const reply = async (payload: unknown, status = 200) => {
    const text = JSON.stringify(payload);
    response.writeHead(status, {
      "content-type": "application/json",
      "mcp-session-id": "control-test",
    });
    response.end(text);
  };
  if (body.method === "server/discover") {
    await reply({
      jsonrpc: "2.0",
      id: body.id,
      error: { code: -32601, message: "Method not found" },
    });
    return;
  }
  if (body.method === "initialize") {
    await reply({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "orkestrator-control-test", version: "1.0.0" },
      },
    });
    return;
  }
  if (body.method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }
  if (body.method === "tools/list") {
    await reply({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: options.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        })),
      },
    });
    return;
  }
  if (body.method === "tools/call") {
    const tool = options.tools.find((entry) => entry.name === body.params?.name);
    if (tool?.delayMs) await Bun.sleep(tool.delayMs);
    await reply({
      jsonrpc: "2.0",
      id: body.id,
      result: tool?.result ?? { content: [{ type: "text", text: "ok" }] },
    });
    return;
  }
  await reply({
    jsonrpc: "2.0",
    id: body.id,
    error: { code: -32601, message: "Method not found" },
  });
}

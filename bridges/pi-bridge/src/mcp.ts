/**
 * Bridge-owned MCP client for Pi.
 *
 * Pi's vendor SDK has no MCP client. This module connects the servers a
 * session is allowed to launch, registers their tools through the same
 * `extensionFactories` path as the approval gate, and forgets every client
 * on detach. Agent MCP down is a notice, not a failed attach.
 */
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { agentDirectory, workingDirectory } from "./config.js";
import {
  ORKESTRATOR_MCP_SERVER_NAME,
  orkestratorMcpServer,
  resolvePiMcpServers,
  sanitizeMcpName,
  type ResolvedMcpServer,
} from "./mcp-config.js";
import { getAgentDir } from "./pi-sdk.js";
import { isObject, type JsonObject, type SessionState } from "./state.js";

const CONNECT_TIMEOUT_MS = 3_000;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_RESULT_BYTES = 50_000;
const STDIO_SECRET_ENV = new Set(["ORKESTRATOR_AGENT_MCP_TOKEN", "PI_BRIDGE_TOKEN"]);

export interface PiMcpListedTool {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: unknown;
}

export interface PiMcpConnection {
  tools: PiMcpListedTool[];
  call(name: string, args: JsonObject): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

export interface PiMcpTransport {
  connect(server: ResolvedMcpServer): Promise<PiMcpConnection>;
}

interface RegisteredMcpTool {
  name: string;
  label: string;
  description: string;
  parameters: JsonObject;
  scope: ResolvedMcpServer["scope"];
  call(args: JsonObject): Promise<{ content?: unknown; isError?: boolean }>;
}

interface PiMcpRuntime {
  inventory: NativeAgentMcpServer[];
  orkestratorToolNames: Set<string>;
  tools: RegisteredMcpTool[];
  connections: PiMcpConnection[];
}

const runtimes = new WeakMap<SessionState, PiMcpRuntime>();
let testTransport: PiMcpTransport | undefined;

export function setPiMcpTransportForTests(transport?: PiMcpTransport): void {
  testTransport = transport;
}

export function publicPiMcpServers(state: SessionState): NativeAgentMcpServer[] {
  return runtimes.get(state)?.inventory ?? [];
}

export function isOrkestratorMcpTool(state: SessionState, toolName: string): boolean {
  return runtimes.get(state)?.orkestratorToolNames.has(toolName) === true;
}

export async function preparePiMcp(
  state: SessionState,
  options: { agentDir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  await closePiMcp(state);
  const servers = await resolvePiMcpServers({
    agentDir: options.agentDir ?? agentDirectory() ?? getAgentDir(),
    cwd: options.cwd ?? workingDirectory,
    projectResources: state.policy?.projectResources === true,
    agentMcp: state.agentMcp,
    env: options.env,
  });
  const runtime: PiMcpRuntime = {
    inventory: [],
    orkestratorToolNames: new Set(),
    tools: [],
    connections: [],
  };
  const connected = await Promise.all(
    servers.map((server) => connectAndRegister(state, runtime, server)),
  );
  runtime.inventory = connected;
  runtimes.set(state, runtime);
}

export function piMcpExtension(state: SessionState): (pi: ExtensionAPI) => void {
  return (pi) => {
    for (const tool of runtimes.get(state)?.tools ?? []) {
      pi.registerTool({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_toolCallId, params) => {
          const result = await tool.call(isObject(params) ? params : {});
          const text = formatMcpContent(result);
          if (result.isError) throw new Error(text);
          return { content: [{ type: "text" as const, text }], details: {} };
        },
      });
    }
  };
}

export async function closePiMcp(state: SessionState): Promise<void> {
  const runtime = runtimes.get(state);
  runtimes.delete(state);
  if (!runtime) return;
  await Promise.allSettled(runtime.connections.map((connection) => connection.close()));
}

async function connectAndRegister(
  state: SessionState,
  runtime: PiMcpRuntime,
  server: ResolvedMcpServer,
): Promise<NativeAgentMcpServer> {
  try {
    const connection = await withTimeout(
      (testTransport ?? defaultTransport).connect(server),
      CONNECT_TIMEOUT_MS,
      `MCP server ${server.id} timed out`,
    );
    runtime.connections.push(connection);
    const tools = connection.tools.slice(0, MAX_MCP_TOOLS);
    const names: string[] = [];
    for (const listed of tools) {
      const registered = registerListedTool(server, listed, connection);
      if (!registered) continue;
      runtime.tools.push(registered);
      names.push(registered.name);
      if (server.scope === "orkestrator") runtime.orkestratorToolNames.add(registered.name);
    }
    return {
      id: server.id,
      name: server.id,
      status: "connected",
      scope: server.scope,
      transport: server.transport,
      toolCount: names.length,
      tools: names,
      actions: [],
    };
  } catch (error) {
    state.health.recordNotice({
      message: `MCP server ${server.id} failed to connect; the session will continue without it`,
      method: "mcp/connect",
      severity: "warning",
      source: "bridge",
      detail: publicMcpError(error),
    });
    return {
      id: server.id,
      name: server.id,
      status: "failed",
      scope: server.scope,
      transport: server.transport,
      error: publicMcpError(error),
      actions: [],
    };
  }
}

function registerListedTool(
  server: ResolvedMcpServer,
  listed: PiMcpListedTool,
  connection: PiMcpConnection,
): RegisteredMcpTool | undefined {
  const remoteName = listed.name.trim();
  if (!remoteName) return undefined;
  const name =
    server.scope === "orkestrator"
      ? sanitizeMcpName(remoteName)
      : prefixedToolName(server.id, remoteName);
  if (!name) return undefined;
  return {
    name,
    label: listed.title?.trim() || remoteName,
    description: listed.description?.trim() || `MCP tool ${remoteName} from ${server.id}`,
    parameters: toolParameters(listed.inputSchema),
    scope: server.scope,
    call: (args) => connection.call(remoteName, args),
  };
}

function prefixedToolName(serverId: string, toolName: string): string | undefined {
  const tool = sanitizeMcpName(toolName);
  return tool ? `mcp_${serverId}_${tool}` : undefined;
}

function toolParameters(schema: unknown): JsonObject {
  return isObject(schema) && schema.type === "object" ? schema : { type: "object", properties: {} };
}

const defaultTransport: PiMcpTransport = {
  async connect(server) {
    const client = new McpClient(
      { name: "orkestrator-pi-bridge", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport =
      server.transport === "http" && server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: server.headers ? { headers: server.headers } : undefined,
          })
        : new StdioClientTransport({
            command: server.command ?? "",
            ...(server.args ? { args: server.args } : {}),
            env: stdioEnvironment(server.env),
            stderr: "ignore",
            cwd: workingDirectory,
          });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      return {
        tools: (listed.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(typeof tool.title === "string" ? { title: tool.title } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        })),
        call: async (name, args) => {
          const result = await client.callTool({ name, arguments: args });
          return {
            content: result.content,
            ...(result.isError === true ? { isError: true } : {}),
          };
        },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  },
};

function stdioEnvironment(overlay?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || STDIO_SECRET_ENV.has(key)) continue;
    env[key] = value;
  }
  return { ...env, ...overlay };
}

function formatMcpContent(result: { content?: unknown }): string {
  if (Array.isArray(result.content)) {
    const parts = result.content.flatMap((item) =>
      isObject(item) && typeof item.text === "string" ? [item.text] : [],
    );
    if (parts.length > 0) return parts.join("\n").slice(0, MAX_MCP_RESULT_BYTES);
  }
  try {
    return JSON.stringify(result).slice(0, MAX_MCP_RESULT_BYTES);
  } catch {
    return "(empty MCP result)";
  }
}

function publicMcpError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
import { withTimeout } from "./timeout.js";

const CONNECT_TIMEOUT_MS = 3_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;
const MAX_MCP_TOOLS = 128;
const MAX_MCP_RESULT_BYTES = 50_000;
const MAX_MCP_DESCRIPTION_BYTES = 4_000;
const MAX_MCP_SCHEMA_BYTES = 20_000;
const STDIO_SECRET_ENV = new Set(["ORKESTRATOR_AGENT_MCP_TOKEN", "PI_BRIDGE_TOKEN"]);

/**
 * The Orkestrator MCP tools the coordinator read-only gate may exempt.
 *
 * Keyed on the *name the tool is registered under*, which a server chooses.
 * Exempting the whole Orkestrator scope let a server that advertised a tool
 * named after a Pi built-in place that name in the exempt set and unblock it
 * under `coordinator-read-only`. Namespacing is not an option here: the model
 * is told these tools by name, so the allowlist is the boundary.
 */
const COORDINATOR_MAIL_TOOLS = new Set([
  "check_inbox",
  "read_message",
  "send_message",
  "reply_message",
  "ack_message",
  "get_message_status",
  "list_mailboxes",
  "launch_environment",
]);

/** Per-process timing budgets, overridable so a test need not wait them out. */
let connectTimeoutMs = CONNECT_TIMEOUT_MS;
let toolCallTimeoutMs = TOOL_CALL_TIMEOUT_MS;

export function setPiMcpTimeoutsForTests(options?: {
  connectMs?: number;
  toolCallMs?: number;
}): void {
  connectTimeoutMs = options?.connectMs ?? CONNECT_TIMEOUT_MS;
  toolCallTimeoutMs = options?.toolCallMs ?? TOOL_CALL_TIMEOUT_MS;
}

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
  /** The tab credential these connections were prepared with; "" for the env. */
  connectionKey: string;
  /** Set once `closePiMcp` runs, so an in-flight connect closes on arrival. */
  closed: boolean;
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
  const runtime = runtimes.get(state);
  return (
    runtime?.orkestratorToolNames.has(toolName) === true && COORDINATOR_MAIL_TOOLS.has(toolName)
  );
}

/**
 * Whether the live connections were prepared with a different tab credential
 * than the one currently on the session.
 *
 * A rotated token updates `state.agentMcp` but leaves the attached Pi session's
 * MCP extension pointed at the old connection, so the caller has to rebuild the
 * session. A session with no live runtime needs no refresh: the next attach
 * prepares from whatever `state.agentMcp` holds.
 */
export function mcpConnectionNeedsRefresh(state: SessionState): boolean {
  const runtime = runtimes.get(state);
  return runtime !== undefined && runtime.connectionKey !== mcpConnectionKey(state);
}

function mcpConnectionKey(state: SessionState): string {
  return state.agentMcp ? `${state.agentMcp.url}\u0000${state.agentMcp.token}` : "";
}

export async function preparePiMcp(
  state: SessionState,
  options: { agentDir?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const previous = runtimes.get(state);
  if (previous) previous.closed = true;
  const runtime: PiMcpRuntime = {
    inventory: [],
    orkestratorToolNames: new Set(),
    tools: [],
    connections: [],
    connectionKey: mcpConnectionKey(state),
    closed: false,
  };
  // Registered synchronously, before the first await. A detach that races this
  // call then finds the new runtime and can mark it closed, so a connection
  // that lands afterwards closes rather than leaking. Closing the previous
  // generation here, rather than through `closePiMcp`, is what keeps that from
  // closing the runtime this call just installed.
  runtimes.set(state, runtime);
  if (previous) {
    await Promise.allSettled(previous.connections.map((connection) => connection.close()));
  }
  const servers = await resolvePiMcpServers({
    agentDir: options.agentDir ?? agentDirectory() ?? getAgentDir(),
    cwd: options.cwd ?? workingDirectory,
    projectResources: state.policy?.projectResources === true,
    agentMcp: state.agentMcp,
    env: options.env,
  });
  const connected = await Promise.all(
    servers.map((server) => connectAndRegister(state, runtime, server)),
  );
  if (!runtime.closed) runtime.inventory = connected;
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
          // A hung Orkestrator or user MCP tool must not stall the whole turn
          // behind it. The real transport also aborts its own request; this
          // bounds every transport, including a test double.
          const result = await withTimeout(
            tool.call(isObject(params) ? params : {}),
            toolCallTimeoutMs,
            `MCP tool ${tool.name} timed out`,
          );
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
  if (runtime) runtime.closed = true;
  runtimes.delete(state);
  if (!runtime) return;
  await Promise.allSettled(runtime.connections.map((connection) => connection.close()));
}

async function connectAndRegister(
  state: SessionState,
  runtime: PiMcpRuntime,
  server: ResolvedMcpServer,
): Promise<NativeAgentMcpServer> {
  let connection: PiMcpConnection | undefined;
  try {
    connection = await connectWithTimeout(testTransport ?? defaultTransport, server);
  } catch (error) {
    return recordConnectFailure(state, server, error);
  }
  // Detached while connecting. Closing here is what keeps a slow first launch
  // from leaking a child process that nothing owns any more.
  if (runtime.closed) {
    await connection.close().catch(() => undefined);
    return {
      id: server.id,
      name: server.id,
      status: "failed",
      scope: server.scope,
      transport: server.transport,
      error: "MCP connection was detached before it completed",
      actions: [],
    };
  }
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
}

function recordConnectFailure(
  state: SessionState,
  server: ResolvedMcpServer,
  error: unknown,
): NativeAgentMcpServer {
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

/**
 * Connect one server, and close the connection if it arrives after the
 * deadline.
 *
 * `withTimeout` alone discards a late success, which leaves an unowned child
 * process and an open transport. Racing a rejecting deadline and closing the
 * loser on arrival is what makes the fail-open path leak nothing.
 */
async function connectWithTimeout(
  transport: PiMcpTransport,
  server: ResolvedMcpServer,
): Promise<PiMcpConnection> {
  const attempt = transport.connect(server);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`MCP server ${server.id} timed out`));
    }, connectTimeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    if (timedOut) {
      void attempt.then(
        (late) => late.close().catch(() => undefined),
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
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
    description: boundedDescription(listed.description, `MCP tool ${remoteName} from ${server.id}`),
    parameters: toolParameters(listed.inputSchema),
    scope: server.scope,
    call: (args) => connection.call(remoteName, args),
  };
}

function prefixedToolName(serverId: string, toolName: string): string | undefined {
  const tool = sanitizeMcpName(toolName);
  return tool ? `mcp_${serverId}_${tool}` : undefined;
}

/**
 * A description a remote server sends goes straight into every model request,
 * so it is bounded like every other untrusted field in this module.
 */
function boundedDescription(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  return text.length > MAX_MCP_DESCRIPTION_BYTES ? text.slice(0, MAX_MCP_DESCRIPTION_BYTES) : text;
}

function toolParameters(schema: unknown): JsonObject {
  if (!isObject(schema) || schema.type !== "object") {
    return { type: "object", properties: {} };
  }
  try {
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_MCP_SCHEMA_BYTES) {
      return { type: "object", properties: {} };
    }
  } catch {
    return { type: "object", properties: {} };
  }
  return schema;
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
          // Abort the wire request if it outlives the tool budget; the extension
          // wrapper bounds every transport, but only the real client can cancel
          // the in-flight request itself.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), toolCallTimeoutMs);
          timer.unref();
          try {
            const result = await client.callTool(
              { name, arguments: args },
              { signal: controller.signal },
            );
            return {
              content: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            };
          } finally {
            clearTimeout(timer);
          }
        },
        close: () => client.close(),
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  },
};

export function stdioEnvironment(overlay?: Record<string, string>): Record<string, string> {
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

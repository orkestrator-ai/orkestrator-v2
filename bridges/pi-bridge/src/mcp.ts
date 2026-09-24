/**
 * Bridge-owned MCP client for Pi.
 *
 * Pi's vendor SDK has no MCP client. This module connects the servers a
 * session is allowed to launch, registers their tools through the same
 * `extensionFactories` path as the approval gate, and forgets every client
 * on detach. Agent MCP down is a notice, not a failed attach.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { agentDirectory, workingDirectory } from "./config.js";
import { resolvePiMcpServers, sanitizeMcpName, type ResolvedMcpServer } from "./mcp-config.js";
import { getAgentDir } from "./pi-sdk.js";
import { isObject, type JsonObject, type SessionState } from "./state.js";
import { withTimeout } from "./timeout.js";

const CONNECT_TIMEOUT_MS = 3_000;
/**
 * Longest a detach waits for its MCP connections to close. A stdio server that
 * ignores its transport closing must not hold a rebuild, a session delete or
 * bridge shutdown hostage; after the deadline the close keeps running
 * unobserved (its rejection is still handled) and the caller moves on.
 */
const CLOSE_TIMEOUT_MS = 2_000;
/**
 * Connects in flight at once. Up to 64 servers may be configured, and each
 * stdio server is a child process: starting them all together turns one
 * attach into a fork storm and makes every connect race the same deadline.
 */
export const MAX_CONCURRENT_MCP_CONNECTS = 4;
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
let closeTimeoutMs = CLOSE_TIMEOUT_MS;

export function setPiMcpTimeoutsForTests(options?: {
  connectMs?: number;
  toolCallMs?: number;
  closeMs?: number;
}): void {
  connectTimeoutMs = options?.connectMs ?? CONNECT_TIMEOUT_MS;
  toolCallTimeoutMs = options?.toolCallMs ?? TOOL_CALL_TIMEOUT_MS;
  closeTimeoutMs = options?.closeMs ?? CLOSE_TIMEOUT_MS;
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
  /** Fingerprint of the MCP files this generation was built from. */
  configKey: string;
  /** Per-file digests behind `configKey`, and when they were read. */
  configRevision?: PiMcpConfigRevision & { builtAt: string };
  /** Where those files were read, so a refresh check reads the same ones. */
  configPaths: { agentDir?: string; cwd?: string };
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

/** One MCP file's identity: `sha256:<base64url>` of its bytes, `absent`, or `excluded` by policy. */
export type PiMcpSourceDigest = string;

/**
 * Content-free identity of the MCP files a generation was built from.
 *
 * Digests are sha256 (base64url) of the exact bytes, so the backend — which
 * knows what it wrote — can tell whether a live generation picked a save up.
 * Never a path, never a server body: these files hold env values and headers.
 */
export interface PiMcpConfigRevision {
  /** One opaque value over both sources; changes when either does. */
  fingerprint: string;
  sources: {
    /** `<agentDir>/mcp.json`. */
    user: PiMcpSourceDigest;
    /** `<cwd>/.pi/mcp.json`; `excluded` unless the session loads project resources. */
    project: PiMcpSourceDigest;
  };
}

async function fileDigest(file: string): Promise<PiMcpSourceDigest> {
  try {
    return `sha256:${createHash("sha256")
      .update(await readFile(file))
      .digest("base64url")}`;
  } catch {
    return "absent";
  }
}

/** Per-file digests of the MCP configuration a session reads. */
export async function piMcpConfigRevision(
  state: SessionState,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<PiMcpConfigRevision> {
  const agentDir = options.agentDir ?? agentDirectory() ?? getAgentDir();
  const [user, project] = await Promise.all([
    fileDigest(join(agentDir, "mcp.json")),
    state.policy?.projectResources === true
      ? fileDigest(join(options.cwd ?? workingDirectory, ".pi", "mcp.json"))
      : Promise.resolve("excluded"),
  ]);
  return {
    fingerprint: createHash("sha256")
      .update(`user=${user}\u0000project=${project}`)
      .digest("base64url"),
    sources: { user, project },
  };
}

/**
 * Fingerprint of the MCP configuration files a session reads. Orkestrator's
 * settings (or the user's editor) can change them while a session is attached,
 * and Pi fixes tool registrations when the session is created, so a changed
 * fingerprint means the next safe boundary has to rebuild the session.
 */
export async function piMcpConfigFingerprint(
  state: SessionState,
  options: { agentDir?: string; cwd?: string } = {},
): Promise<string> {
  return (await piMcpConfigRevision(state, options)).fingerprint;
}

/**
 * Which saved MCP configuration the attached generation was built from, for
 * `/session/:id/runtime-health`. Absent while no generation is attached — a
 * detached session has loaded nothing, which is how the backend tells "not
 * yet applied" from "applied". Content-free digests only.
 */
export function publicPiMcpConfig(
  state: SessionState,
): (PiMcpConfigRevision & { builtAt: string }) | undefined {
  if (!state.session) return undefined;
  const runtime = runtimes.get(state);
  if (!runtime || runtime.closed || !runtime.configRevision) return undefined;
  return structuredClone(runtime.configRevision);
}

/** Whether the saved MCP files changed since the live connections were built. */
export async function mcpConfigNeedsRefresh(state: SessionState): Promise<boolean> {
  const runtime = runtimes.get(state);
  if (!runtime) return false;
  return runtime.configKey !== (await piMcpConfigFingerprint(state, runtime.configPaths));
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
    configKey: "",
    configPaths: { agentDir: options.agentDir, cwd: options.cwd },
    closed: false,
  };
  // Registered synchronously, before the first await. A detach that races this
  // call then finds the new runtime and can mark it closed, so a connection
  // that lands afterwards closes rather than leaking. Closing the previous
  // generation here, rather than through `closePiMcp`, is what keeps that from
  // closing the runtime this call just installed.
  runtimes.set(state, runtime);
  if (previous) await closeConnections(state, previous.connections);
  // Fingerprint before reading, so an edit racing this read is seen as a
  // change at the next boundary rather than missed. `builtAt` is taken before
  // the read too: it is a lower bound on when these bytes were read.
  const builtAt = new Date().toISOString();
  const revision = await piMcpConfigRevision(state, options);
  runtime.configKey = revision.fingerprint;
  runtime.configRevision = { ...revision, builtAt };
  const servers = await resolvePiMcpServers({
    agentDir: options.agentDir ?? agentDirectory() ?? getAgentDir(),
    cwd: options.cwd ?? workingDirectory,
    projectResources: state.policy?.projectResources === true,
    agentMcp: state.agentMcp,
    env: options.env,
  });
  // Every failure settles into that server's inventory row, so one malformed
  // server cannot fail the attach or strand the servers queued behind it.
  const connected = await mapWithConcurrency(servers, MAX_CONCURRENT_MCP_CONNECTS, (server) =>
    connectAndRegister(state, runtime, server).catch((error: unknown) =>
      recordConnectFailure(state, server, error),
    ),
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
  await closeConnections(state, runtime.connections);
}

/**
 * Run `work` over `items` with at most `limit` in flight, keeping input order.
 *
 * A rejected item fails the whole call like `Promise.all`; the only caller
 * passes a function that already settles every failure into an inventory row.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => worker()),
  );
  return results;
}

/**
 * Close every connection, waiting at most `closeTimeoutMs` for all of them.
 *
 * `allSettled` attaches a handler to every close before the race, so a close
 * that rejects after the deadline is still observed rather than becoming an
 * unhandled rejection; a close that throws synchronously is caught the same
 * way. Returns without waiting for stragglers, and says so in health.
 */
async function closeConnections(
  state: SessionState,
  connections: readonly PiMcpConnection[],
): Promise<void> {
  if (connections.length === 0) return;
  const settled = Promise.allSettled(
    connections.map(async (connection) => {
      await connection.close();
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
    timer.unref();
  });
  const outcome = await Promise.race([settled.then(() => "closed" as const), deadline]);
  if (timer) clearTimeout(timer);
  if (outcome === "timeout") {
    state.health.recordNotice({
      message: "An MCP server did not close in time; the bridge moved on without waiting",
      method: "mcp/close",
      severity: "warning",
      source: "bridge",
    });
  }
}

async function connectAndRegister(
  state: SessionState,
  runtime: PiMcpRuntime,
  server: ResolvedMcpServer,
): Promise<NativeAgentMcpServer> {
  // Detached while this server waited for a connect slot: never start it.
  if (runtime.closed) return detachedServer(server);
  let connection: PiMcpConnection | undefined;
  try {
    connection = await connectWithTimeout(testTransport ?? defaultTransport, server);
  } catch (error) {
    return recordConnectFailure(state, server, error);
  }
  // Detached while connecting. Closing here is what keeps a slow first launch
  // from leaking a child process that nothing owns any more.
  if (runtime.closed) {
    await closeConnections(state, [connection]);
    return detachedServer(server);
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

function detachedServer(server: ResolvedMcpServer): NativeAgentMcpServer {
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

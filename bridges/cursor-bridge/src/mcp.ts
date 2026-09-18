import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig, SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import { Client as McpClient, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { resolveCursorSettingSources, workingDirectory } from "./config.js";
import { isObject, nonBlank, type JsonObject, type SessionState } from "./state.js";
import { sliceToBytes } from "./transcript.js";

/** SDK name for in-process custom tools. Remapped to Orkestrator in inventory. */
export const CURSOR_CUSTOM_USER_TOOLS_SERVER = "custom-user-tools";

const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_TOOLS = 128;
/** Server and tool segments alike, matching the bound `runTools` already uses. */
const MAX_MCP_NAME_LENGTH = 128;
/** `mcp__` + server + `__` + tool, so a recorded name cannot outgrow its parts. */
const MAX_MCP_QUALIFIED_NAME_LENGTH =
  "mcp__".length + MAX_MCP_NAME_LENGTH + 2 + MAX_MCP_NAME_LENGTH;
/** Distinct call names retained per session. Names only, so this is small. */
const MAX_OBSERVED_MCP_TOOLS = 512;

export interface AgentMcpConnection {
  url: string;
  token: string;
}

export function parseAgentMcpConnection(value: unknown): AgentMcpConnection | undefined {
  if (!isObject(value)) return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!url || !token || Buffer.byteLength(token, "utf8") > 1024) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return { url, token };
  } catch {
    return undefined;
  }
}

export function mcpConnectionKey(connection?: AgentMcpConnection): string {
  return connection ? `${connection.url}\u0000${connection.token}` : "";
}

export interface CursorMcpResolutionPolicy {
  /**
   * A read-only coordinator must never receive repository-defined servers.
   * The `mcp` capability is granted so Orkestrator stays callable; that
   * grant must not widen to `.cursor/mcp.json`.
   */
  readOnly?: boolean;
  /** Session-level project-resource decision. False skips repository servers. */
  projectResources?: boolean;
}

/**
 * Resolve the MCP launch set handed to Cursor's SDK.
 *
 * Project configuration is intentionally read only when the launcher opted
 * into Cursor's project settings (containers) *and* this session is allowed
 * to use them. A cloned repository therefore cannot make the host bridge
 * execute a command merely by containing `.cursor/mcp.json`. Read-only
 * attaches skip that file even when the process-wide opt-in is on, and
 * return only the scoped Orkestrator entry. The Orkestrator server is
 * supplied by the backend in private environment variables or a per-tab
 * `agentMcp` body and wins a name collision.
 */
export async function cursorMcpServers(
  agentMcp?: AgentMcpConnection,
  policy?: CursorMcpResolutionPolicy,
): Promise<Record<string, McpServerConfig>> {
  const allowProject =
    policy?.readOnly !== true &&
    policy?.projectResources !== false &&
    resolveCursorSettingSources().includes("project");
  const servers = allowProject ? await readProjectMcpServers() : {};
  const url = agentMcp?.url.trim() || process.env.ORKESTRATOR_AGENT_MCP_URL?.trim();
  const token = agentMcp?.token.trim() || process.env.ORKESTRATOR_AGENT_MCP_TOKEN?.trim();
  if (url && token) {
    servers.orkestrator = {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  if (policy?.readOnly === true) {
    return servers.orkestrator ? { orkestrator: servers.orkestrator } : {};
  }
  return servers;
}

const MAX_MCP_DESCRIPTION_BYTES = 4_000;
const MAX_MCP_SCHEMA_BYTES = 20_000;
/** Model-facing MCP tool result budget, measured in UTF-8 bytes. */
export const MAX_MCP_RESULT_BYTES = 50_000;
const CONNECT_TIMEOUT_MS = 3_000;
const TOOL_CALL_TIMEOUT_MS = 120_000;

let connectTimeoutMs = CONNECT_TIMEOUT_MS;
let toolCallTimeoutMs = TOOL_CALL_TIMEOUT_MS;
let testTransport: CursorMcpTransport | undefined;

export interface CursorMcpListedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface CursorMcpConnection {
  tools: CursorMcpListedTool[];
  call(name: string, args: JsonObject): Promise<{ content?: unknown; isError?: boolean }>;
  close(): Promise<void>;
}

export interface CursorMcpTransport {
  connect(url: string, token: string, signal?: AbortSignal): Promise<CursorMcpConnection>;
}

export interface HostedOrkestratorTools {
  customTools: Record<string, SDKCustomTool>;
  toolNames: string[];
  close(): Promise<void>;
}

export function setCursorMcpTransportForTests(transport?: CursorMcpTransport): void {
  testTransport = transport;
}

export function setCursorMcpTimeoutsForTests(options?: {
  connectMs?: number;
  toolCallMs?: number;
}): void {
  connectTimeoutMs = options?.connectMs ?? CONNECT_TIMEOUT_MS;
  toolCallTimeoutMs = options?.toolCallMs ?? TOOL_CALL_TIMEOUT_MS;
}

/**
 * Host Orkestrator MCP tools in-process for a sandboxed coordinator attach.
 *
 * Cursor's SDK rejects HTTP MCP calls on a provider-sandbox + approvals-deny
 * session: there is no approval callback, so those calls fail closed. Custom
 * tools run in this process and do not need that approval. Agent MCP down is
 * a notice, not a failed attach — the session can still inspect the checkout.
 */
export async function hostOrkestratorCustomTools(
  agentMcp?: AgentMcpConnection,
  health?: SessionState["health"],
  options?: { httpFallback?: boolean },
): Promise<HostedOrkestratorTools | undefined> {
  const url = agentMcp?.url.trim() || process.env.ORKESTRATOR_AGENT_MCP_URL?.trim();
  const token = agentMcp?.token.trim() || process.env.ORKESTRATOR_AGENT_MCP_TOKEN?.trim();
  if (!url || !token) return undefined;
  let connection: CursorMcpConnection | undefined;
  try {
    connection = await connectWithTimeout(testTransport ?? defaultTransport, url, token);
  } catch (error) {
    health?.recordNotice({
      message: options?.httpFallback
        ? "Orkestrator MCP failed to connect in-process; this session will try the HTTP MCP client"
        : "Orkestrator MCP failed to connect; this coordinator session will continue without delegation tools",
      method: "mcp/connect",
      severity: "warning",
      source: "bridge",
      detail: publicMcpError(error),
    });
    return undefined;
  }
  const customTools: Record<string, SDKCustomTool> = {};
  const toolNames: string[] = [];
  for (const listed of connection.tools.slice(0, MAX_MCP_TOOLS)) {
    const name = listed.name.trim();
    if (!name || name.length > MAX_MCP_NAME_LENGTH) continue;
    const remoteName = name;
    const inputSchema = toolInputSchema(listed.inputSchema);
    customTools[name] = {
      description: boundedDescription(listed.description, `Orkestrator Control MCP tool ${name}`),
      ...(inputSchema ? { inputSchema } : {}),
      execute: async (args) => {
        const forwardedArgs = args === undefined || args === null ? {} : args;
        if (!isObject(forwardedArgs)) {
          return {
            content: [
              {
                type: "text" as const,
                text: "Invalid tool arguments: expected an object. When using CallDynamicTool, pass arguments as a raw object, never as quoted or JSON-stringified JSON.",
              },
            ],
            isError: true as const,
          };
        }
        const result = await connection.call(remoteName, forwardedArgs);
        return {
          content: [{ type: "text" as const, text: formatMcpContent(result) }],
          ...(result.isError === true ? { isError: true } : {}),
        };
      },
    };
    toolNames.push(name);
  }
  if (toolNames.length === 0) {
    await connection.close().catch(() => undefined);
    return undefined;
  }
  return {
    customTools,
    toolNames,
    close: () => connection.close(),
  };
}

async function connectWithTimeout(
  transport: CursorMcpTransport,
  url: string,
  token: string,
): Promise<CursorMcpConnection> {
  const controller = new AbortController();
  const attempt = transport.connect(url, token, controller.signal);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("Orkestrator MCP timed out"));
    }, connectTimeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    if (!controller.signal.aborted) controller.abort();
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

const defaultTransport: CursorMcpTransport = {
  async connect(url, token, signal) {
    const client = new McpClient(
      { name: "orkestrator-cursor-bridge", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const lifetime = new AbortController();
    let transport: StreamableHTTPClientTransport | undefined;
    const closeClient = async () => {
      if (!lifetime.signal.aborted) lifetime.abort();
      await Promise.allSettled([client.close(), transport?.close() ?? Promise.resolve()]);
    };
    if (signal?.aborted) {
      await closeClient();
      throw new Error("Orkestrator MCP timed out");
    }
    const onAbort = () => {
      void closeClient();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: globalThis.fetch,
    });
    try {
      await client.connect(transport, { signal: lifetime.signal, timeout: connectTimeoutMs });
      const listed = await client.listTools(undefined, {
        signal: lifetime.signal,
        timeout: connectTimeoutMs,
      });
      return {
        tools: (listed.tools ?? []).map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        })),
        call: async (name, args) => {
          const controller = new AbortController();
          const abortCall = () => controller.abort();
          if (lifetime.signal.aborted) abortCall();
          lifetime.signal.addEventListener("abort", abortCall, { once: true });
          const timer = setTimeout(() => controller.abort(), toolCallTimeoutMs);
          timer.unref();
          try {
            const result = await client.callTool(
              { name, arguments: args },
              { signal: controller.signal, timeout: toolCallTimeoutMs },
            );
            return {
              content: result.content,
              ...(result.isError === true ? { isError: true } : {}),
            };
          } finally {
            clearTimeout(timer);
            lifetime.signal.removeEventListener("abort", abortCall);
          }
        },
        close: closeClient,
      };
    } catch (error) {
      await closeClient();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  },
};

function boundedDescription(value: string | undefined, fallback: string): string {
  const text = value?.trim() || fallback;
  const prefixed = text.startsWith("Orkestrator") ? text : `Orkestrator: ${text}`;
  return prefixed.length > MAX_MCP_DESCRIPTION_BYTES
    ? prefixed.slice(0, MAX_MCP_DESCRIPTION_BYTES)
    : prefixed;
}

function toolInputSchema(schema: unknown): Record<string, SDKJsonValue> | undefined {
  if (!isObject(schema)) return undefined;
  try {
    if (Buffer.byteLength(JSON.stringify(schema), "utf8") > MAX_MCP_SCHEMA_BYTES) return undefined;
  } catch {
    return undefined;
  }
  return schema as Record<string, SDKJsonValue>;
}

/**
 * Format an MCP tool result for the model, stopping once the UTF-8 budget is
 * spent so remaining content blocks are never joined or encoded.
 */
export function formatMcpContent(result: { content?: unknown }): string {
  if (Array.isArray(result.content)) {
    let out = "";
    let bytes = 0;
    let hadText = false;
    for (const item of result.content) {
      if (!isObject(item) || typeof item.text !== "string") continue;
      hadText = true;
      const remaining = MAX_MCP_RESULT_BYTES - bytes;
      if (remaining <= 0) break;
      const addition = out.length > 0 ? `\n${item.text}` : item.text;
      const additionBytes = Buffer.byteLength(addition, "utf8");
      if (additionBytes <= remaining) {
        out += addition;
        bytes += additionBytes;
        continue;
      }
      out += sliceToUtf8Budget(addition, remaining);
      break;
    }
    if (hadText) return out;
  }
  try {
    return sliceToUtf8Budget(JSON.stringify(result), MAX_MCP_RESULT_BYTES);
  } catch {
    return "(empty MCP result)";
  }
}

/** Cap UTF-16 units first so a multi-megabyte block never becomes a Buffer. */
function sliceToUtf8Budget(value: string, limit: number): string {
  if (limit <= 0) return "";
  const capped = value.length > limit ? value.slice(0, limit) : value;
  return sliceToBytes(capped, limit);
}

function publicMcpError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 500);
}

function canonicalMcpServer(server: string): string {
  return server === CURSOR_CUSTOM_USER_TOOLS_SERVER ? "orkestrator" : server;
}

export function publicCursorMcpServers(state: SessionState): NativeAgentMcpServer[] {
  const configured = new Set(state.mcpServerNames ?? []);
  const inventory = new Map<string, Set<string>>(
    [...configured].map((name) => [name, new Set<string>()]),
  );
  // Longest-first, so a configured id that itself contains `__` still beats
  // the generic split below. Sorted once here rather than per name.
  const configuredByLength = [...configured].sort((left, right) => right.length - left.length);
  // The system message is Cursor's advertised tool inventory, so counts from
  // it are exact. Some runtimes expose only the generic `mcp` tool there; the
  // observed call names below can still reveal those server names, but seeing
  // one call must not pretend that one tool is the server's complete inventory.
  const reportedInventory = new Set<string>();
  for (const toolName of state.runTools ?? []) {
    const parsed = parseMcpToolName(toolName, configuredByLength);
    if (!parsed) continue;
    const tools = ensureServer(inventory, parsed.server);
    if (!tools) continue;
    if (tools.size < MAX_MCP_TOOLS) tools.add(parsed.tool);
    reportedInventory.add(parsed.server);
  }
  for (const toolName of state.observedMcpTools) {
    const parsed = parseMcpToolName(toolName, configuredByLength);
    if (!parsed) continue;
    const tools = ensureServer(inventory, parsed.server);
    if (tools && tools.size < MAX_MCP_TOOLS) tools.add(parsed.tool);
  }

  return [...inventory].map(([name, toolSet]) => {
    const tools = [...toolSet];
    return {
      id: name,
      name,
      status: tools.length > 0 ? "connected" : "unknown",
      ...(name === "orkestrator"
        ? { scope: "orkestrator" as const }
        : configured.has(name)
          ? { scope: "project" as const }
          : {}),
      ...(reportedInventory.has(name) ? { toolCount: tools.length, tools } : {}),
      actions: [],
    };
  });
}

/**
 * Remember one MCP call by name, outside the transcript.
 *
 * The inventory used to be recovered by scanning `state.messages`, but that is
 * a display buffer `boundTranscript` trims: a server left the panel the moment
 * its last card was evicted, which reads as the server having gone away rather
 * than the card having scrolled off. Only the qualified name is kept — a
 * call's arguments and results never come near this.
 */
export function recordObservedMcpTool(state: SessionState, toolName: string | undefined): void {
  if (toolName === undefined || !toolName.startsWith("mcp__")) return;
  if (state.observedMcpTools.size >= MAX_OBSERVED_MCP_TOOLS) return;
  state.observedMcpTools.add(toolName.slice(0, MAX_MCP_QUALIFIED_NAME_LENGTH));
}

/**
 * Re-observe MCP calls from a transcript a restart recovered.
 *
 * The accumulator is runtime state, like `runTools`, so a new process starts
 * with nothing. The persisted transcript is the only surviving record of what
 * the previous one called, so read it once here instead of leaving the panel
 * short a server until the next turn happens to use it again.
 */
export function seedObservedMcpTools(state: SessionState): void {
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type === "tool-invocation") recordObservedMcpTool(state, part.toolName);
    }
  }
}

function ensureServer(
  inventory: Map<string, Set<string>>,
  server: string,
): Set<string> | undefined {
  const existing = inventory.get(server);
  if (existing) return existing;
  if (inventory.size >= MAX_MCP_SERVERS) return undefined;
  const tools = new Set<string>();
  inventory.set(server, tools);
  return tools;
}

/**
 * Cursor exposes MCP calls as `mcp__<server>__<tool>` names. Prefer an exact
 * configured-server prefix (server ids may themselves contain `__`), then use
 * the first separator for servers loaded from Cursor's user/team settings.
 * Both segments are bounded: a provider names its own tools, and the published
 * inventory is not the place to discover how long one of those names can get.
 */
function parseMcpToolName(
  value: string,
  configuredByLength: readonly string[],
): { server: string; tool: string } | undefined {
  if (!value.startsWith("mcp__")) return undefined;
  for (const server of configuredByLength) {
    const prefix = `mcp__${server}__`;
    if (!value.startsWith(prefix)) continue;
    const tool = value.slice(prefix.length, prefix.length + MAX_MCP_NAME_LENGTH);
    if (nonBlank(tool)) return { server: canonicalMcpServer(server), tool };
  }
  const separator = value.indexOf("__", "mcp__".length);
  if (separator < 0) return undefined;
  const server = value.slice("mcp__".length, separator);
  const tool = value.slice(separator + 2, separator + 2 + MAX_MCP_NAME_LENGTH);
  return nonBlank(server) && nonBlank(tool) && server.length <= MAX_MCP_NAME_LENGTH
    ? { server: canonicalMcpServer(server), tool }
    : undefined;
}

async function readProjectMcpServers(): Promise<Record<string, McpServerConfig>> {
  const path = resolve(workingDirectory, ".cursor", "mcp.json");
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_MCP_CONFIG_BYTES) return {};
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!isObject(parsed) || !isObject(parsed.mcpServers)) return {};
    return Object.fromEntries(
      Object.entries(parsed.mcpServers)
        .flatMap(([name, value]) => {
          const config = normalizeMcpConfig(value);
          return nonBlank(name) && name.length <= 128 && config ? [[name, config] as const] : [];
        })
        .slice(0, MAX_MCP_SERVERS),
    );
  } catch {
    return {};
  }
}

function normalizeMcpConfig(value: unknown): McpServerConfig | undefined {
  if (!isObject(value)) return undefined;
  if (
    nonBlank(value.url) &&
    (value.type === undefined || value.type === "http" || value.type === "sse")
  ) {
    return {
      ...(value.type === "sse" ? { type: "sse" as const } : { type: "http" as const }),
      url: value.url,
      ...(isStringRecord(value.headers) ? { headers: value.headers } : {}),
    };
  }
  if (!nonBlank(value.command) || (value.type !== undefined && value.type !== "stdio")) return;
  return {
    type: "stdio",
    command: value.command,
    ...(Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? { args: value.args.slice(0, 128) }
      : {}),
    ...(isStringRecord(value.env) ? { env: value.env } : {}),
    ...(nonBlank(value.cwd) ? { cwd: value.cwd } : {}),
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.keys(value).length <= 128 &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

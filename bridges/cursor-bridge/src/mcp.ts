import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig } from "@cursor/sdk";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { settingSources, workingDirectory } from "./config.js";
import { isObject, nonBlank, type SessionState } from "./state.js";

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

/**
 * Resolve the MCP launch set handed to Cursor's SDK.
 *
 * Project configuration is intentionally read only when the launcher opted
 * into Cursor's project settings (containers). A cloned repository therefore
 * cannot make the host bridge execute a command merely by containing
 * `.cursor/mcp.json`. The Orkestrator server is supplied by the backend in
 * private environment variables or a per-tab `agentMcp` body and wins a name
 * collision.
 */
export async function cursorMcpServers(
  agentMcp?: AgentMcpConnection,
): Promise<Record<string, McpServerConfig>> {
  const servers = settingSources.includes("project") ? await readProjectMcpServers() : {};
  const url = agentMcp?.url.trim() || process.env.ORKESTRATOR_AGENT_MCP_URL?.trim();
  const token = agentMcp?.token.trim() || process.env.ORKESTRATOR_AGENT_MCP_TOKEN?.trim();
  if (url && token) {
    servers.orkestrator = {
      type: "http",
      url,
      headers: { Authorization: `Bearer ${token}` },
    };
  }
  return servers;
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
    if (nonBlank(tool)) return { server, tool };
  }
  const separator = value.indexOf("__", "mcp__".length);
  if (separator < 0) return undefined;
  const server = value.slice("mcp__".length, separator);
  const tool = value.slice(separator + 2, separator + 2 + MAX_MCP_NAME_LENGTH);
  return nonBlank(server) && nonBlank(tool) && server.length <= MAX_MCP_NAME_LENGTH
    ? { server, tool }
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

/**
 * Resolve which MCP servers a Pi session may launch.
 *
 * Three scopes, same rule as Claude and Cursor:
 * - `orkestrator` always, from the process env or a per-tab `agentMcp` body.
 *   Wins a name collision. The reserved id is never taken from a file.
 * - `user` always, from `<agentDir>/mcp.json` (`~/.pi/agent` on a host).
 * - `project` only when the execution policy opts into project resources,
 *   from `<cwd>/.pi/mcp.json`. A cloned repo must not spawn stdio on the host.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isObject, nonBlank } from "./state.js";

export const ORKESTRATOR_MCP_SERVER_NAME = "orkestrator";
export const AGENT_MCP_URL_ENV = "ORKESTRATOR_AGENT_MCP_URL";
export const AGENT_MCP_TOKEN_ENV = "ORKESTRATOR_AGENT_MCP_TOKEN";

const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_NAME_LENGTH = 64;
const MAX_HEADER_ENTRIES = 16;
const MAX_ARG_ENTRIES = 32;
const ORKESTRATOR_HOSTS = new Set(["127.0.0.1", "localhost", "host.docker.internal"]);

export type McpScope = "orkestrator" | "user" | "project";
export type McpTransport = "http" | "stdio";

export interface AgentMcpConnection {
  url: string;
  token: string;
}

export interface ResolvedMcpServer {
  id: string;
  scope: McpScope;
  transport: McpTransport;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export function parseAgentMcpConnection(value: unknown): AgentMcpConnection | undefined {
  if (!isObject(value)) return undefined;
  const url = typeof value.url === "string" ? value.url.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!url || !token || Buffer.byteLength(token, "utf8") > 1024) return undefined;
  return { url, token };
}

export function orkestratorMcpServer(
  connection?: AgentMcpConnection,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMcpServer | undefined {
  const url = connection?.url?.trim() || env[AGENT_MCP_URL_ENV]?.trim();
  const token = connection?.token?.trim() || env[AGENT_MCP_TOKEN_ENV]?.trim();
  if (!url || !token || Buffer.byteLength(token, "utf8") > 1024) return undefined;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "http:" ||
      !ORKESTRATOR_HOSTS.has(parsed.hostname) ||
      parsed.pathname !== "/mcp" ||
      parsed.username ||
      parsed.password
    ) {
      return undefined;
    }
    return {
      id: ORKESTRATOR_MCP_SERVER_NAME,
      scope: "orkestrator",
      transport: "http",
      url: parsed.toString(),
      headers: { Authorization: `Bearer ${token}` },
    };
  } catch {
    return undefined;
  }
}

export async function loadMcpConfigFile(
  path: string,
  scope: Exclude<McpScope, "orkestrator">,
): Promise<ResolvedMcpServer[]> {
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_MCP_CONFIG_BYTES) return [];
    const parsed: unknown = JSON.parse(await fs.readFile(path, "utf8"));
    if (!isObject(parsed)) return [];
    const record = isObject(parsed.mcpServers) ? parsed.mcpServers : parsed;
    if (!isObject(record)) return [];
    const servers: ResolvedMcpServer[] = [];
    for (const [name, value] of Object.entries(record)) {
      if (servers.length >= MAX_MCP_SERVERS) break;
      const id = sanitizeMcpName(name);
      if (!id || id === ORKESTRATOR_MCP_SERVER_NAME) continue;
      const server = normalizeMcpServer(id, scope, value);
      if (server) servers.push(server);
    }
    return servers;
  } catch {
    return [];
  }
}

export async function resolvePiMcpServers(input: {
  agentDir: string;
  cwd: string;
  projectResources: boolean;
  agentMcp?: AgentMcpConnection;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedMcpServer[]> {
  const user = await loadMcpConfigFile(join(input.agentDir, "mcp.json"), "user");
  const project = input.projectResources
    ? await loadMcpConfigFile(join(input.cwd, ".pi", "mcp.json"), "project")
    : [];
  const merged = new Map<string, ResolvedMcpServer>();
  for (const server of user) merged.set(server.id, server);
  for (const server of project) merged.set(server.id, server);
  const orkestrator = orkestratorMcpServer(input.agentMcp, input.env);
  // The Orkestrator entry is reserved: it is inserted last so it wins a name
  // collision, but the file scopes are truncated first so it is never the entry
  // `slice` discards. Without this, 64 user servers silently disabled agent mail
  // and coordinator delegation.
  const limit = orkestrator ? MAX_MCP_SERVERS - 1 : MAX_MCP_SERVERS;
  const resolved = [...merged.values()].slice(0, limit);
  if (orkestrator) resolved.push(orkestrator);
  return resolved;
}

export function sanitizeMcpName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_MCP_NAME_LENGTH) return undefined;
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
  return /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(sanitized) ? sanitized : undefined;
}

function normalizeMcpServer(
  id: string,
  scope: Exclude<McpScope, "orkestrator">,
  value: unknown,
): ResolvedMcpServer | undefined {
  if (!isObject(value) || value.disabled === true) return undefined;
  const transport = readTransport(value);
  if (transport === "http") {
    if (!nonBlank(value.url) || typeof value.url !== "string") return undefined;
    try {
      const url = new URL(value.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      return {
        id,
        scope,
        transport: "http",
        url: url.toString(),
        ...(isStringRecord(value.headers, MAX_HEADER_ENTRIES) ? { headers: value.headers } : {}),
      };
    } catch {
      return undefined;
    }
  }
  if (transport !== "stdio" || !nonBlank(value.command) || typeof value.command !== "string") {
    return undefined;
  }
  return {
    id,
    scope,
    transport: "stdio",
    command: value.command,
    ...(Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? { args: value.args.slice(0, MAX_ARG_ENTRIES) }
      : {}),
    ...(isStringRecord(value.env, 32) ? { env: value.env } : {}),
  };
}

function readTransport(value: Record<string, unknown>): McpTransport | undefined {
  const declared =
    typeof value.transport === "string"
      ? value.transport
      : typeof value.type === "string"
        ? value.type
        : undefined;
  if (declared === "streamable-http" || declared === "http" || declared === "sse") return "http";
  if (declared === "stdio" || declared === undefined) {
    if (nonBlank(value.url) && typeof value.url === "string") return "http";
    if (nonBlank(value.command) && typeof value.command === "string") return "stdio";
  }
  return undefined;
}

function isStringRecord(value: unknown, maxEntries: number): value is Record<string, string> {
  return (
    isObject(value) &&
    Object.keys(value).length <= maxEntries &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

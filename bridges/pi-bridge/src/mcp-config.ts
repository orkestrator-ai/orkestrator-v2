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
import { homedir } from "node:os";
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
/**
 * Bridge-process variables no MCP server may receive: not through the stdio
 * environment, and not by naming them in a `${NAME}` reference in `mcp.json`.
 */
export const BRIDGE_SECRET_ENV: ReadonlySet<string> = new Set([
  AGENT_MCP_TOKEN_ENV,
  "PI_BRIDGE_TOKEN",
]);

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
  /** Working directory as written; relative paths resolve against the session's. */
  cwd?: string;
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
  env: NodeJS.ProcessEnv = process.env,
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
      const server = normalizeMcpServer(id, scope, value, env);
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
  const env = input.env ?? process.env;
  const user = await loadMcpConfigFile(join(input.agentDir, "mcp.json"), "user", env);
  const project = input.projectResources
    ? await loadMcpConfigFile(join(input.cwd, ".pi", "mcp.json"), "project", env)
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
  env: NodeJS.ProcessEnv,
): ResolvedMcpServer | undefined {
  // `disabled: true` is the Claude/Cursor spelling; `enabled: false` is Pi's own
  // (`pi mcp`, the `/mcp` manager), and both files are the same `mcp.json`.
  if (!isObject(value) || value.disabled === true || value.enabled === false) return undefined;
  const transport = readTransport(value);
  if (transport === "http") {
    if (!nonBlank(value.url) || typeof value.url !== "string") return undefined;
    try {
      const url = new URL(value.url.trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
      const headers = isStringRecord(value.headers, MAX_HEADER_ENTRIES)
        ? resolveConfigValues(value.headers, env)
        : undefined;
      // A header that cannot be resolved would be sent as its literal template.
      if (headers === null) return undefined;
      return {
        id,
        scope,
        transport: "http",
        url: url.toString(),
        ...(headers ? { headers } : {}),
      };
    } catch {
      return undefined;
    }
  }
  if (transport !== "stdio" || !nonBlank(value.command) || typeof value.command !== "string") {
    return undefined;
  }
  const serverEnv = isStringRecord(value.env, 32) ? resolveConfigValues(value.env, env) : undefined;
  if (serverEnv === null) return undefined;
  return {
    id,
    scope,
    transport: "stdio",
    command: expandHome(value.command),
    ...(Array.isArray(value.args) && value.args.every((entry) => typeof entry === "string")
      ? { args: value.args.slice(0, MAX_ARG_ENTRIES).map(expandHome) }
      : {}),
    ...(serverEnv ? { env: serverEnv } : {}),
    ...(nonBlank(value.cwd) && typeof value.cwd === "string" ? { cwd: expandHome(value.cwd) } : {}),
  };
}

/** `~` and `~/…` name the home directory, as Pi's MCP client reads them. */
function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const CONFIG_VALUE_REFERENCE =
  /\$(?:(\$)|(!)|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Resolve one `mcp.json` value the way Pi's own config values resolve:
 * `$NAME` and `${NAME}` read the environment, `$$` and `$!` escape a literal
 * `$` and `!`. A leading `!` means "run this shell command"; the bridge does not
 * execute config-supplied commands, so such a value is unresolvable, and so is
 * a variable that is unset or reserved for the bridge itself.
 */
function resolveConfigValue(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (value.startsWith("!")) return undefined;
  let unresolved = false;
  const resolved = value.replace(
    CONFIG_VALUE_REFERENCE,
    (_match, dollar?: string, bang?: string, braced?: string, bare?: string) => {
      if (dollar) return "$";
      if (bang) return "!";
      const name = braced ?? bare ?? "";
      const replacement = BRIDGE_SECRET_ENV.has(name) ? undefined : env[name];
      if (replacement === undefined) {
        unresolved = true;
        return "";
      }
      return replacement;
    },
  );
  return unresolved ? undefined : resolved;
}

/** `null` when any value cannot be resolved: Pi skips such an entry and reports it. */
function resolveConfigValues(
  values: Record<string, string>,
  env: NodeJS.ProcessEnv,
): Record<string, string> | null {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const next = resolveConfigValue(value, env);
    if (next === undefined) return null;
    resolved[key] = next;
  }
  return resolved;
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

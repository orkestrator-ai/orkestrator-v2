import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import type { McpServerConfig } from "@cursor/sdk";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";
import { settingSources, workingDirectory } from "./config.js";
import { isObject, nonBlank, type SessionState } from "./state.js";

const MAX_MCP_CONFIG_BYTES = 1024 * 1024;
const MAX_MCP_SERVERS = 64;
const MAX_MCP_TOOLS = 128;

/**
 * Resolve the MCP launch set handed to Cursor's SDK.
 *
 * Project configuration is intentionally read only when the launcher opted
 * into Cursor's project settings (containers). A cloned repository therefore
 * cannot make the host bridge execute a command merely by containing
 * `.cursor/mcp.json`. The Orkestrator server is supplied by the backend in
 * private environment variables and wins a name collision.
 */
export async function cursorMcpServers(): Promise<Record<string, McpServerConfig>> {
  const servers = settingSources.includes("project") ? await readProjectMcpServers() : {};
  const url = process.env.ORKESTRATOR_AGENT_MCP_URL?.trim();
  const token = process.env.ORKESTRATOR_AGENT_MCP_TOKEN?.trim();
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
  // The system message is Cursor's advertised tool inventory, so counts from
  // it are exact. Some runtimes expose only the generic `mcp` tool there; the
  // settled call cards below can still reveal those server names, but seeing
  // one call must not pretend that one tool is the server's complete inventory.
  const reportedInventory = new Set<string>();
  for (const toolName of state.runTools ?? []) {
    const parsed = parseMcpToolName(toolName, configured);
    if (!parsed) continue;
    const tools = ensureServer(inventory, parsed.server);
    if (!tools) continue;
    if (tools.size < MAX_MCP_TOOLS) tools.add(parsed.tool);
    reportedInventory.add(parsed.server);
  }
  for (const message of state.messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-invocation" || !nonBlank(part.toolName)) continue;
      const parsed = parseMcpToolName(part.toolName, configured);
      if (!parsed) continue;
      const tools = ensureServer(inventory, parsed.server);
      if (tools && tools.size < MAX_MCP_TOOLS) tools.add(parsed.tool);
    }
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
 */
function parseMcpToolName(
  value: string,
  configured: ReadonlySet<string>,
): { server: string; tool: string } | undefined {
  if (!value.startsWith("mcp__")) return undefined;
  for (const server of [...configured].sort((left, right) => right.length - left.length)) {
    const prefix = `mcp__${server}__`;
    if (value.startsWith(prefix) && nonBlank(value.slice(prefix.length))) {
      return { server, tool: value.slice(prefix.length) };
    }
  }
  const separator = value.indexOf("__", "mcp__".length);
  if (separator < 0) return undefined;
  const server = value.slice("mcp__".length, separator);
  const tool = value.slice(separator + 2);
  return nonBlank(server) && nonBlank(tool) && server.length <= 128 ? { server, tool } : undefined;
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

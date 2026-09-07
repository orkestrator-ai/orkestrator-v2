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
  return (state.mcpServerNames ?? []).map((name) => {
    const prefix = `mcp__${name}__`;
    const tools = (state.runTools ?? [])
      .filter((tool) => tool.startsWith(prefix))
      .map((tool) => tool.slice(prefix.length))
      .filter(Boolean)
      .slice(0, MAX_MCP_TOOLS);
    return {
      id: name,
      name,
      status: tools.length > 0 ? "connected" : "unknown",
      scope: name === "orkestrator" ? "orkestrator" : "project",
      ...(tools.length > 0 ? { toolCount: tools.length, tools } : {}),
      actions: [],
    };
  });
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

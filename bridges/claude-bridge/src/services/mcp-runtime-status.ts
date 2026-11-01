import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";

type McpServerRuntimeStatus = Pick<
  NativeAgentMcpServer,
  "name" | "status" | "scope" | "transport" | "error" | "tools"
>;

/**
 * The layer each server of a session's launch record came from, by name. The
 * bridge passes servers inline, so the CLI reports them as `dynamic` and only
 * the bridge knows which file each one came from (`getMcpRuntimeConfig`).
 */
export type McpServerLayers = ReadonlyMap<string, NonNullable<NativeAgentMcpServer["scope"]>>;

/**
 * Sources the user's MCP files never declare. A same-named server from one of
 * these is not the one the configuration names.
 */
export const FOREIGN_MCP_SOURCES: ReadonlySet<string> = new Set(["plugin", "sdk", "claudeai"]);

/**
 * Live layer of a server as the live panel names it. The SDK reports a
 * config scope (`user`, `project`, `local`, ...) on `mcpServerStatus()` and a
 * `source` on both `mcpServerStatus()` and the init message. A plugin's
 * server has `source: "plugin"` but `scope: "dynamic"` (pinned CLI 2.1.309),
 * so the source decides when there is one. The session's launch record decides
 * over both.
 */
export function mcpScope(
  scope: string | undefined,
  name: string,
  source?: string,
  layers?: McpServerLayers,
): NativeAgentMcpServer["scope"] {
  const layer = FOREIGN_MCP_SOURCES.has(source ?? "") ? undefined : layers?.get(name);
  if (layer) return layer;
  if (name === "orkestrator") return "orkestrator";
  if (source?.includes("plugin") || scope?.includes("plugin")) return "plugin";
  if (scope === "project" || scope === "local") return scope;
  return "user";
}

/** Statuses the SDK uses for MCP servers, mapped to the live panel's. */
export function mcpRuntimeState(status: unknown): McpServerRuntimeStatus["status"] {
  switch (status) {
    case "connected":
    case "failed":
    case "needs-auth":
    case "disabled":
      return status;
    case "pending":
      return "connecting";
    default:
      return "unknown";
  }
}

/**
 * One `mcp_servers` row of the SDK's init message. It carries a name, a
 * status and an optional `source`; the status is kept as reported (a server
 * still connecting or waiting for a sign-in is not a failure), and so is the
 * layer it came from. `error` and `tools` are not part of the SDK's type but
 * are kept when a CLI sends them.
 */
export function initMcpServerStatus(
  raw: {
    name: string;
    status?: unknown;
    source?: unknown;
    error?: unknown;
    tools?: unknown;
  },
  layers?: McpServerLayers,
): McpServerRuntimeStatus {
  const source = typeof raw.source === "string" ? raw.source : undefined;
  return {
    name: raw.name,
    status: mcpRuntimeState(raw.status),
    ...(source || layers?.has(raw.name)
      ? { scope: mcpScope(source, raw.name, source, layers) }
      : {}),
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
    ...(Array.isArray(raw.tools)
      ? { tools: raw.tools.filter((tool): tool is string => typeof tool === "string") }
      : {}),
  };
}

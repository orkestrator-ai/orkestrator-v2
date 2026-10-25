import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";

import type { McpServerRuntimeStatus } from "../types/index.js";

/**
 * Live layer of a server as the live panel names it. The SDK reports a
 * config scope (`user`, `project`, `local`, ...) on `mcpServerStatus()` and a
 * `source` on the init message; both spell plugins with `plugin`.
 */
export function mcpScope(scope: string | undefined, name: string): NativeAgentMcpServer["scope"] {
  if (name === "orkestrator") return "orkestrator";
  if (scope?.includes("plugin")) return "plugin";
  if (scope === "project" || scope === "local") return "project";
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
export function initMcpServerStatus(raw: {
  name: string;
  status?: unknown;
  source?: unknown;
  error?: unknown;
  tools?: unknown;
}): McpServerRuntimeStatus {
  const source = typeof raw.source === "string" ? raw.source : undefined;
  return {
    name: raw.name,
    status: mcpRuntimeState(raw.status),
    ...(source ? { scope: mcpScope(source, raw.name) } : {}),
    ...(typeof raw.error === "string" && raw.error ? { error: raw.error } : {}),
    ...(Array.isArray(raw.tools)
      ? { tools: raw.tools.filter((tool): tool is string => typeof tool === "string") }
      : {}),
  };
}

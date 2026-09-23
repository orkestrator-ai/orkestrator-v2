/**
 * Deep links into MCP server management. The settings surface only carries a
 * section id, so the provider/environment context travels here and is
 * consumed by the section when it mounts (or immediately, if it is mounted).
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";

import { requestGlobalSettings } from "./settings-navigation";

export interface McpSettingsIntent {
  provider?: AgentPlatform;
  environmentId?: string;
  /** Exact native server name, used only to highlight matching rows. */
  serverName?: string;
}

export const MCP_SETTINGS_INTENT_EVENT = "orkestrator:mcp-settings-intent";

let pending: McpSettingsIntent | null = null;

export function requestMcpServerSettings(intent: McpSettingsIntent = {}): void {
  pending = intent;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<McpSettingsIntent>(MCP_SETTINGS_INTENT_EVENT, { detail: intent }),
    );
  }
  requestGlobalSettings("mcp-servers");
}

/** Take the intent recorded before the section mounted, once. */
export function consumeMcpSettingsIntent(): McpSettingsIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

export function onMcpSettingsIntent(listener: (intent: McpSettingsIntent) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    pending = null;
    listener((event as CustomEvent<McpSettingsIntent>).detail ?? {});
  };
  window.addEventListener(MCP_SETTINGS_INTENT_EVENT, handle);
  return () => window.removeEventListener(MCP_SETTINGS_INTENT_EVENT, handle);
}

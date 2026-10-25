/**
 * Deep links into MCP server management. The settings surface only carries a
 * section id, so the provider/environment context travels here and is
 * consumed by the section when it mounts (or immediately, if it is mounted).
 */

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentMcpServer } from "@orkestrator/protocol/native-agent";

import { requestGlobalSettings } from "./settings-navigation";

export interface McpSettingsIntent {
  provider?: AgentPlatform;
  environmentId?: string;
  /**
   * Exact name a live session reports for the server. The section joins it to
   * the saved row that session loads (`joinLiveMcpServer`) only within this
   * intent's provider and environment.
   */
  serverName?: string;
  /** Layer the live session reports the server was loaded from. */
  serverScope?: NativeAgentMcpServer["scope"];
  /** The live session the link came from, to show its apply outcome. */
  logicalSessionKey?: string;
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

/**
 * The intent recorded before the section mounted, left in place. Reading it is
 * safe during render: a render React discards and retries (the settings page
 * is lazy, so its first mount can suspend) reads the same intent again. The
 * section takes it with {@link settleMcpSettingsIntent} once it has mounted.
 */
export function peekMcpSettingsIntent(): McpSettingsIntent | null {
  return pending;
}

/** Drop `intent` after a mounted section applied it; a newer request is kept. */
export function settleMcpSettingsIntent(intent: McpSettingsIntent | null): void {
  if (intent && pending === intent) pending = null;
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

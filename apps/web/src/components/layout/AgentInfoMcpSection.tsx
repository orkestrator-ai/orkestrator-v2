import { useEffect } from "react";

import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { MCP_MANAGEMENT_CHANGED_EVENT } from "@orkestrator/protocol/mcp-management";
import type {
  NativeAgentMcpServer,
  NativeAgentMcpServerAction,
} from "@orkestrator/protocol/native-agent";

import { requestMcpServerSettings } from "@/lib/mcp-settings-navigation";
import { listen } from "@/lib/native/events";
import { dispatchResourceChange } from "@/lib/resource-sync";

import { McpServersPanel } from "./AgentInfoButton.panels";

/**
 * Refetch this session's projection when saved MCP configuration changes.
 *
 * The change event carries opaque target ids and no definitions, so it is
 * only a hint: it is routed into the same `native-agent-session` refresh the
 * session hook already runs for backend resource changes. That refresh reads
 * the backend's projection of the mounted, active tab — it never touches an
 * inactive session and never polls — so a missed event only delays the
 * update until the session's own reconciliation.
 */
export function useMcpRuntimeRefresh(
  environmentId: string,
  agent: AgentPlatform,
  logicalSessionKey: string,
): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen(MCP_MANAGEMENT_CHANGED_EVENT, () => {
      if (disposed) return;
      dispatchResourceChange({
        resource: "native-agent-session",
        id: environmentId,
        agent,
        logicalSessionKey,
        // Local hint, not a backend sequence number; ordering is irrelevant.
        revision: 0,
      });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [environmentId, agent, logicalSessionKey]);
}

/**
 * MCP servers the live session loaded, plus links into saved-configuration
 * management. The panel-level link is always present, including when the
 * session reports no servers, because that is exactly when a user goes
 * looking for where to add one.
 */
export function AgentInfoMcpSection({
  environmentId,
  provider,
  sessionKey,
  servers,
  busyAction,
  onAction,
}: {
  environmentId: string;
  provider: AgentPlatform;
  sessionKey: string;
  /** Undefined when the session does not report its MCP inventory. */
  servers: NativeAgentMcpServer[] | undefined;
  busyAction: string | null;
  onAction: (server: NativeAgentMcpServer, action: NativeAgentMcpServerAction) => void;
}) {
  useMcpRuntimeRefresh(environmentId, provider, sessionKey);
  const manage = (serverName?: string) =>
    requestMcpServerSettings({
      provider,
      environmentId,
      ...(serverName ? { serverName } : {}),
    });
  return (
    <div className="space-y-1.5">
      {servers && servers.length > 0 ? (
        <McpServersPanel
          servers={servers}
          busyAction={busyAction}
          onAction={onAction}
          onManageServer={(server) => manage(server.name)}
        />
      ) : servers ? (
        <p className="text-xs text-muted-foreground">
          This session has not loaded any MCP servers.
        </p>
      ) : null}
      <button
        type="button"
        className="text-left text-xs text-blue-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        onClick={() => manage()}
      >
        Manage saved MCP servers…
      </button>
    </div>
  );
}

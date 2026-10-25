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
import { useEnvironmentStore } from "@/stores/environmentStore";

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
 * Where an environment's MCP servers start and connect from, in the words the
 * MCP settings use for the same target (`McpTargetContext.locationLabel`).
 */
export function mcpExecutionLocationLabel(environment: {
  name: string;
  environmentType?: string;
}): string {
  return environment.environmentType === "local"
    ? `Worktree of ${environment.name} on this backend`
    : `Container of ${environment.name}`;
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
  const environment = useEnvironmentStore((state) =>
    state.environments.find((candidate) => candidate.id === environmentId),
  );
  // A failing server is usually diagnosed by where it was reached from: a
  // container cannot see the host's localhost or its absolute paths.
  const unhealthy = servers?.some(
    (server) => server.status === "failed" || server.status === "needs-auth",
  );
  // A row link carries the row's exact name and layer plus this session, so
  // the section can pick the saved row this session loads, not every row
  // that happens to share the name.
  const manage = (server?: NativeAgentMcpServer) =>
    requestMcpServerSettings({
      provider,
      environmentId,
      ...(server
        ? {
            serverName: provider === "claude" ? server.id : server.name,
            ...(server.scope ? { serverScope: server.scope } : {}),
            logicalSessionKey: sessionKey,
          }
        : {}),
    });
  return (
    <div className="space-y-1.5">
      {servers && servers.length > 0 ? (
        <McpServersPanel
          servers={servers}
          busyAction={busyAction}
          onAction={onAction}
          onManageServer={(server) => manage(server)}
        />
      ) : servers ? (
        <p className="text-xs text-muted-foreground">
          This session has not loaded any MCP servers.
        </p>
      ) : null}
      {unhealthy && environment ? (
        <p className="text-xs text-muted-foreground">
          Connects from {mcpExecutionLocationLabel(environment)}, not from this browser.
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

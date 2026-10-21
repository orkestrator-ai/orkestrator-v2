/**
 * Leaf workspaces: the grant a browser or iOS client uses to work on another
 * node's environments as if it had connected to that node directly.
 *
 * The command node obtains a short-lived client grant from the leaf and
 * hands it to this client with the leaf's direct origins. The client talks
 * to the leaf directly when it can reach it, and otherwise through the
 * command node's relay. Either way it never holds the leaf's gateway token,
 * and the path in use is shown in the info panel.
 */

import { BACKEND_HELLO_PATH, parseBackendHello } from "@orkestrator/protocol/backend-profile";
import type { BackendId } from "@orkestrator/protocol/federation";
import { portalInvoke } from "./portal-transport";

export interface OpenedNodeWorkspace {
  workspaceId: string;
  nodeId: BackendId;
  nodeName: string;
  grant: { token: string; expiresAt: number };
  directOrigins: string[];
  relayBase: string;
  commandRouteKind?: "https" | "ssh";
  loopbackOrigin?: string;
}

/** How the window reaches its workspace's node; shown in the info panel. */
export interface WorkspaceConnectionPath {
  nodeName: string;
  path: "direct" | "relay";
  /** Direct: the leaf's own route. Relay: how the command node reaches the leaf. */
  routeKind?: "https" | "ssh";
  /** The command node, when relayed. */
  via?: string;
}

export interface LeafWorkspace extends WorkspaceConnectionPath {
  workspaceId: string;
  nodeId: BackendId;
  baseUrl: string;
  /** The grant for a direct connection; a relayed one uses this client's own session. */
  token?: string;
  expiresAt: number;
}

const DIRECT_PROBE_TIMEOUT_MS = 3_000;
/** Renew well before the 15-minute grant lapses. */
export const WORKSPACE_RENEW_INTERVAL_MS = 10 * 60_000;

async function reachable(origin: string, token: string, nodeId: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIRECT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(BACKEND_HELLO_PATH, origin), {
      headers: { authorization: `Bearer ${token}` },
      credentials: "omit",
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const hello = parseBackendHello(await response.json());
    return hello?.installationId === nodeId && hello?.endpointRole === "client";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open a node's workspace: direct when one of the node's origins answers
 * with the grant, else relayed through this client's command node.
 */
export async function openLeafWorkspace(
  nodeId: BackendId,
  options: { commandNodeName: string; probe?: typeof reachable } = { commandNodeName: "" },
): Promise<LeafWorkspace> {
  const opened = await portalInvoke<OpenedNodeWorkspace>("open_node_workspace", { nodeId });
  const probe = options.probe ?? reachable;
  for (const origin of opened.directOrigins) {
    if (await probe(origin, opened.grant.token, opened.nodeId)) {
      return {
        workspaceId: opened.workspaceId,
        nodeId,
        nodeName: opened.nodeName,
        baseUrl: origin,
        token: opened.grant.token,
        expiresAt: opened.grant.expiresAt,
        path: "direct",
        routeKind: "https",
      };
    }
  }
  return {
    workspaceId: opened.workspaceId,
    nodeId,
    nodeName: opened.nodeName,
    baseUrl: `${window.location.origin}${opened.relayBase}`,
    expiresAt: opened.grant.expiresAt,
    path: "relay",
    ...(opened.commandRouteKind ? { routeKind: opened.commandRouteKind } : {}),
    ...(options.commandNodeName ? { via: options.commandNodeName } : {}),
  };
}

/**
 * Keep the workspace's grant alive while the window works on it. A renewal
 * the command node refuses (the grant lapsed while the computer slept, the
 * node restarted) is reported once. Returns the stop function.
 */
export function keepWorkspaceAlive(workspaceId: string, onLapsed?: () => void): () => void {
  let lapsed = false;
  const timer = setInterval(() => {
    void portalInvoke("renew_node_workspace", { workspaceId }).catch(() => {
      if (lapsed) return;
      lapsed = true;
      onLapsed?.();
    });
  }, WORKSPACE_RENEW_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** Closing revokes the grant; nothing on the node stops. */
export async function closeLeafWorkspace(workspaceId: string): Promise<void> {
  await portalInvoke("close_node_workspace", { workspaceId }).catch(() => undefined);
}

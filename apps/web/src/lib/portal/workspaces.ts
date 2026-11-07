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
import { nodesApiOver } from "@/lib/node-scope/domains/nodes";
import { commandScopeInvoke } from "./command-scope";

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
  /**
   * The command node's relay base for this node, whichever path is in use:
   * element loads (media, previews) cannot carry the grant, so they go here.
   */
  relayBaseUrl?: string;
}

/** The command node's commands; production uses the window's command scope. */
export type CommandNodeInvoke = <T = unknown>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

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
  options: {
    commandNodeName: string;
    probe?: typeof reachable;
    invoke?: CommandNodeInvoke;
  } = { commandNodeName: "" },
): Promise<LeafWorkspace> {
  const invoke = options.invoke ?? commandScopeInvoke;
  // The web's record names the node with its branded id (plan item 7010 converges them).
  const opened = (await nodesApiOver(invoke).open_node_workspace({
    nodeId,
  })) as OpenedNodeWorkspace;
  const probe = options.probe ?? reachable;
  const relayBaseUrl = `${window.location.origin}${opened.relayBase}`;
  for (const origin of opened.directOrigins) {
    if (await probe(origin, opened.grant.token, opened.nodeId)) {
      return {
        workspaceId: opened.workspaceId,
        nodeId,
        nodeName: opened.nodeName,
        baseUrl: origin,
        token: opened.grant.token,
        expiresAt: opened.grant.expiresAt,
        relayBaseUrl,
        path: "direct",
        routeKind: "https",
      };
    }
  }
  return {
    workspaceId: opened.workspaceId,
    nodeId,
    nodeName: opened.nodeName,
    baseUrl: relayBaseUrl,
    expiresAt: opened.grant.expiresAt,
    relayBaseUrl,
    path: "relay",
    ...(opened.commandRouteKind ? { routeKind: opened.commandRouteKind } : {}),
    ...(options.commandNodeName ? { via: options.commandNodeName } : {}),
  };
}

export interface KeepWorkspaceAliveOptions {
  invoke?: CommandNodeInvoke;
  /** How often the renewal is checked; defaults to 5 s. */
  tickMs?: number;
  /** How long a renewal holds before the next; defaults to `WORKSPACE_RENEW_INTERVAL_MS`. */
  renewIntervalMs?: number;
  /** Where `online` and `focus` are heard; defaults to `window`. */
  events?: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Renew on a bounded tick, retry failed recovery, and reconcile after sleep/reconnect. */
export function keepWorkspaceAlive(
  workspaceId: string,
  onLapsed?: () => Promise<void> | void,
  options: KeepWorkspaceAliveOptions = {},
): () => void {
  const invoke = options.invoke ?? commandScopeInvoke;
  const renewIntervalMs = options.renewIntervalMs ?? WORKSPACE_RENEW_INTERVAL_MS;
  const events = options.events ?? window;
  let stopped = false;
  let running = false;
  let recovered = false;
  let failed = false;
  let renewedAt = Date.now();
  const tick = async (force = false) => {
    if (stopped || running || recovered) return;
    if (!force && !failed && Date.now() - renewedAt < renewIntervalMs) return;
    running = true;
    try {
      if (failed) throw new Error("Workspace needs recovery");
      await nodesApiOver(invoke).renew_node_workspace({ workspaceId });
      renewedAt = Date.now();
    } catch {
      failed = true;
      if (!stopped && onLapsed) {
        try {
          await onLapsed();
          recovered = true;
        } catch {
          /* Retry on the next bounded tick or connectivity event. */
        }
      }
    } finally {
      running = false;
    }
  };
  const reconcile = () => {
    void tick(true);
  };
  const timer = setInterval(() => {
    void tick();
  }, options.tickMs ?? 5_000);
  events.addEventListener("online", reconcile);
  events.addEventListener("focus", reconcile);
  return () => {
    stopped = true;
    clearInterval(timer);
    events.removeEventListener("online", reconcile);
    events.removeEventListener("focus", reconcile);
  };
}

/** Closing revokes the grant; nothing on the node stops. */
export async function closeLeafWorkspace(
  workspaceId: string,
  invoke: CommandNodeInvoke = commandScopeInvoke,
): Promise<void> {
  await nodesApiOver(invoke)
    .close_node_workspace({ workspaceId })
    .catch(() => undefined);
}

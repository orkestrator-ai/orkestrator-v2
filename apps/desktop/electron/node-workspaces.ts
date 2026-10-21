import { checkBackendRoute } from "@orkestrator/protocol/node/node-link/backend-hello";

/**
 * Desktop panels for other nodes' workspaces.
 *
 * The desktop's own backend is its command node. A panel asks it for a
 * workspace of the node (`open_node_workspace`): a short-lived client grant
 * and how the node can be reached. The panel then talks to the node itself:
 * directly over one of the node's HTTPS routes when that answers, otherwise
 * over the command node's own loopback route to it (an SSH forward on this
 * computer). The grant is renewed while the panel is open and revoked when
 * it closes; the node's gateway token never reaches the desktop.
 */

export interface OpenedNodeWorkspace {
  workspaceId: string;
  nodeId: string;
  nodeName: string;
  grant: { token: string; expiresAt: number };
  directOrigins: string[];
  relayBase: string;
  commandRouteKind?: "https" | "ssh";
  loopbackOrigin?: string;
}

export interface WorkspaceBinding {
  workspaceId: string;
  baseUrl: string;
  token: string;
  /** Non-secret parameters for the panel's info panel. */
  params: Record<string, string>;
}

export const WORKSPACE_RENEW_INTERVAL_MS = 10 * 60_000;
const DIRECT_PROBE_TIMEOUT_MS = 3_000;

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Open the node's workspace and choose how the panel reaches it. */
export async function openNodeWorkspace(options: {
  nodeId: string;
  invoke: Invoke;
  commandNodeName: string;
  fetchImpl?: typeof fetch;
}): Promise<WorkspaceBinding> {
  const opened = (await options.invoke("open_node_workspace", {
    nodeId: options.nodeId,
  })) as OpenedNodeWorkspace;
  const answers = async (origin: string) => {
    try {
      const outcome = await checkBackendRoute(origin, opened.grant.token, {
        timeoutMs: DIRECT_PROBE_TIMEOUT_MS,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      // The route must reach the node the grant was issued by.
      return outcome.kind === "hello" && outcome.hello.installationId === opened.nodeId;
    } catch {
      return false;
    }
  };
  for (const origin of opened.directOrigins) {
    if (await answers(origin)) {
      return {
        workspaceId: opened.workspaceId,
        baseUrl: origin,
        token: opened.grant.token,
        params: { node: opened.nodeName, path: "direct", route: "https" },
      };
    }
  }
  if (opened.loopbackOrigin && (await answers(opened.loopbackOrigin))) {
    return {
      workspaceId: opened.workspaceId,
      baseUrl: opened.loopbackOrigin,
      token: opened.grant.token,
      params: {
        node: opened.nodeName,
        path: "relay",
        route: opened.commandRouteKind ?? "ssh",
        via: options.commandNodeName,
      },
    };
  }
  await options
    .invoke("close_node_workspace", { workspaceId: opened.workspaceId })
    .catch(() => undefined);
  throw new Error(`${opened.nodeName} cannot be reached from this computer right now.`);
}

/** Per panel scope: the workspace, its renewal timer, and its release. */
export class NodeWorkspaceScopes {
  private readonly scopes = new Map<
    string,
    { workspaceId: string; timer: ReturnType<typeof setInterval> }
  >();

  constructor(private readonly invoke: Invoke) {}

  track(scope: string, workspaceId: string): void {
    const timer = setInterval(() => {
      void this.invoke("renew_node_workspace", { workspaceId }).catch(() => undefined);
    }, WORKSPACE_RENEW_INTERVAL_MS);
    (timer as { unref?: () => void }).unref?.();
    this.scopes.set(scope, { workspaceId, timer });
  }

  /** The panel closed: revoke its grant. Nothing on the node stops. */
  release(scope: string): void {
    const entry = this.scopes.get(scope);
    if (!entry) return;
    this.scopes.delete(scope);
    clearInterval(entry.timer);
    void this.invoke("close_node_workspace", { workspaceId: entry.workspaceId }).catch(
      () => undefined,
    );
  }

  releaseAll(): void {
    for (const scope of Array.from(this.scopes.keys())) this.release(scope);
  }
}

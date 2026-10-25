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
  nodeId: string;
  baseUrl: string;
  token: string;
  /** Non-secret parameters for the panel's info panel. */
  params: Record<string, string>;
}

export const WORKSPACE_RENEW_INTERVAL_MS = 10 * 60_000;
/**
 * How long a panel in use stays on a relay before the direct route is tried
 * again. One failed probe (a node still starting, say) would otherwise pin the
 * panel to the relay for as long as the relay keeps answering.
 */
export const WORKSPACE_DIRECT_RETRY_MS = 5 * 60_000;
const DIRECT_PROBE_TIMEOUT_MS = 3_000;

export function isDirectBinding(binding: WorkspaceBinding): boolean {
  return binding.params.path === "direct";
}

type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

/** Open the node's workspace and choose how the panel reaches it. */
export async function openNodeWorkspace(options: {
  nodeId: string;
  invoke: Invoke;
  commandNodeName: string;
  fetchImpl?: typeof fetch;
  relay?: () => { baseUrl: string; token: string } | null;
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
        nodeId: opened.nodeId,
        baseUrl: origin,
        token: opened.grant.token,
        params: { node: opened.nodeName, path: "direct", route: "https" },
      };
    }
  }
  if (!options.relay && opened.loopbackOrigin && (await answers(opened.loopbackOrigin))) {
    return {
      workspaceId: opened.workspaceId,
      nodeId: opened.nodeId,
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
  const relay = options.relay?.();
  if (relay)
    return {
      workspaceId: opened.workspaceId,
      nodeId: opened.nodeId,
      baseUrl: `${relay.baseUrl.replace(/\/$/, "")}${opened.relayBase}`,
      token: relay.token,
      params: {
        node: opened.nodeName,
        path: "relay",
        via: options.commandNodeName,
        route: opened.commandRouteKind ?? "https",
      },
    };
  await options
    .invoke("close_node_workspace", { workspaceId: opened.workspaceId })
    .catch(() => undefined);
  throw new Error(`${opened.nodeName} cannot be reached from this computer right now.`);
}

/** Per panel scope: the workspace, its renewal timer, and its release. */
export class NodeWorkspaceScopes {
  private readonly scopes = new Map<
    string,
    {
      workspaceId: string;
      timer: ReturnType<typeof setInterval>;
      invoke: Invoke;
      reopen?: () => Promise<WorkspaceBinding>;
      retarget?: (binding: WorkspaceBinding) => void;
      epoch?: () => number;
      lastEpoch: number;
      renewedAt: number;
      running: boolean;
      failed: boolean;
      /** Bound through the relay rather than the node's own route. */
      relayed: boolean;
      directTriedAt: number;
    }
  >();

  constructor(private readonly invoke: Invoke) {}

  track(
    scope: string,
    workspaceId: string,
    options: {
      invoke?: Invoke;
      reopen?: () => Promise<WorkspaceBinding>;
      retarget?: (binding: WorkspaceBinding) => void;
      epoch?: () => number;
      relayed?: boolean;
    } = {},
  ): void {
    const timer = setInterval(() => {
      const entry = this.scopes.get(scope);
      if (!entry) return;
      if (
        entry.failed ||
        (entry.epoch?.() ?? 0) !== entry.lastEpoch ||
        Date.now() - entry.renewedAt >= WORKSPACE_RENEW_INTERVAL_MS
      ) {
        void this.reconcile(scope);
      }
    }, 5_000);
    timer.unref?.();
    this.scopes.set(scope, {
      workspaceId,
      timer,
      invoke: options.invoke ?? this.invoke,
      ...options,
      lastEpoch: options.epoch?.() ?? 0,
      renewedAt: Date.now(),
      running: false,
      failed: false,
      relayed: options.relayed ?? false,
      directTriedAt: Date.now(),
    });
  }

  /**
   * The panel is in use. A relayed panel whose last direct attempt is older
   * than the retry interval tries the direct route again in the background;
   * an idle panel is never probed.
   */
  noteUse(scope: string): void {
    const entry = this.scopes.get(scope);
    if (!entry?.relayed || entry.running || entry.failed || !entry.reopen) return;
    if (Date.now() - entry.directTriedAt < WORKSPACE_DIRECT_RETRY_MS) return;
    entry.directTriedAt = Date.now();
    void this.upgrade(scope);
  }

  private async upgrade(scope: string): Promise<void> {
    const entry = this.scopes.get(scope);
    if (!entry?.reopen || entry.running) return;
    entry.running = true;
    try {
      const binding = await entry.reopen().catch(() => null);
      if (!binding) return;
      if (this.scopes.get(scope) !== entry || entry.failed || !isDirectBinding(binding)) {
        // Still no better route, or the panel moved on: keep what it has.
        await entry
          .invoke("close_node_workspace", { workspaceId: binding.workspaceId })
          .catch(() => undefined);
        return;
      }
      const oldId = entry.workspaceId;
      entry.retarget?.(binding);
      entry.workspaceId = binding.workspaceId;
      entry.lastEpoch = entry.epoch?.() ?? 0;
      entry.renewedAt = Date.now();
      entry.relayed = false;
      console.info(
        `[Workspaces] ${binding.params.node ?? binding.nodeId} moved to its direct route.`,
      );
      await entry.invoke("close_node_workspace", { workspaceId: oldId }).catch(() => undefined);
    } finally {
      entry.running = false;
    }
  }

  async reconcile(scope: string): Promise<void> {
    const entry = this.scopes.get(scope);
    if (!entry || entry.running) return;
    entry.running = true;
    try {
      if (!entry.failed && (entry.epoch?.() ?? 0) === entry.lastEpoch) {
        await entry.invoke("renew_node_workspace", { workspaceId: entry.workspaceId });
      } else throw new Error("Workspace route changed");
      entry.renewedAt = Date.now();
    } catch {
      entry.failed = true;
      try {
        if (!entry.reopen) return;
        const binding = await entry.reopen();
        if (this.scopes.get(scope) !== entry) {
          await entry
            .invoke("close_node_workspace", { workspaceId: binding.workspaceId })
            .catch(() => undefined);
          return;
        }
        const oldId = entry.workspaceId;
        entry.retarget?.(binding);
        entry.workspaceId = binding.workspaceId;
        entry.lastEpoch = entry.epoch?.() ?? 0;
        entry.renewedAt = Date.now();
        entry.failed = false;
        entry.relayed = !isDirectBinding(binding);
        entry.directTriedAt = Date.now();
        await entry.invoke("close_node_workspace", { workspaceId: oldId }).catch(() => undefined);
      } catch {
        /* Retry with the same captured command node on the next bounded tick. */
      }
    } finally {
      entry.running = false;
    }
  }

  invalidate(scope: string): void {
    const entry = this.scopes.get(scope);
    if (entry) {
      entry.failed = true;
      void this.reconcile(scope);
    }
  }

  release(scope: string): void {
    const entry = this.scopes.get(scope);
    if (!entry) return;
    this.scopes.delete(scope);
    clearInterval(entry.timer);
    void entry
      .invoke("close_node_workspace", { workspaceId: entry.workspaceId })
      .catch(() => undefined);
  }

  releaseAll(): void {
    for (const scope of Array.from(this.scopes.keys())) this.release(scope);
  }
}

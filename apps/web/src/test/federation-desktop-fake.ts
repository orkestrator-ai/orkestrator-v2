/**
 * A fake portal for multi-machine UI tests: the bound backend is a command
 * node that answers `get_node_status` / `get_node_summaries` from fixtures,
 * routes `invoke_on_node` (recorded per node), issues workspaces, and a fake
 * Electron API that records workspace-target switches, with an event bus.
 * Not bundled: only tests import this.
 */
import { mock } from "bun:test";
import type { NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";

export type MachineDataset = {
  projects: Array<Record<string, unknown>>;
  environments: Record<string, Array<Record<string, unknown>>>;
};

/** `connectionId` is the fixture machine ID (`a`, `b`); its node is `bk_<id>`. */
export type InvokeCall = { connectionId: string; command: string; args: Record<string, unknown> };

export const SELF_NODE_ID = "bk_self" as BackendId;

/** Returned from `respond` to simulate a routed write whose answer was lost. */
export const OUTCOME_UNKNOWN = Symbol("outcome-unknown");

export function remoteConnection(
  id: string,
  name: string,
  colorToken: string,
  extra: Partial<ConnectionSummary> = {},
): ConnectionSummary {
  return {
    id,
    name,
    address: `https://${id}.example`,
    kind: "remote",
    active: false,
    requiresToken: false,
    backendId: `bk_${id}` as BackendId,
    identity: "verified",
    transport: "connected",
    profile: { displayName: name, colorToken, revision: 3, cached: false },
    ...extra,
  };
}

export const LOCAL_BOUND_CONNECTION: ConnectionSummary = {
  id: "local",
  name: "Local",
  address: null,
  kind: "local",
  active: true,
  requiresToken: false,
  backendId: SELF_NODE_ID,
  identity: "verified",
  transport: "connected",
};

export function connectionList(remotes: ConnectionSummary[]): ConnectionList {
  return {
    activeConnectionId: "local",
    connections: [LOCAL_BOUND_CONNECTION, ...remotes],
    features: { federation: true, sshRoutes: true, routeFallback: true },
    supportedRouteKinds: ["https", "ssh"],
  };
}

/**
 * Two machines with deliberately identical project and environment IDs and
 * the same project name. Only the machine tells them apart.
 */
export function sharedIdDataset(activity: "working" | "waiting" | "idle"): MachineDataset {
  return {
    projects: [{ id: "project-1", name: "app", order: 0 }],
    environments: {
      "project-1": [
        {
          id: "env-1",
          projectId: "project-1",
          name: "feature",
          status: "running",
          agentActivityState: activity,
        },
      ],
    },
  };
}

function nodeView(connection: ConnectionSummary): NodeView {
  const connected = connection.transport === "connected";
  return {
    nodeId: connection.backendId!,
    enabled: true,
    displayName: connection.profile?.displayName ?? connection.name,
    ...(connection.profile?.colorToken ? { colorToken: connection.profile.colorToken } : {}),
    fallbackName: connection.name,
    routes: [],
    routeOrder: [],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: {
      state: connected ? "connected" : "unavailable",
      epoch: 1,
      ...(connected ? {} : { lastError: { code: "unreachable", message: "Connection lost" } }),
    },
    addedAt: "2026-10-21T00:00:00.000Z",
    source: "portal",
  };
}

export type DesktopFake = ReturnType<typeof installDesktopFake>;

export function installDesktopFake(options: {
  list: ConnectionList;
  datasets: Record<string, MachineDataset>;
  /** Answer a routed command; return `undefined` to fall through to the default. */
  respond?: (call: InvokeCall) => unknown;
}) {
  const calls: InvokeCall[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextWorkspace = 1;
  const remotes = options.list.connections.filter((connection) => connection.kind !== "local");

  const summaries = (): NodeSummary[] =>
    remotes.map((connection) => {
      const nodeId = connection.backendId!;
      const data = options.datasets[connection.id];
      const projects = (data?.projects ?? []).flatMap((raw, index) => {
        const project = toNodeProjectSummary(nodeId, raw, index);
        return project ? [project] : [];
      });
      const environments = Object.values(data?.environments ?? {}).flatMap((list) =>
        list.flatMap((raw, index) => {
          const environment = toNodeEnvironmentSummary(nodeId, raw, index);
          return environment ? [environment] : [];
        }),
      );
      const view = nodeView(connection);
      return {
        nodeId,
        view,
        available: view.connection.state === "connected",
        freshness: view.connection.state === "connected" ? "current" : "stale",
        loadedAt: 1,
        truncated: false,
        lastError: null,
        projects,
        environments,
      };
    });

  const status: NodeStatus = {
    nodeId: SELF_NODE_ID,
    mode: remotes.length > 0 ? "command" : "standalone",
    registrationEnabled: true,
    controllers: [],
    detachedControllers: [],
    suspendedSubordinateCount: 0,
  };

  const outcomes: Array<{
    outcomeId: string;
    nodeId: string;
    command: string;
    recordedAt: string;
  }> = [];

  const invoke = nativeInvoke as unknown as ReturnType<typeof mock>;
  invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_node_status") return structuredClone(status);
    if (command === "get_node_summaries") return { selfId: SELF_NODE_ID, nodes: summaries() };
    if (command === "get_backend_profile") {
      return { revision: 1, displayName: "This computer", colorToken: "violet", updatedAt: "t" };
    }
    if (command === "list_node_outcomes") {
      return outcomes.filter((entry) => !args.nodeId || entry.nodeId === args.nodeId);
    }
    if (command === "dismiss_node_outcome") {
      const index = outcomes.findIndex((entry) => entry.outcomeId === args.outcomeId);
      if (index >= 0) outcomes.splice(index, 1);
      return { dismissed: index >= 0 };
    }
    if (command === "open_node_workspace") {
      const id = nextWorkspace++;
      return {
        workspaceId: `workspace-${id}`,
        nodeId: args.nodeId,
        nodeName: String(args.nodeId),
        grant: { token: `okg_${id}.secret`, expiresAt: Date.now() + 60_000 },
        directOrigins: [],
        relayBase: `/__orkestrator/nodes/${String(args.nodeId)}`,
        commandRouteKind: "https",
      };
    }
    if (command === "renew_node_workspace" || command === "close_node_workspace") return {};
    if (command === "invoke_on_node") {
      const nodeId = String(args.nodeId);
      const call: InvokeCall = {
        connectionId: nodeId.replace(/^bk_/, ""),
        command: String(args.command),
        args: (args.args as Record<string, unknown>) ?? {},
      };
      calls.push(call);
      const custom = await options.respond?.(call);
      if (custom === OUTCOME_UNKNOWN) {
        const outcomeId = `outcome-${outcomes.length + 1}`;
        outcomes.push({ outcomeId, nodeId, command: call.command, recordedAt: "t" });
        return { outcome: "unknown", requestKey: String(args.requestKey), outcomeId };
      }
      if (custom instanceof Error) throw custom;
      return { outcome: "ok", result: custom ?? { ok: true, id: "created-env" } };
    }
    return undefined;
  });

  const workspaceTarget = { set: mock(async (_nodeId: string | null) => undefined) };

  const connections = {
    list: mock(async () => options.list),
    probe: mock(async () => true),
    connect: mock(async () => options.list),
    updateToken: mock(async () => options.list),
    use: mock(async () => options.list),
    forget: mock(async () => options.list),
    answerSshPrompt: mock((_promptId: string, _answer: string | null) => undefined),
  };

  const listen = mock(<T>(event: string, callback: (payload: T) => void) => {
    const set = listeners.get(event) ?? new Set();
    set.add(callback as (payload: unknown) => void);
    listeners.set(event, set);
    return () => set.delete(callback as (payload: unknown) => void);
  });

  window.orkestrator = {
    invoke: mock(async () => undefined) as unknown as NonNullable<Window["orkestrator"]>["invoke"],
    listen: listen as unknown as NonNullable<Window["orkestrator"]>["listen"],
    clipboard: {
      readText: mock(async () => ""),
      writeText: mock(async () => undefined),
      readImage: mock(async () => null),
      writeImage: mock(async () => undefined),
    },
    connections,
    workspaceTarget,
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  } as never;

  void portalStore.refresh();

  return {
    calls,
    invoke,
    workspaceTarget,
    connections,
    listen,
    outcomes,
    emit(event: string, payload: unknown) {
      for (const listener of Array.from(listeners.get(event) ?? [])) listener(payload);
    },
    callsTo(connectionId: string, command?: string) {
      return calls.filter(
        (call) => call.connectionId === connectionId && (!command || call.command === command),
      );
    },
  };
}

export function uninstallDesktopFake(): void {
  const invoke = nativeInvoke as unknown as ReturnType<typeof mock>;
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve());
  portalStore.store.setState({
    selfId: null,
    status: null,
    nodes: [],
    self: null,
    loaded: false,
    unsupported: false,
    outcomesRevision: 0,
  });
  delete window.orkestrator;
}

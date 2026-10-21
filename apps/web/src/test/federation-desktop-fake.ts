/**
 * A fake Electron desktop API for multi-machine UI tests: a connection
 * catalogue, per-connection backends answering summary reads from fixtures,
 * workspace panels and an event bus for `window.orkestrator.listen`. Not
 * bundled: only tests import this.
 */
import { mock } from "bun:test";
import type { ConnectionList, ConnectionSummary } from "@orkestrator/protocol/connections";
import type { BackendId } from "@orkestrator/protocol/federation";
import { resetDesktopBackendDispatcherForTests } from "@/lib/federation/backend-client";

export type MachineDataset = {
  projects: Array<Record<string, unknown>>;
  environments: Record<string, Array<Record<string, unknown>>>;
};

export type InvokeCall = { connectionId: string; command: string; args: Record<string, unknown> };

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

export type DesktopFake = ReturnType<typeof installDesktopFake>;

export function installDesktopFake(options: {
  list: ConnectionList;
  datasets: Record<string, MachineDataset>;
  /** Answer a command; return `undefined` to fall through to the default. */
  respond?: (call: InvokeCall) => unknown;
}) {
  const calls: InvokeCall[] = [];
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextPanel = 1;

  const invoke = mock(
    async (connectionId: string, command: string, args: Record<string, unknown> = {}) => {
      const call = { connectionId, command, args };
      calls.push(call);
      const custom = options.respond?.(call);
      if (custom !== undefined) return await custom;
      const data = options.datasets[connectionId];
      if (command === "get_projects") return structuredClone(data?.projects ?? []);
      if (command === "get_environment_snapshots") {
        return structuredClone(data?.environments[String(args.projectId)] ?? []);
      }
      return { ok: true };
    },
  );
  const observe = mock(async (connectionId: string) => {
    const summary = options.list.connections.find((connection) => connection.id === connectionId);
    if (!summary) throw new Error(`unknown connection ${connectionId}`);
    return summary;
  });
  const unobserve = mock(async (_connectionId: string) => undefined);
  const onEvent = mock(
    (_listener: (connectionId: string, epoch: number, event: string, payload: unknown) => void) =>
      () =>
        undefined,
  );

  const panels = {
    open: mock(
      async (_input: { connectionId: string; projectId: string; environmentId?: string }) => ({
        panelId: `native-panel-${nextPanel++}`,
      }),
    ),
    setBounds: mock(async () => undefined),
    setVisible: mock(async () => undefined),
    close: mock(async (_panelId: string) => undefined),
    onEvent: mock(() => () => undefined),
  };

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
    backends: {
      invoke: invoke as unknown as NonNullable<
        NonNullable<Window["orkestrator"]>["backends"]
      >["invoke"],
      observe,
      unobserve,
      onEvent,
    },
    panels,
    process: { exit: mock(async () => undefined) },
    window: { startDragging: mock(async () => undefined) },
  };

  return {
    calls,
    invoke,
    observe,
    unobserve,
    panels,
    connections,
    listen,
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
  resetDesktopBackendDispatcherForTests();
  delete window.orkestrator;
}

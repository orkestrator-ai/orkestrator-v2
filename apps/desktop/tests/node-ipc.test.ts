import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  DesktopWindowContexts,
  type DesktopWindowConnections,
  type DesktopWindowContextRecord,
} from "../electron/desktop-window-contexts";
import { MAX_INVOKE_ENVELOPE_LENGTH, parseInvokeOptions, registerMainIpc } from "../electron/ipc";
import {
  DesktopNodeIpc,
  NodeRefusal,
  NODE_EVENT_CHANNEL,
  NODE_SCOPE_RELEASED_EVENT,
  nodeRefusal,
} from "../electron/node-ipc";
import { DesktopNodeScopes, type NodeScopeRecord } from "../electron/node-scopes";
import { NodeWorkspaceScopes } from "../electron/node-workspaces";
import {
  createOrkestratorElectronApi,
  NODE_EVENT_CHANNEL as PRELOAD_NODE_EVENT_CHANNEL,
  type IpcRendererLike,
} from "../electron/preload-api";

const TRUSTED = "file:///app/web/index.html";
const COMMAND_NODE = "bk_cmd";

type Context = DesktopWindowContextRecord & {
  nodes: Map<string, NodeScopeRecord>;
};
type Handler = (event: unknown, ...args: unknown[]) => unknown;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(done()).toBe(true);
}

/**
 * Main as the window renderer meets it: the IPC handlers, the window
 * bookkeeping, node scopes and a fake connection manager whose workspace
 * connections answer as their node.
 */
function harness() {
  /** Each scope's bound connection, as the connection manager holds it. */
  const routes = new Map<string, string>();
  /** Workspace connection → the node it reaches. */
  const workspaces = new Map<string, string>();
  const known = new Set(["bk_a", "bk_b"]);
  const calls: Array<{ command: string; args: Record<string, unknown>; scope: string }> = [];
  const revoked: string[] = [];
  let gate: Promise<void> | null = null;
  let grants = 0;
  const connectionOf = (scope: string) => {
    const connectionId = routes.get(scope);
    if (!connectionId) throw new Error("The requesting window is no longer available.");
    return connectionId;
  };
  const invoke = mock(async (command: string, args: Record<string, unknown> = {}, scope = "") => {
    const connectionId = connectionOf(scope);
    calls.push({ command, args, scope });
    if (command === "list_nodes") return { nodes: [...known].map((nodeId) => ({ nodeId })) };
    if (command === "get_backend_profile") return { displayName: "Command" };
    if (command === "close_node_workspace") {
      revoked.push(String(args.workspaceId));
      return {};
    }
    if (command === "renew_node_workspace") return {};
    if (command === "open_node_workspace") {
      if (gate) await gate;
      grants++;
      const nodeId = String(args.nodeId);
      return {
        workspaceId: `grant-${grants}-${nodeId}`,
        nodeId,
        nodeName: `Machine ${nodeId}`,
        grant: { token: `secret-${grants}`, expiresAt: Date.now() + 900_000 },
        directOrigins: [],
        relayBase: `/__orkestrator/nodes/${nodeId}`,
      };
    }
    return { node: workspaces.get(connectionId) ?? connectionId, command, args };
  });
  const manager = {
    bind: mock(async (scope: string, connectionId: string) => {
      if (routes.has(scope)) throw new Error("Connection scope is already active.");
      routes.set(scope, connectionId);
      return { activeConnectionId: connectionId, connections: [] };
    }),
    getConnectionId: connectionOf,
    invoke,
    getGatewayBaseUrl: (scope: string) => {
      const connectionId = routes.get(scope);
      const node = connectionId && workspaces.get(connectionId);
      return node ? `https://command.test/__orkestrator/nodes/${node}` : "https://command.test";
    },
    getRendererRequestAuthorization: () => "Bearer command-secret",
    retargetScopeToWorkspace: (scope: string, input: { workspaceId: string; nodeId?: string }) => {
      connectionOf(scope);
      const connectionId = `workspace:${input.workspaceId}`;
      routes.set(scope, connectionId);
      workspaces.set(connectionId, input.nodeId ?? "");
    },
    release: mock((scope: string) => {
      routes.delete(scope);
    }),
    epochOf: () => 1,
    rebindWorkspace: () => undefined,
    getBackendIdentity: (scope: string) => {
      const connectionId = connectionOf(scope);
      return {
        connectionId,
        backendId:
          connectionId === "command" ? COMMAND_NODE : (workspaces.get(connectionId) ?? null),
        legacyOrigin: null,
      };
    },
    isScopeOnThisDevice: () => false,
    use: mock(async () => ({ activeConnectionId: "command", connections: [] })),
    connect: mock(async () => ({})),
    forget: mock(async () => ({})),
    getList: () => ({ activeConnectionId: "command", connections: [] }),
    setRelayedEvents: mock(() => undefined),
    relayedEventReady: mock(async () => undefined),
  };
  const scopes = new NodeWorkspaceScopes((command, args) =>
    invoke(command, args, "command-default"),
  );
  const nodeScopes = new DesktopNodeScopes({
    manager: () => manager as never,
    scopes: () => scopes,
  });
  const windows: DesktopWindowContexts<Context> = new DesktopWindowContexts<Context>({
    connections: () => manager as unknown as DesktopWindowConnections,
    createPreviews: () => ({
      manager: { destroyAll: () => undefined },
      previewTransport: { disposeAll: async () => undefined },
    }),
    cancelPrompts: () => undefined,
    releaseWorkspaceGrant: (scope) => scopes.release(scope),
    releaseNodeScopes: (context) => nodeScopes.releaseWindowNodeScopes(context),
    releaseSlot: () => undefined,
    setConnectionTitle: () => undefined,
    publishConnectionLists: () => undefined,
    menuChanged: () => undefined,
    logger: { warn: () => undefined },
  });
  const nodeIpc = new DesktopNodeIpc<Context>({
    nodeScopes,
    manager: () => manager as never,
    mapNodeConnection: (context, nodeId, connectionId) =>
      windows.mapNodeConnection(context, nodeId, connectionId),
  });
  cleanups.push(() => {
    nodeScopes.dispose();
    scopes.releaseAll();
  });

  const handlers = new Map<string, Handler>();
  const forEvent = (event: unknown) => windows.forEvent(event as { sender?: { id: number } });
  const commandInvoke = mock(
    (command: string, args: Record<string, unknown>, options?: unknown, scope = "") =>
      options === undefined
        ? invoke(command, args, scope)
        : invoke(command, { ...args, options }, scope),
  );
  const unused = () => {
    throw new Error("unused in this test");
  };
  registerMainIpc({
    getBackend: (event, nodeId) => {
      if (nodeId !== undefined) return nodeIpc.backendFor(forEvent(event), nodeId);
      const scope = forEvent(event).scope;
      return {
        invoke: (command, args, ...rest: unknown[]) =>
          rest.length === 0
            ? commandInvoke(command, args, undefined, scope)
            : commandInvoke(command, args, rest[0], scope),
      };
    },
    getMainWindow: () => null,
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    clipboardApi: {} as never,
    createClipboardItem: unused as never,
    shellApi: { openExternal: async () => undefined },
    appApi: { exit: unused, quit: unused, relaunch: unused },
    nativeImageApi: {} as never,
    getMacOsPermissions: unused as never,
    getWebClientStatus: (event, nodeId) =>
      ({ scope: nodeIpc.adminScope(forEvent(event), nodeId) }) as never,
    setWebClientEnabled: async (_enabled, event, nodeId) =>
      ({ scope: nodeIpc.adminScope(forEvent(event), nodeId) }) as never,
    resetWebClientServe: async (event, nodeId) =>
      ({ scope: nodeIpc.adminScope(forEvent(event), nodeId) }) as never,
    getGatewayTokenSettings: async (event, nodeId) =>
      ({ scope: nodeIpc.adminScope(forEvent(event), nodeId) }) as never,
    setGatewayToken: async (_token, event, nodeId) =>
      ({ scope: nodeIpc.adminScope(forEvent(event), nodeId) }) as never,
    listConnections: unused as never,
    probeConnection: unused as never,
    connectToRemote: unused as never,
    updateConnectionToken: unused as never,
    renameConnection: unused as never,
    useConnection: unused as never,
    previewCommandHandover: unused as never,
    handOverCommandNode: unused as never,
    forgetConnection: unused as never,
    openConnectionWindow: unused as never,
    trustedRendererUrl: TRUSTED,
    nodes: {
      open: (event, nodeId) => nodeIpc.openForRenderer(forEvent(event), nodeId),
      release: (event, nodeId) => nodeIpc.release(forEvent(event), nodeId),
      gateway: (event, nodeId) => nodeIpc.gateway(forEvent(event), nodeId),
    },
  });

  /** A window and its renderer, talking to main only over (fake) IPC. */
  function renderer(id: number) {
    let destroyed = false;
    const scope = `scope-${id}`;
    routes.set(scope, "command");
    const sent: unknown[][] = [];
    const listeners = new Map<string, Array<(event: unknown, ...args: unknown[]) => void>>();
    const ipcListenCount = (channel: string) => listeners.get(channel)?.length ?? 0;
    const contents = {
      id,
      isDestroyed: () => destroyed,
      send: (channel: string, ...args: unknown[]) => {
        sent.push([channel, ...args]);
        for (const listener of listeners.get(channel) ?? []) listener({}, ...args);
      },
    };
    const context: Context = {
      window: { isDestroyed: () => destroyed } as never,
      contents,
      scope,
      slot: id,
      previewConnectionId: "command",
      browserPreviewManager: { destroyAll: () => undefined },
      previewTransport: { disposeAll: async () => undefined },
      artifactHosts: { dispose: () => undefined },
      nodes: new Map(),
    };
    const closed = windows.register(context);
    const sender = { sender: { id }, senderFrame: { url: TRUSTED } };
    const ipcRenderer: IpcRendererLike = {
      invoke: async <T>(channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`missing handler: ${channel}`);
        return (await handler(sender, ...args)) as T;
      },
      on: (channel, listener) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
      },
    };
    const api = createOrkestratorElectronApi(ipcRenderer);
    return {
      api,
      context,
      sent,
      ipcListenCount,
      raw: (channel: string, ...args: unknown[]) => handlers.get(channel)!(sender, ...args),
      close: () => {
        destroyed = true;
        closed();
      },
    };
  }

  return {
    manager,
    routes,
    calls,
    revoked,
    known,
    windows,
    renderer,
    commandInvoke,
    hold: (value: Promise<void> | null) => {
      gate = value;
    },
    opens: () => calls.filter((call) => call.command === "open_node_workspace"),
    /** The connection a window's node scope is bound to. */
    connection: (windowId: number, nodeId: string) =>
      routes.get(`scope-${windowId}:node:${nodeId}`)!,
  };
}

describe("node-addressed invoke and events through main", () => {
  test("main rethrows an already coded refusal without replacing its instance", async () => {
    const h = harness();
    const w = h.renderer(1);
    const refusal = nodeRefusal("node-unavailable", "Machine is offline.");
    h.commandInvoke.mockRejectedValueOnce(refusal);

    // Call main directly: preload reconstructs errors, so it cannot establish
    // that the main handler preserves the original instance and tagged class.
    const error = await Promise.resolve(w.raw("orkestrator:invoke", "get_projects", {})).catch(
      (error: unknown) => error,
    );
    expect(error).toBe(refusal);
    expect(error).toBeInstanceOf(NodeRefusal);
    expect(error).toMatchObject({
      _tag: "NodeRefusal",
      code: "node-unavailable",
      message: "[node-unavailable] Machine is offline.",
    });
  });

  test("a renderer invokes and listens on two nodes at once", async () => {
    const h = harness();
    const w = h.renderer(1);
    const a = w.api.node("bk_a");
    const b = w.api.node("bk_b");
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const gotCommand: unknown[] = [];
    a.listen("project-updated", (payload) => void gotA.push(payload));
    b.listen("project-updated", (payload) => void gotB.push(payload));
    w.api.listen("project-updated", (payload) => void gotCommand.push(payload));

    const [fromA, fromB] = await Promise.all([
      a.invoke("get_projects", { page: 1 }),
      b.invoke("get_projects"),
    ]);
    expect(fromA).toEqual({ node: "bk_a", command: "get_projects", args: { page: 1 } });
    expect(fromB).toEqual({ node: "bk_b", command: "get_projects", args: {} });
    await Promise.all([a.eventStreamReady("project-updated"), b.eventStreamReady("x")]);
    // One grant per node, whatever opened it first (listen, invoke or ready).
    expect(
      h
        .opens()
        .map((call) => call.args.nodeId)
        .sort(),
    ).toEqual(["bk_a", "bk_b"]);
    expect(a.eventStreamConnection.state()).toBe("connected");
    expect(b.eventStreamConnection.state()).toBe("connected");

    h.windows.relayBackendEvent(h.connection(1, "bk_a"), "project-updated", { from: "a" });
    h.windows.relayBackendEvent(h.connection(1, "bk_b"), "project-updated", { from: "b" });
    h.windows.relayBackendEvent("command", "project-updated", { from: "command" });
    expect(gotA).toEqual([{ from: "a" }]);
    expect(gotB).toEqual([{ from: "b" }]);
    expect(gotCommand).toEqual([{ from: "command" }]);
    // The command node's own invoke is unchanged.
    expect(await w.api.invoke("get_projects")).toEqual({
      node: "command",
      command: "get_projects",
      args: {},
    });
    // One IPC listener for every node's events.
    expect(w.ipcListenCount(NODE_EVENT_CHANNEL)).toBe(1);
  });

  test("an event for node B never reaches a node-A listener, terminal output included", async () => {
    const h = harness();
    const w = h.renderer(1);
    const other = h.renderer(2);
    const a = w.api.node("bk_a");
    const b = w.api.node("bk_b");
    const gotA: unknown[] = [];
    const gotB: unknown[] = [];
    const gotOther: unknown[] = [];
    a.listen("terminal-output-s1", (payload) => void gotA.push(payload));
    b.listen("terminal-output-s1", (payload) => void gotB.push(payload));
    other.api.node("bk_a").listen("terminal-output-s1", (payload) => void gotOther.push(payload));
    await Promise.all([
      a.eventStreamReady("x"),
      b.eventStreamReady("x"),
      other.api.node("bk_a").eventStreamReady("x"),
    ]);

    h.windows.relayBackendEvent(h.connection(1, "bk_b"), "terminal-output-s1", { data: "b" });
    expect(gotA).toEqual([]);
    expect(gotB).toEqual([{ data: "b" }]);
    expect(gotOther).toEqual([]);
    // Two windows on one node hold two connections; each gets only its own.
    h.windows.relayBackendEvent(h.connection(2, "bk_a"), "terminal-output-s1", { data: "a2" });
    expect(gotA).toEqual([]);
    expect(gotOther).toEqual([{ data: "a2" }]);
    // Tagged by node on the wire.
    expect(w.sent).toContainEqual([
      NODE_EVENT_CHANNEL,
      "bk_b",
      "terminal-output-s1",
      { data: "b" },
    ]);
  });

  test("a window closed mid-open leaves no scope and the invoke is refused with a code", async () => {
    const h = harness();
    const w = h.renderer(1);
    const gate = deferred();
    h.hold(gate.promise);
    const pending = w.api.node("bk_a").invoke("get_projects");
    await until(() => h.opens().length === 1);
    w.close();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ code: "node-scope-closed" });
    await until(() => h.revoked.length === 1);
    expect(h.revoked).toEqual(["grant-1-bk_a"]);
    expect(w.context.nodes.size).toBe(0);
    expect([...h.routes.keys()].filter((scope) => scope.startsWith("scope-1"))).toEqual([]);
    expect(w.sent.filter(([channel]) => channel === NODE_EVENT_CHANNEL)).toEqual([]);
  });

  test("an unknown node is refused with a code before any grant is asked for", async () => {
    const h = harness();
    const w = h.renderer(1);
    await expect(w.api.node("bk_nobody").invoke("get_projects")).rejects.toMatchObject({
      code: "unknown-node",
      message: expect.stringContaining("[unknown-node]"),
    });
    await expect(w.api.nodes.open("bk_nobody")).rejects.toMatchObject({ code: "unknown-node" });
    expect(h.opens()).toEqual([]);
    expect(w.context.nodes.size).toBe(0);
  });

  test("a node that cannot open is refused as unavailable", async () => {
    const h = harness();
    const w = h.renderer(1);
    h.known.add("bk_down");
    // `open_node_workspace` fails: the node is known but not connected.
    const failing = Promise.reject(new Error("That node is not connected."));
    failing.catch(() => undefined);
    h.hold(failing);
    await expect(w.api.node("bk_down").invoke("get_projects")).rejects.toMatchObject({
      code: "node-unavailable",
      message: "[node-unavailable] That node is not connected.",
    });
    expect(w.context.nodes.size).toBe(0);
  });

  test("machine administration names a node and a leaf is refused", async () => {
    const h = harness();
    const w = h.renderer(1);
    expect(await w.api.webClient.getStatus()).toEqual({ scope: "scope-1" } as never);
    expect(await w.api.webClient.getStatus({ nodeId: COMMAND_NODE })).toEqual({
      scope: "scope-1",
    } as never);
    await expect(w.api.webClient.getStatus({ nodeId: "bk_a" })).rejects.toMatchObject({
      code: "node-admin-refused",
    });
    await expect(w.api.webClient.setEnabled(true, { nodeId: "bk_a" })).rejects.toMatchObject({
      code: "node-admin-refused",
    });
    await expect(w.api.webClient.resetServe({ nodeId: "bk_a" })).rejects.toMatchObject({
      code: "node-admin-refused",
    });
    await expect(w.api.webClient.getTokenSettings({ nodeId: "bk_a" })).rejects.toMatchObject({
      code: "node-admin-refused",
    });
    await expect(w.api.webClient.setToken("t", { nodeId: "bk_a" })).rejects.toMatchObject({
      code: "node-admin-refused",
    });
    // Refusing administration never opens a grant.
    expect(h.opens()).toEqual([]);
  });

  test("an older two-argument invoke and a command-node nodeId use the window's own scope", async () => {
    const h = harness();
    const w = h.renderer(1);
    expect(await w.raw("orkestrator:invoke", "get_projects", { page: 2 })).toEqual({
      node: "command",
      command: "get_projects",
      args: { page: 2 },
    });
    expect(h.commandInvoke).toHaveBeenLastCalledWith(
      "get_projects",
      { page: 2 },
      undefined,
      "scope-1",
    );
    expect(await w.api.node(COMMAND_NODE).invoke("get_projects")).toMatchObject({
      node: "command",
    });
    expect(h.opens()).toEqual([]);
  });

  test("the envelope is bounded and forwarded to the backend invoker", async () => {
    const h = harness();
    const w = h.renderer(1);
    const envelope = { domain: "projects", version: 1, critical: ["page"] };
    await w.api.invoke("get_projects", { page: 1 }, { envelope });
    expect(h.commandInvoke).toHaveBeenLastCalledWith(
      "get_projects",
      { page: 1 },
      { envelope },
      "scope-1",
    );
    await expect(
      w.raw("orkestrator:invoke", "get_projects", {}, { envelope: { pad: "x".repeat(5000) } }),
    ).rejects.toThrow("The invoke envelope is too large");
  });

  test("a node invoker hands the envelope to the connection manager only when there is one", async () => {
    const invoke = mock(async (..._args: unknown[]) => "ok");
    const nodeIpc = new DesktopNodeIpc<Context>({
      nodeScopes: {} as never,
      manager: () =>
        ({
          invoke,
          getBackendIdentity: () => ({ connectionId: "command", backendId: COMMAND_NODE }),
        }) as never,
      mapNodeConnection: () => () => undefined,
    });
    const backend = await nodeIpc.backendFor(
      { scope: "scope-1" } as unknown as Context,
      COMMAND_NODE,
    );
    const envelope = { domain: "projects", version: 1 };
    await backend.invoke("get_projects", { page: 1 }, { envelope });
    expect(invoke).toHaveBeenLastCalledWith("get_projects", { page: 1 }, "scope-1", { envelope });
    await backend.invoke("get_projects", { page: 2 });
    expect(invoke).toHaveBeenLastCalledWith("get_projects", { page: 2 }, "scope-1");
  });

  test("the gateway snapshot carries each node's hello for its scope (plan item 2011)", async () => {
    const h = harness();
    const w = h.renderer(1);
    const reads: string[] = [];
    let failing = false;
    (h.manager as Record<string, unknown>).scopeHello = async (scope: string) => {
      reads.push(scope);
      if (failing) throw new Error("unreachable");
      return scope.includes(":node:") ? { installationId: "bk_a", domains: {} } : null;
    };
    const snapshot = (await w.api.nodes.open("bk_a")) as Record<string, unknown>;
    expect(snapshot.hello).toEqual({ installationId: "bk_a", domains: {} });
    expect(reads).toEqual(["scope-1:node:bk_a"]);
    // The command node's snapshot answers its own scope's (here: none, pre-contract).
    expect(await w.api.nodes.gateway(COMMAND_NODE)).toMatchObject({
      commandNode: true,
      hello: null,
    });
    // A read that cannot tell leaves `hello` out, so the renderer keeps what it had.
    failing = true;
    expect(Object.hasOwn((await w.api.nodes.gateway("bk_a")) as object, "hello")).toBe(false);
  });

  test("open, gateway and release: a snapshot without credentials, then a released node", async () => {
    const h = harness();
    const w = h.renderer(1);
    const a = w.api.node("bk_a");
    const states: string[] = [];
    a.eventStreamConnection.subscribe((state) => void states.push(state));
    expect(await w.api.nodes.gateway("bk_a")).toBeNull();
    const snapshot = await w.api.nodes.open("bk_a");
    expect(snapshot).toEqual({
      nodeId: "bk_a",
      commandNode: false,
      nodeName: "Machine bk_a",
      path: "relay",
      routeKind: "https",
      via: "Command",
      baseUrl: "https://command.test/__orkestrator/nodes/bk_a",
      backendId: "bk_a",
      backendOnThisDevice: false,
    });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(await w.api.nodes.gateway("bk_a")).toEqual(snapshot);
    expect(await w.api.nodes.gateway(COMMAND_NODE)).toEqual({
      nodeId: COMMAND_NODE,
      commandNode: true,
      baseUrl: "https://command.test",
      backendOnThisDevice: false,
    });

    const got: unknown[] = [];
    a.listen("project-updated", (payload) => void got.push(payload));
    const connection = h.connection(1, "bk_a");
    await w.api.nodes.release("bk_a");
    await until(() => h.revoked.length === 1);
    expect(await w.api.nodes.gateway("bk_a")).toBeNull();
    expect(w.sent).toContainEqual([
      NODE_EVENT_CHANNEL,
      "bk_a",
      NODE_SCOPE_RELEASED_EVENT,
      { nodeId: "bk_a" },
    ]);
    expect(a.eventStreamConnection.state()).toBe("disconnected");
    expect(states).toEqual(["connected", "disconnected"]);
    // The released connection feeds no one.
    h.windows.relayBackendEvent(connection, "project-updated", { late: true });
    expect(got).toEqual([]);
    // Ready again opens a new scope.
    await a.eventStreamReady("project-updated");
    expect(h.opens()).toHaveLength(2);
    expect(a.eventStreamConnection.state()).toBe("connected");
  });
});

describe("invoke options", () => {
  test("older renderers send none; anything else is validated", () => {
    expect(parseInvokeOptions(undefined)).toEqual({});
    expect(parseInvokeOptions(null)).toEqual({});
    expect(parseInvokeOptions({ nodeId: "bk_a", extra: 1 })).toEqual({ nodeId: "bk_a" });
    expect(() => parseInvokeOptions([])).toThrow("Expected invoke options to be an object");
    expect(() => parseInvokeOptions({ nodeId: "not a node" })).toThrow(
      "Expected nodeId to be a node identity",
    );
    expect(() => parseInvokeOptions({ envelope: [] })).toThrow("to be an object");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => parseInvokeOptions({ envelope: cyclic })).toThrow("plain data");
    expect(() =>
      parseInvokeOptions({ envelope: { pad: "x".repeat(MAX_INVOKE_ENVELOPE_LENGTH) } }),
    ).toThrow("too large");
  });

  test("refusals lead their message with the code and carry it", () => {
    const refusal = nodeRefusal("unknown-node", "Not known.");
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message).toBe("[unknown-node] Not known.");
    expect(refusal.code).toBe("unknown-node");
    expect(refusal._tag).toBe("NodeRefusal");
  });

  test("the preload listens on main's node event channel", () => {
    expect(PRELOAD_NODE_EVENT_CHANNEL).toBe(NODE_EVENT_CHANNEL);
  });
});

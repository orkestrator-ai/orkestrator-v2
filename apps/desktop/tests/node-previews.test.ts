import { afterEach, describe, expect, mock, test } from "bun:test";
import type {
  BrowserPreviewAttachInput,
  BrowserPreviewBounds,
} from "@orkestrator/protocol/browser-preview";
import { browserPreviewPartitionForWindow } from "../electron/desktop-window-lifecycle";
import {
  DesktopWindowContexts,
  type DesktopWindowConnections,
  type DesktopWindowContextRecord,
} from "../electron/desktop-window-contexts";
import { registerMainIpc } from "../electron/ipc";
import { DesktopNodeIpc } from "../electron/node-ipc";
import {
  NodePreviewRuntimes,
  nodePreviewPartitionKey,
  nodePreviewUrl,
  routeBrowserPreviews,
  type NodePreviewRuntime,
} from "../electron/node-previews";
import { DesktopNodeScopes, type NodeScopeRecord } from "../electron/node-scopes";
import { NodeWorkspaceScopes } from "../electron/node-workspaces";
import { createOrkestratorElectronApi, type IpcRendererLike } from "../electron/preload-api";

const TRUSTED = "file:///app/web/index.html";
const COMMAND_NODE = "bk_cmd";
const BOUNDS: BrowserPreviewBounds = { x: 320, y: 96, width: 800, height: 600 };

type Handler = (event: unknown, ...args: unknown[]) => unknown;

/** A preview controller that records what reached it. */
function fakeController(label: string) {
  const calls: unknown[][] = [];
  const tabs = new Map<string, BrowserPreviewBounds>();
  let disposed = false;
  const state = (tabId: string) => ({ tabId, owner: label }) as never;
  const known = (tabId: string) => {
    if (!tabs.has(tabId)) throw new Error(`No browser preview for ${tabId}`);
  };
  return {
    label,
    calls,
    tabs,
    disposed: () => disposed,
    attach: async (input: BrowserPreviewAttachInput) => {
      calls.push(["attach", input]);
      tabs.set(input.tabId, input.bounds);
      return state(input.tabId);
    },
    setBounds: (tabId: string, bounds: BrowserPreviewBounds) => {
      known(tabId);
      calls.push(["setBounds", tabId, bounds]);
      tabs.set(tabId, bounds);
      return state(tabId);
    },
    setVisible: (tabId: string, visible: boolean) => {
      calls.push(["setVisible", tabId, visible]);
      return tabs.has(tabId) ? state(tabId) : null;
    },
    navigate: async (tabId: string, url: string) => {
      known(tabId);
      calls.push(["navigate", tabId, url]);
      return state(tabId);
    },
    reload: (tabId: string) => {
      known(tabId);
      calls.push(["reload", tabId]);
      return state(tabId);
    },
    getCaptureStatus: async (tabId: string) => {
      known(tabId);
      calls.push(["getCaptureStatus", tabId]);
      return { tabId } as never;
    },
    listPendingCaptures: async () => {
      calls.push(["listPendingCaptures"]);
      return [];
    },
    resetServiceSiteData: async (target: unknown) => {
      calls.push(["resetServiceSiteData", target]);
    },
    destroy: (tabId: string) => {
      calls.push(["destroy", tabId]);
      tabs.delete(tabId);
    },
    destroyAll: () => {
      disposed = true;
      tabs.clear();
    },
  };
}
type FakeController = ReturnType<typeof fakeController>;

type Context = DesktopWindowContextRecord & {
  browserPreviewManager: FakeController;
  nodes: Map<string, NodeScopeRecord>;
  target: { nodeId: string; nodeName: string; path: "direct" | "relay" } | null;
};

/** A node runtime as main creates one: its partition, the scope it tunnels over. */
type CreatedRuntime = {
  windowId: number;
  nodeId: string;
  scope: string;
  partition: string;
  controller: FakeController;
  disposed: boolean;
  /** Whether the grant was still unrevoked when the runtime was disposed. */
  grantHeldAtDispose: boolean | null;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(done()).toBe(true);
}

/**
 * Main as a window renderer meets it for previews: the real IPC handlers,
 * preload API, window bookkeeping, node scopes, node IPC and preview
 * routing, over a fake connection manager whose workspace connections answer
 * as their node.
 */
function harness() {
  const routes = new Map<string, string>();
  const workspaces = new Map<string, string>();
  const known = new Set(["bk_a", "bk_b"]);
  const calls: Array<{ command: string; args: Record<string, unknown>; scope: string }> = [];
  const revoked: string[] = [];
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
    if (command === "open_node_workspace") {
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
    return { node: workspaces.get(connectionId) ?? connectionId, command };
  });
  const manager = {
    bind: mock(async (scope: string, connectionId: string) => {
      if (routes.has(scope)) throw new Error("Connection scope is already active.");
      routes.set(scope, connectionId);
      return { activeConnectionId: connectionId, connections: [] };
    }),
    getConnectionId: connectionOf,
    invoke,
    getGatewayBaseUrl: () => "https://command.test",
    getRendererRequestAuthorization: () => "Bearer command-secret",
    retargetScopeToWorkspace: (scope: string, input: { workspaceId: string; nodeId?: string }) => {
      connectionOf(scope);
      const connectionId = `workspace:${input.workspaceId}`;
      routes.set(scope, connectionId);
      workspaces.set(connectionId, input.nodeId ?? "");
    },
    restoreScopeFrom: (scope: string, source: string) => routes.set(scope, connectionOf(source)),
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
    realms: new Map(),
    connections: () => manager as unknown as DesktopWindowConnections,
    createPreviews: () => ({
      manager: fakeController("window"),
      previewTransport: { disposeAll: async () => undefined },
    }),
    closeRealms: () => undefined,
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
  const created: CreatedRuntime[] = [];
  // As main's `createNodeBrowserPreviews`: the partition from the key, the
  // service transport over the node scope's connection.
  const nodePreviews = new NodePreviewRuntimes<Context, FakeController>({
    windowPreviews: (context) => context.browserPreviewManager,
    isCommandNode: (context, nodeId) => nodeIpc.isCommandNode(context, nodeId),
    openNode: (context, nodeId) => nodeIpc.open(context, nodeId),
    createRuntime: (context, record, partitionKey): NodePreviewRuntime<FakeController> => {
      const entry: CreatedRuntime = {
        windowId: context.contents.id,
        nodeId: record.nodeId,
        scope: record.scope,
        partition: browserPreviewPartitionForWindow(context.slot, partitionKey),
        controller: fakeController(`node ${record.nodeId}`),
        disposed: false,
        grantHeldAtDispose: null,
      };
      created.push(entry);
      return {
        controller: entry.controller,
        partition: entry.partition,
        partitionsInUse: () => [],
        dispose: () => {
          entry.disposed = true;
          entry.grantHeldAtDispose = revoked.length === 0;
          entry.controller.destroyAll();
        },
      };
    },
  });
  cleanups.push(() => {
    nodeScopes.dispose();
    scopes.releaseAll();
  });

  const handlers = new Map<string, Handler>();
  const forEvent = (event: unknown) => windows.forEvent(event as { sender?: { id: number } });
  const unused = () => {
    throw new Error("unused in this test");
  };
  registerMainIpc({
    getBackend: (event) => {
      const scope = forEvent(event).scope;
      return { invoke: (command, args) => invoke(command, args, scope) };
    },
    getMainWindow: () => null,
    ipc: { handle: (channel, listener) => void handlers.set(channel, listener as Handler) },
    clipboardApi: {} as never,
    createClipboardItem: unused as never,
    shellApi: { openExternal: async () => undefined },
    appApi: { exit: unused, quit: unused, relaunch: unused },
    nativeImageApi: {} as never,
    getMacOsPermissions: unused as never,
    getWebClientStatus: unused as never,
    setWebClientEnabled: unused as never,
    resetWebClientServe: unused as never,
    getGatewayTokenSettings: unused as never,
    setGatewayToken: unused as never,
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
    getBrowserPreviews: (event) => forEvent(event).browserPreviewManager as never,
    browserPreviewRouting: routeBrowserPreviews(nodePreviews, {
      window: forEvent,
      nodeWindow: forEvent,
    }) as never,
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
    const contents = {
      id,
      isDestroyed: () => destroyed,
      send: () => undefined,
    };
    const context: Context = {
      window: { isDestroyed: () => destroyed } as never,
      contents,
      scope,
      slot: id,
      previewConnectionId: "command",
      browserPreviewManager: fakeController("window"),
      previewTransport: { disposeAll: async () => undefined },
      artifactHosts: { dispose: () => undefined },
      portalScope: null,
      target: null,
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
      on: () => undefined,
    };
    return {
      api: createOrkestratorElectronApi(ipcRenderer),
      context,
      close: () => {
        destroyed = true;
        closed();
      },
    };
  }

  return {
    renderer,
    created,
    revoked,
    nodePreviews,
    opens: () => calls.filter((call) => call.command === "open_node_workspace"),
  };
}

const attachInput = (tabId: string, nodeId?: string): BrowserPreviewAttachInput => ({
  tabId,
  url: "http://localhost:5173/",
  environmentId: "env-1",
  bounds: BOUNDS,
  visible: true,
  ...(nodeId ? { nodeId } : {}),
});

describe("nodePreviewUrl (4006 Finding 1)", () => {
  const leaf = "https://leaf.example:34221";
  test("a loopback address loads through the node's own gateway", () => {
    expect(nodePreviewUrl(leaf, "http://localhost:5173/app?x=1#h")).toBe(
      `${leaf}/__orkestrator/browser/loopback/5173/app?x=1#h`,
    );
    expect(nodePreviewUrl(`${leaf}/`, "http://127.0.0.1/")).toBe(
      `${leaf}/__orkestrator/browser/loopback/80/`,
    );
  });
  test("another node's gateway preview path moves onto this node's gateway", () => {
    expect(
      nodePreviewUrl(leaf, "https://cmd.example/__orkestrator/browser/loopback/3000/x?y=2"),
    ).toBe(`${leaf}/__orkestrator/browser/loopback/3000/x?y=2`);
    expect(nodePreviewUrl(leaf, "https://cmd.example/__orkestrator/browser/loopback/3000")).toBe(
      `${leaf}/__orkestrator/browser/loopback/3000/`,
    );
  });
  test("anything else is left for the manager's own checks", () => {
    expect(nodePreviewUrl(leaf, "https://example.com/")).toBe("https://example.com/");
    expect(nodePreviewUrl(leaf, "not a url")).toBe("not a url");
  });
  test("a scope with no route refuses rather than load this computer's page", () => {
    expect(() => nodePreviewUrl(null, "http://localhost:3000/")).toThrow("reconnecting");
  });
});

describe("preview runtimes per node scope", () => {
  test("a leaf preview attached through the window renderer uses the leaf's partition", async () => {
    const h = harness();
    const w = h.renderer(3);

    const state = await w.api.browserPreview.attach(attachInput("tab-leaf", "bk_a"));

    expect(state).toMatchObject({ tabId: "tab-leaf", owner: "node bk_a" });
    expect(h.created).toHaveLength(1);
    const runtime = h.created[0]!;
    // The node's partition (`node:<nodeId>`, the key realms use), in this window's slot.
    expect(runtime.partition).toBe(browserPreviewPartitionForWindow(3, "node:bk_a"));
    expect(nodePreviewPartitionKey("bk_a")).toBe("node:bk_a");
    // Its services tunnel over the window's node scope for the leaf.
    expect(runtime.scope).toBe("scope-3:node:bk_a");
    expect(h.opens().map((call) => call.args.nodeId)).toEqual(["bk_a"]);
    // The attach reached the node's runtime with window coordinates as sent,
    // without the node id. The window's own runtime was only told to drop the
    // tab, in case it had moved from the command node.
    expect(runtime.controller.calls).toEqual([
      [
        "attach",
        {
          tabId: "tab-leaf",
          url: "http://localhost:5173/",
          environmentId: "env-1",
          bounds: BOUNDS,
          visible: true,
        },
      ],
    ]);
    expect(w.context.browserPreviewManager.calls).toEqual([["destroy", "tab-leaf"]]);

    // Later calls for the tab resolve through it, not through the renderer.
    const moved = { x: 0, y: 40, width: 1024, height: 700 };
    await w.api.browserPreview.setBounds("tab-leaf", moved);
    await w.api.browserPreview.navigate("tab-leaf", "http://localhost:5173/next");
    await w.api.browserPreview.capture.getCaptureStatus("tab-leaf");
    expect(runtime.controller.calls.slice(1)).toEqual([
      ["setBounds", "tab-leaf", moved],
      ["navigate", "tab-leaf", "http://localhost:5173/next"],
      ["getCaptureStatus", "tab-leaf"],
    ]);
    expect(w.context.browserPreviewManager.calls).toEqual([["destroy", "tab-leaf"]]);
    // The runtime holds the node scope while it shows a tab.
    expect(w.context.nodes.get("bk_a")?.holds).toBe(1);
  });

  test("two tabs for two nodes resolve to two runtimes; a detach releases the runtime", async () => {
    const h = harness();
    const w = h.renderer(1);

    await Promise.all([
      w.api.browserPreview.attach(attachInput("tab-a", "bk_a")),
      w.api.browserPreview.attach(attachInput("tab-b", "bk_b")),
      w.api.browserPreview.attach(attachInput("tab-a2", "bk_a")),
      w.api.browserPreview.attach(attachInput("tab-cmd")),
    ]);

    // One runtime per node, each with its own partition; one grant per node.
    expect(h.created.map((runtime) => [runtime.nodeId, runtime.partition]).sort()).toEqual([
      ["bk_a", browserPreviewPartitionForWindow(1, "node:bk_a")],
      ["bk_b", browserPreviewPartitionForWindow(1, "node:bk_b")],
    ]);
    expect(new Set(h.created.map((runtime) => runtime.partition)).size).toBe(2);
    expect(h.opens()).toHaveLength(2);
    const runtimeA = h.created.find((runtime) => runtime.nodeId === "bk_a")!;
    const runtimeB = h.created.find((runtime) => runtime.nodeId === "bk_b")!;
    expect([...runtimeA.controller.tabs.keys()].sort()).toEqual(["tab-a", "tab-a2"]);
    expect([...runtimeB.controller.tabs.keys()]).toEqual(["tab-b"]);
    // A tab without a node stays on the window's own (command node) runtime.
    expect([...w.context.browserPreviewManager.tabs.keys()]).toEqual(["tab-cmd"]);
    expect(h.nodePreviews.runtimes(w.context)).toHaveLength(2);

    // Detaching one of node A's two tabs keeps its runtime.
    await w.api.browserPreview.destroy("tab-a");
    expect(runtimeA.disposed).toBe(false);
    // Detaching the last releases it and its hold; node B's is untouched.
    await w.api.browserPreview.destroy("tab-a2");
    expect(runtimeA.disposed).toBe(true);
    expect(runtimeB.disposed).toBe(false);
    expect(w.context.nodes.get("bk_a")?.holds).toBe(0);
    expect(h.nodePreviews.runtimeOf(w.context.nodes.get("bk_a")!)).toBeNull();
    // The released tab no longer reaches node A's runtime.
    await expect(w.api.browserPreview.setBounds("tab-a2", BOUNDS)).rejects.toThrow(
      "No browser preview for tab-a2",
    );
    expect(runtimeA.controller.calls.filter(([call]) => call === "setBounds")).toEqual([]);

    // A new attach for node A creates a fresh runtime on the same scope.
    await w.api.browserPreview.attach(attachInput("tab-a3", "bk_a"));
    expect(h.created.filter((runtime) => runtime.nodeId === "bk_a")).toHaveLength(2);
    expect(h.opens()).toHaveLength(2);
  });

  test("releasing the node scope disposes its runtime before the grant is revoked", async () => {
    const h = harness();
    const w = h.renderer(1);
    await w.api.browserPreview.attach(attachInput("tab-a", "bk_a"));
    const runtime = h.created[0]!;

    await w.api.nodes.release("bk_a");

    expect(runtime.disposed).toBe(true);
    expect(runtime.grantHeldAtDispose).toBe(true);
    await until(() => h.revoked.length === 1);
    expect(h.nodePreviews.runtimes(w.context)).toEqual([]);
    // The tab is forgotten: a later call goes to the window's runtime, which never had it.
    await expect(w.api.browserPreview.reload("tab-a")).rejects.toThrow("No browser preview");
  });

  test("closing the window disposes every node runtime", async () => {
    const h = harness();
    const w = h.renderer(1);
    await w.api.browserPreview.attach(attachInput("tab-a", "bk_a"));
    await w.api.browserPreview.attach(attachInput("tab-b", "bk_b"));
    w.close();
    expect(h.created.map((runtime) => runtime.disposed)).toEqual([true, true]);
  });

  test("two windows on one node get two runtimes in their own slots", async () => {
    const h = harness();
    const first = h.renderer(1);
    const second = h.renderer(2);
    await first.api.browserPreview.attach(attachInput("tab", "bk_a"));
    await second.api.browserPreview.attach(attachInput("tab", "bk_a"));
    expect(h.created.map((runtime) => [runtime.windowId, runtime.partition])).toEqual([
      [1, browserPreviewPartitionForWindow(1, "node:bk_a")],
      [2, browserPreviewPartitionForWindow(2, "node:bk_a")],
    ]);
  });

  test("the command node's id and calls without a tab use the window's own runtime", async () => {
    const h = harness();
    const w = h.renderer(1);
    await w.api.browserPreview.attach(attachInput("tab-cmd", COMMAND_NODE));
    expect(h.created).toEqual([]);
    expect(h.opens()).toEqual([]);
    expect([...w.context.browserPreviewManager.tabs.keys()]).toEqual(["tab-cmd"]);
    // The capture spool is shared: pending captures are read through the window.
    await w.api.browserPreview.capture.listPendingCaptures();
    expect(w.context.browserPreviewManager.calls.at(-1)).toEqual(["listPendingCaptures"]);
  });

  test("a service call that names a node reaches that node's runtime", async () => {
    const h = harness();
    const w = h.renderer(1);
    const service = {
      backendInstanceId: "bi_aaaaaaaa",
      environmentId: "env-1",
      serviceId: "svc_aaaaaaaa",
      path: "/",
    };
    await w.api.browserPreview.resetServiceSiteData(service, { nodeId: "bk_b" });
    expect(h.created.map((runtime) => runtime.nodeId)).toEqual(["bk_b"]);
    expect(h.created[0]!.controller.calls).toEqual([["resetServiceSiteData", service]]);
    // Without a node it is the window's, as before.
    await w.api.browserPreview.resetServiceSiteData(service);
    expect(w.context.browserPreviewManager.calls).toEqual([["resetServiceSiteData", service]]);
  });

  test("a tab moved to another node leaves no view on the first", async () => {
    const h = harness();
    const w = h.renderer(1);
    await w.api.browserPreview.attach(attachInput("tab", "bk_a"));
    await w.api.browserPreview.attach(attachInput("tab", "bk_b"));
    const runtimeA = h.created.find((runtime) => runtime.nodeId === "bk_a")!;
    expect(runtimeA.disposed).toBe(true);
    await w.api.browserPreview.attach(attachInput("tab"));
    const runtimeB = h.created.find((runtime) => runtime.nodeId === "bk_b")!;
    expect(runtimeB.disposed).toBe(true);
    expect([...w.context.browserPreviewManager.tabs.keys()]).toEqual(["tab"]);
  });

  test("an unknown node or a malformed attach opens nothing", async () => {
    const h = harness();
    const w = h.renderer(1);
    await expect(
      w.api.browserPreview.attach(attachInput("tab", "bk_nobody")),
    ).rejects.toMatchObject({ code: "unknown-node" });
    await expect(
      w.api.browserPreview.attach({
        ...attachInput("tab", "bk_a"),
        bounds: { x: Number.NaN } as never,
      }),
    ).rejects.toThrow("Expected finite browser preview bounds");
    await expect(
      w.api.browserPreview.attach({ ...attachInput("tab"), nodeId: "not a node id" }),
    ).rejects.toThrow("Expected nodeId to be a node identity");
    expect(h.opens()).toEqual([]);
    expect(h.created).toEqual([]);
  });
});

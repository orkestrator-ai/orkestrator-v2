import { afterEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import {
  DesktopWindowContexts,
  type DesktopWindowConnections,
  type DesktopWindowContextRecord,
} from "../electron/desktop-window-contexts";
import {
  DesktopNodeScopes,
  NODE_SCOPE_CHANGED_EVENT,
  NODE_SCOPE_IDLE_RELEASE_MS,
  onNodeScopeRelease,
  type NodeScopeWindow,
} from "../electron/node-scopes";
import {
  NodeWorkspaceScopes,
  WORKSPACE_DIRECT_RETRY_MS,
  WORKSPACE_RENEW_INTERVAL_MS,
} from "../electron/node-workspaces";

type Call = { command: string; args: Record<string, unknown>; scope: string };

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  setSystemTime();
});

function harness(options: { idleMs?: number | null; now?: () => number } = {}) {
  /** Each scope's bound connection or workspace, as the connection manager holds it. */
  const routes = new Map<string, string>();
  const calls: Call[] = [];
  const revoked: string[] = [];
  const renewed: string[] = [];
  const unavailable = new Map<string, () => void>();
  const directOrigins = new Map<string, string>();
  let fail = false;
  let open: (() => Promise<void>) | null = null;
  let grants = 0;
  const invoke = mock((command: string, args: Record<string, unknown> = {}, scope = "default") => {
    if (!routes.has(scope)) throw new Error("Scope is released");
    calls.push({ command, args, scope });
    return (async () => {
      if (command === "close_node_workspace") {
        revoked.push(String(args.workspaceId));
        return {};
      }
      if (command === "renew_node_workspace") {
        renewed.push(String(args.workspaceId));
        return {};
      }
      if (command === "open_node_workspace") {
        await open?.();
        if (fail) throw new Error("unreachable");
        grants++;
        const nodeId = String(args.nodeId);
        const origin = directOrigins.get(nodeId);
        return {
          workspaceId: `grant-${grants}-${nodeId}`,
          nodeId,
          nodeName: nodeId,
          grant: { token: `token-${grants}`, expiresAt: Date.now() + 900_000 },
          directOrigins: origin ? [origin] : [],
          relayBase: `/__orkestrator/nodes/${nodeId}`,
        };
      }
      return { displayName: "Command" };
    })();
  });
  const manager = {
    bind: mock(async (scope: string, connectionId: string) => {
      if (routes.has(scope)) throw new Error("Connection scope is already active.");
      routes.set(scope, connectionId);
      return { activeConnectionId: connectionId, connections: [] };
    }),
    getConnectionId: (scope: string) => {
      const connectionId = routes.get(scope);
      if (!connectionId) throw new Error("The requesting window is no longer available.");
      return connectionId;
    },
    invoke,
    getGatewayBaseUrl: () => "https://command.test",
    getRendererRequestAuthorization: () => "Bearer command",
    retargetScopeToWorkspace: mock(
      (scope: string, input: { workspaceId: string; onUnavailable?: () => void }) => {
        if (!routes.has(scope)) throw new Error("The requesting window is no longer available.");
        routes.set(scope, input.workspaceId);
        if (input.onUnavailable) unavailable.set(scope, input.onUnavailable);
      },
    ),
    release: mock((scope: string) => {
      routes.delete(scope);
    }),
    epochOf: () => 1,
    rebindWorkspace: mock(
      (_scope: string, _input: { baseUrl: string; token: string }) => undefined,
    ),
    // What the window bookkeeping uses for a command-node change.
    use: mock(async (connectionId: string, scope: string) => {
      routes.set(scope, connectionId);
      return { activeConnectionId: connectionId, connections: [] };
    }),
    connect: mock(async () => ({})),
    forget: mock(async () => ({})),
    getList: (scope: string) => ({ activeConnectionId: routes.get(scope)!, connections: [] }),
    setRelayedEvents: mock(() => undefined),
    relayedEventReady: mock(async () => undefined),
  };
  const scopes = new NodeWorkspaceScopes((command, args) => invoke(command, args));
  const nodeScopes = new DesktopNodeScopes({
    manager: () => manager as never,
    scopes: () => scopes,
    ...options,
  });
  cleanups.push(() => {
    nodeScopes.dispose();
    scopes.releaseAll();
  });

  function window(scope: string, connectionId = "command") {
    let destroyed = false;
    routes.set(scope, connectionId);
    const sent: unknown[][] = [];
    const context: NodeScopeWindow = {
      scope,
      window: { isDestroyed: () => destroyed },
      contents: {
        isDestroyed: () => destroyed,
        send: (...args: unknown[]) => void sent.push(args),
      },
      nodes: new Map(),
    };
    return {
      context,
      sent,
      destroy: () => {
        destroyed = true;
      },
    };
  }

  return {
    routes,
    calls,
    revoked,
    renewed,
    unavailable,
    manager,
    scopes,
    nodeScopes,
    window,
    fail: (value = true) => {
      fail = value;
    },
    direct: (nodeId: string, origin: string) => directOrigins.set(nodeId, origin),
    hold: (value: (() => Promise<void>) | null) => {
      open = value;
    },
    opens: () => calls.filter((call) => call.command === "open_node_workspace"),
  };
}

/** Let pending promise work run until `done` holds. */
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await Promise.resolve();
  expect(done()).toBe(true);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mockHello(nodeId: string) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    Response.json({
      schemaVersion: 1,
      installationId: nodeId,
      generation: "generation-A",
      appVersion: "2.30.0",
      clientApi: { minVersion: 1, maxVersion: 1 },
      capabilities: {},
      endpointRole: "client",
      profile: {
        revision: 1,
        displayName: nodeId,
        colorToken: "blue",
        updatedAt: "2026-10-25T00:00:00Z",
      },
    }),
  ) as unknown as typeof fetch;
  cleanups.push(() => {
    globalThis.fetch = originalFetch;
  });
}

describe("opening node scopes", () => {
  test("concurrent ensures share one open and leave the window's own scope alone", async () => {
    const h = harness();
    const w = h.window("w1");
    const gate = deferred();
    h.hold(() => gate.promise);
    const first = h.nodeScopes.ensureNodeScope(w.context, "A");
    const second = h.nodeScopes.ensureNodeScope(w.context, "A");
    await until(() => h.opens().length === 1);
    const third = h.nodeScopes.ensureNodeScope(w.context, "A");
    gate.resolve();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(h.opens()).toHaveLength(1);
    expect(a.scope).toBe("w1:node:A");
    expect(a.opening).toBeNull();
    expect(a.target).toMatchObject({ nodeId: "A", path: "relay" });
    expect(h.routes.get("w1")).toBe("command");
    expect(h.routes.get("w1:node:A")).toBe("grant-1-A");
    expect(h.routes.get("w1:node:A:command")).toBe("command");
    // The opening scope is gone once the open settled; the window's own scope is untouched.
    expect([...h.routes.keys()].sort()).toEqual(["w1", "w1:node:A", "w1:node:A:command"]);
    expect(w.sent).toEqual([]);
    // A later ensure reuses the open scope.
    expect(await h.nodeScopes.ensureNodeScope(w.context, "A")).toBe(a);
    expect(h.opens()).toHaveLength(1);
  });

  test("a failed open leaves nothing behind and the next ensure opens again", async () => {
    const h = harness();
    const w = h.window("w1");
    h.fail();
    const failures = await Promise.allSettled([
      h.nodeScopes.ensureNodeScope(w.context, "A"),
      h.nodeScopes.ensureNodeScope(w.context, "A"),
    ]);
    expect(failures.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(h.opens()).toHaveLength(1);
    expect(w.context.nodes.size).toBe(0);
    expect([...h.routes.keys()]).toEqual(["w1"]);
    h.fail(false);
    const record = await h.nodeScopes.ensureNodeScope(w.context, "A");
    expect(record.target?.nodeId).toBe("A");
    expect(h.routes.get("w1:node:A")).toBe("grant-1-A");
  });

  test("a closed window cannot open a node scope", async () => {
    const h = harness();
    const w = h.window("w1");
    w.destroy();
    await expect(h.nodeScopes.ensureNodeScope(w.context, "A")).rejects.toThrow(
      "no longer available",
    );
    expect(h.opens()).toHaveLength(0);
  });

  test("two nodes in one window are independent", async () => {
    const h = harness();
    const w = h.window("w1");
    const a = await h.nodeScopes.ensureNodeScope(w.context, "A");
    const b = await h.nodeScopes.ensureNodeScope(w.context, "B");
    expect(a.scope).not.toBe(b.scope);
    h.nodeScopes.releaseNodeScope(w.context, "A");
    expect(h.revoked).toEqual(["grant-1-A"]);
    expect(h.routes.has("w1:node:A")).toBe(false);
    expect(h.routes.get("w1:node:B")).toBe("grant-2-B");
    expect([...w.context.nodes.keys()]).toEqual(["B"]);
    // B's grant is still tracked and renews through its own command access.
    await h.scopes.reconcile("w1:node:B");
    expect(h.renewed).toEqual(["grant-2-B"]);
    await h.scopes.reconcile("w1:node:A");
    expect(h.renewed).toEqual(["grant-2-B"]);
  });

  test("two windows on one node hold two grants (13.5 A)", async () => {
    const h = harness();
    const w1 = h.window("w1");
    const w2 = h.window("w2");
    const [one, two] = await Promise.all([
      h.nodeScopes.ensureNodeScope(w1.context, "A"),
      h.nodeScopes.ensureNodeScope(w2.context, "A"),
    ]);
    expect(one).not.toBe(two);
    expect(h.opens()).toHaveLength(2);
    expect(new Set([h.routes.get("w1:node:A"), h.routes.get("w2:node:A")])).toEqual(
      new Set(["grant-1-A", "grant-2-A"]),
    );
    const w1Grant = h.routes.get("w1:node:A")!;
    h.nodeScopes.releaseWindowNodeScopes(w1.context);
    expect(h.revoked).toEqual([w1Grant]);
    expect(h.routes.has("w2:node:A")).toBe(true);
  });
});

describe("renewing and rebinding node scopes", () => {
  test("a node scope renews its own grant through the command node it opened on", async () => {
    setSystemTime(new Date("2026-11-07T00:00:00Z"));
    const h = harness();
    const w = h.window("w1");
    await h.nodeScopes.ensureNodeScope(w.context, "A");
    // The window's own scope moving does not move the grant's renewals.
    h.routes.set("w1", "other-command");
    setSystemTime(new Date(Date.now() + WORKSPACE_RENEW_INTERVAL_MS));
    await h.scopes.reconcile("w1:node:A");
    const renew = h.calls.find((call) => call.command === "renew_node_workspace");
    expect(renew).toEqual({
      command: "renew_node_workspace",
      args: { workspaceId: "grant-1-A" },
      scope: "w1:node:A:command",
    });
    expect(h.routes.get("w1:node:A:command")).toBe("command");
  });

  test("relay to direct upgrade rebinds the node scope and emits node-scope-changed", async () => {
    setSystemTime(new Date("2026-11-07T00:00:00Z"));
    mockHello("bk_a");
    const h = harness();
    const w = h.window("w1");
    const record = await h.nodeScopes.ensureNodeScope(w.context, "bk_a");
    expect(record.target?.path).toBe("relay");
    h.direct("bk_a", "https://direct.test");
    setSystemTime(new Date(Date.now() + WORKSPACE_DIRECT_RETRY_MS));
    await h.nodeScopes.ensureNodeScope(w.context, "bk_a");
    await until(() => w.sent.length === 1);
    expect(w.sent).toEqual([["orkestrator:event", NODE_SCOPE_CHANGED_EVENT, { nodeId: "bk_a" }]]);
    expect(h.manager.rebindWorkspace).toHaveBeenCalledTimes(1);
    expect(h.manager.rebindWorkspace.mock.calls[0]?.[0]).toBe("w1:node:bk_a");
    expect(record.target).toMatchObject({ nodeId: "bk_a", path: "direct", routeKind: "https" });
    await until(() => h.revoked.includes("grant-1-bk_a"));
    // The retry's command access is gone; the window scope never moved.
    expect([...h.routes.keys()].some((scope) => scope.includes("workspace-retry"))).toBe(false);
    expect(h.routes.get("w1")).toBe("command");
  });

  test("a reopen after the node becomes unavailable emits node-scope-changed", async () => {
    const h = harness();
    const w = h.window("w1");
    const record = await h.nodeScopes.ensureNodeScope(w.context, "A");
    h.unavailable.get("w1:node:A")!();
    await until(() => w.sent.length === 1);
    expect(w.sent[0]).toEqual(["orkestrator:event", NODE_SCOPE_CHANGED_EVENT, { nodeId: "A" }]);
    expect(h.opens()).toHaveLength(2);
    expect(record.target?.nodeId).toBe("A");
    await until(() => h.revoked.includes("grant-1-A"));
    // Releasing now revokes the replacement grant.
    h.nodeScopes.releaseNodeScope(w.context, "A");
    expect(h.revoked).toContain("grant-2-A");
  });
});

describe("releasing node scopes", () => {
  test("an explicit release revokes the grant, then drops the scope and its command access", async () => {
    const h = harness();
    const w = h.window("w1");
    const record = await h.nodeScopes.ensureNodeScope(w.context, "A");
    const order: string[] = [];
    onNodeScopeRelease(record, () => order.push(`preview:${h.revoked.length}`));
    h.manager.release.mockImplementation((scope: string) => {
      order.push(`release:${scope}`);
      h.routes.delete(scope);
    });
    h.nodeScopes.releaseNodeScope(w.context, "A");
    expect(h.revoked).toEqual(["grant-1-A"]);
    // Previews end first, then the grant, the workspace binding and command access.
    expect(order).toEqual(["preview:0", "release:w1:node:A", "release:w1:node:A:command"]);
    expect(record.lifetime.state._tag).toBe("Closed");
    expect(w.context.nodes.size).toBe(0);
    expect([...h.routes.keys()]).toEqual(["w1"]);
    // Releasing twice, or a node never opened, is a no-op.
    h.nodeScopes.releaseNodeScope(w.context, "A");
    h.nodeScopes.releaseNodeScope(w.context, "B");
    expect(h.revoked).toEqual(["grant-1-A"]);
    // A finalizer registered after release runs at once.
    let late = false;
    onNodeScopeRelease(record, () => {
      late = true;
    });
    expect(late).toBe(true);
  });

  test("a release during the open revokes the grant it yields and binds nothing", async () => {
    const h = harness();
    const w = h.window("w1");
    const gate = deferred();
    h.hold(() => gate.promise);
    const pending = h.nodeScopes.ensureNodeScope(w.context, "A");
    await until(() => h.opens().length === 1);
    h.nodeScopes.releaseNodeScope(w.context, "A");
    gate.resolve();
    await expect(pending).rejects.toThrow("released");
    await until(() => h.revoked.length === 1);
    // Revoked through the open's own command access, which outlived the release.
    expect(h.calls.find((call) => call.command === "close_node_workspace")?.scope).toBe(
      "w1:node:A:workspace-open",
    );
    expect(h.manager.retargetScopeToWorkspace).not.toHaveBeenCalled();
    expect([...h.routes.keys()]).toEqual(["w1"]);
    expect(w.context.nodes.size).toBe(0);
  });

  test("an ensure right after a release waits for the released open, then opens afresh", async () => {
    const h = harness();
    const w = h.window("w1");
    const gate = deferred();
    h.hold(() => gate.promise);
    const released = h.nodeScopes.ensureNodeScope(w.context, "A");
    await until(() => h.opens().length === 1);
    h.nodeScopes.releaseNodeScope(w.context, "A");
    const reopened = h.nodeScopes.ensureNodeScope(w.context, "A");
    h.hold(null);
    gate.resolve();
    await expect(released).rejects.toThrow("released");
    const record = await reopened;
    expect(h.revoked).toEqual(["grant-1-A"]);
    expect(h.routes.get(record.scope)).toBe("grant-2-A");
    expect(w.context.nodes.get("A")).toBe(record);
  });

  test("plan item 4002: a held scope goes when its renderer releases it; an unheld one after the desktop's suspend time", async () => {
    expect(NODE_SCOPE_IDLE_RELEASE_MS).toBe(15 * 60_000);
    let now = 0;
    const h = harness({ idleMs: NODE_SCOPE_IDLE_RELEASE_MS, now: () => now });
    const w = h.window("w1");
    // The renderer's in-tree scope opens with a hold; an invoke-only open has none.
    await h.nodeScopes.ensureNodeScope(w.context, "A", { hold: true });
    await h.nodeScopes.ensureNodeScope(w.context, "B");
    now = NODE_SCOPE_IDLE_RELEASE_MS - 1;
    h.nodeScopes.sweepIdle();
    expect(w.context.nodes.size).toBe(2);
    now = NODE_SCOPE_IDLE_RELEASE_MS;
    h.nodeScopes.sweepIdle();
    expect([...w.context.nodes.keys()]).toEqual(["A"]);
    // Pressure took A back to summary: the renderer disposed its scope, whose
    // client sends `orkestrator:nodes:release`. Main releases it at once,
    // hold or not.
    h.nodeScopes.releaseNodeScope(w.context, "A");
    expect(w.context.nodes.size).toBe(0);
    expect(h.revoked).toEqual(["grant-2-B", "grant-1-A"]);
  });

  test("idle release is off by default", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    const w = h.window("w1");
    await h.nodeScopes.ensureNodeScope(w.context, "A");
    now = Number.MAX_SAFE_INTEGER;
    h.nodeScopes.sweepIdle();
    expect(w.context.nodes.size).toBe(1);
    expect(h.revoked).toEqual([]);
  });

  test("with an idle time, only unheld scopes unused for that long are released", async () => {
    let now = 0;
    const h = harness({ idleMs: 1_000, now: () => now });
    const w = h.window("w1");
    const held = await h.nodeScopes.ensureNodeScope(w.context, "A", { hold: true });
    await h.nodeScopes.ensureNodeScope(w.context, "B");
    expect(held.holds).toBe(1);
    now = 999;
    h.nodeScopes.sweepIdle();
    expect(w.context.nodes.size).toBe(2);
    now = 1_000;
    h.nodeScopes.sweepIdle();
    expect([...w.context.nodes.keys()]).toEqual(["A"]);
    expect(h.revoked).toEqual(["grant-2-B"]);
    h.nodeScopes.dropNodeScopeHold(w.context, "A");
    h.nodeScopes.sweepIdle();
    expect(w.context.nodes.size).toBe(0);
    expect(h.revoked).toEqual(["grant-2-B", "grant-1-A"]);
  });

  type Context = DesktopWindowContextRecord & NodeScopeWindow;

  function windows(h: ReturnType<typeof harness>) {
    const runtime = () => ({
      manager: { destroyAll: () => undefined },
      previewTransport: { disposeAll: async () => undefined },
    });
    const desktop = new DesktopWindowContexts<Context>({
      connections: () => h.manager as unknown as DesktopWindowConnections,
      createPreviews: runtime,
      cancelPrompts: () => undefined,
      releaseWorkspaceGrant: (scope) => h.scopes.release(scope),
      releaseNodeScopes: (context) => h.nodeScopes.releaseWindowNodeScopes(context),
      releaseSlot: () => undefined,
      setConnectionTitle: () => undefined,
      publishConnectionLists: () => undefined,
      menuChanged: () => undefined,
      logger: { warn: () => undefined },
    });
    const register = (id: number) => {
      const w = h.window(`w${id}`);
      const previews = runtime();
      const context: Context = {
        ...w.context,
        contents: { id, ...w.context.contents },
        slot: id,
        previewConnectionId: "command",
        browserPreviewManager: previews.manager,
        previewTransport: previews.previewTransport,
        artifactHosts: { dispose: () => undefined },
      };
      return { context, closed: desktop.register(context) };
    };
    return { desktop, register };
  }

  test("closing a window releases its node scopes, not another window's", async () => {
    const h = harness();
    const { register } = windows(h);
    const one = register(1);
    const two = register(2);
    await h.nodeScopes.ensureNodeScope(one.context, "A");
    await h.nodeScopes.ensureNodeScope(one.context, "B");
    await h.nodeScopes.ensureNodeScope(two.context, "A");
    one.closed();
    expect(h.revoked.sort()).toEqual(["grant-1-A", "grant-2-B"]);
    expect(one.context.nodes.size).toBe(0);
    expect([...h.routes.keys()].filter((scope) => scope.startsWith("w1"))).toEqual([]);
    expect(two.context.nodes.size).toBe(1);
    expect(h.routes.get("w2:node:A")).toBe("grant-3-A");
  });

  test("a command-node change releases the window's node scopes", async () => {
    const h = harness();
    const { desktop, register } = windows(h);
    const one = register(1);
    await h.nodeScopes.ensureNodeScope(one.context, "A");
    await desktop.useConnection("other-command", { sender: { id: 1 } });
    expect(h.routes.get("w1")).toBe("other-command");
    expect(h.revoked).toEqual(["grant-1-A"]);
    expect(one.context.nodes.size).toBe(0);
    expect(h.routes.has("w1:node:A:command")).toBe(false);
  });
});

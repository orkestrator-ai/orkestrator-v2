import { describe, expect, mock, test } from "bun:test";
import {
  DesktopWindowContexts,
  type DesktopWindowConnections,
  type DesktopWindowContextRecord,
} from "../electron/desktop-window-contexts";
import { PORTAL_EVENT_CHANNEL } from "../electron/federation-ipc";

type Sent = [channel: string, ...args: unknown[]];

function previews(connectionId: string, events: string[]) {
  return {
    connectionId,
    manager: { destroyAll: mock(() => void events.push(`destroy previews:${connectionId}`)) },
    previewTransport: {
      disposeAll: mock(async () => void events.push(`dispose transport:${connectionId}`)),
    },
  };
}

function harness() {
  const events: string[] = [];
  /** Each scope's bound connection, as the connection manager holds it. */
  const routes = new Map<string, string>();
  const list = (scope: string) => ({ activeConnectionId: routes.get(scope)!, connections: [] });
  const connectionManager = {
    getConnectionId: (scope: string) => {
      const connectionId = routes.get(scope);
      if (!connectionId) throw new Error("The requesting window is no longer available.");
      return connectionId;
    },
    getList: (scope: string) => {
      if (!routes.has(scope)) throw new Error("The requesting window is no longer available.");
      return list(scope);
    },
    use: mock(async (connectionId: string, scope: string) => {
      events.push(`use:${connectionId}`);
      routes.set(scope, connectionId);
      return list(scope);
    }),
    connect: mock(async () => {
      throw new Error("unexpected connect");
    }),
    forget: mock(async () => {
      throw new Error("unexpected forget");
    }),
    release: mock((scope: string) => {
      events.push(`release:${scope}`);
      routes.delete(scope);
    }),
  };
  let connections: DesktopWindowConnections | null =
    connectionManager as unknown as DesktopWindowConnections;
  const realms = new Map<number, Context>();
  const created: Array<ReturnType<typeof previews>> = [];
  const createPreviews = mock((_context: Context, connectionId: string, partitionKey: string) => {
    events.push(`create previews:${connectionId}:${partitionKey}`);
    const next = previews(connectionId, events);
    created.push(next);
    return next;
  });
  const warn = mock((..._args: unknown[]): void => undefined);
  const setConnectionTitle = mock((context: Context) => {
    events.push(`title:${context.contents.id}`);
  });
  const publishConnectionLists = mock(() => void events.push("publish lists"));
  const windows: DesktopWindowContexts<Context> = new DesktopWindowContexts<Context>({
    realms,
    connections: () => connections,
    createPreviews,
    closeRealms: (id) => void events.push(`close realms:${id}`),
    // Prompts are cancelled while the window is still registered.
    cancelPrompts: (id) => void events.push(`cancel prompts:${id}:${windows.windows.has(id)}`),
    releaseWorkspaceGrant: (scope) => void events.push(`release grant:${scope}`),
    releaseSlot: (slot) => void events.push(`release slot:${slot}`),
    setConnectionTitle,
    publishConnectionLists,
    menuChanged: () => void events.push("menu"),
    logger: { warn },
  });

  function context(
    id: number,
    connectionId: string,
    options: { portal?: string; target?: Context["target"] } = {},
  ) {
    let destroyed = false;
    const sent: Sent[] = [];
    const scope = `scope-${id}`;
    routes.set(scope, connectionId);
    const portalScope = options.portal ? `${scope}:portal` : null;
    if (portalScope) routes.set(portalScope, options.portal!);
    const runtime = previews(connectionId, events);
    const value = {
      window: { isDestroyed: () => destroyed },
      contents: {
        id,
        isDestroyed: () => destroyed,
        send: (channel: string, ...args: unknown[]) => void sent.push([channel, ...args]),
      },
      scope,
      slot: id,
      previewConnectionId: connectionId,
      browserPreviewManager: runtime.manager,
      previewTransport: runtime.previewTransport,
      artifactHosts: { dispose: mock(() => void events.push(`dispose artifacts:${id}`)) },
      portalScope,
      target: options.target ?? null,
    };
    return {
      value,
      runtime,
      sent,
      destroy: () => {
        destroyed = true;
      },
    };
  }

  return {
    windows,
    events,
    routes,
    realms,
    connectionManager,
    created,
    createPreviews,
    warn,
    setConnectionTitle,
    publishConnectionLists,
    context,
    clearConnections: () => {
      connections = null;
    },
    sender: (id: number) => ({ sender: { id } }),
  };
}

type Context = DesktopWindowContextRecord;

describe("desktop window contexts", () => {
  test("a registered window takes focus and answers for its IPC sender", () => {
    const h = harness();
    const first = h.context(1, "local");
    const second = h.context(2, "local");
    h.windows.register(first.value);
    expect(h.windows.lastFocusedWindowId).toBe(1);
    h.windows.register(second.value);
    expect(h.windows.lastFocusedWindowId).toBe(2);
    expect(h.windows.forEvent(h.sender(1))).toBe(first.value);
    expect(h.windows.forEvent(h.sender(2))).toBe(second.value);
    expect([...h.windows.windows.keys()]).toEqual([1, 2]);
  });

  test("a realm's sender resolves to the realm, after every window", () => {
    const h = harness();
    const window = h.context(1, "local");
    const realm = h.context(10, "workspace-1", { portal: "local" });
    h.windows.register(window.value);
    h.realms.set(10, realm.value);
    expect(h.windows.forEvent(h.sender(10))).toBe(realm.value);
    expect(h.windows.renderers()).toEqual([window.value, realm.value]);
  });

  test("an unknown, missing or closed sender is refused", () => {
    const h = harness();
    const window = h.context(1, "local");
    const closed = h.windows.register(window.value);
    const refusal = "The requesting window is no longer available";
    expect(() => h.windows.forEvent(h.sender(99))).toThrow(refusal);
    expect(() => h.windows.forEvent({})).toThrow(refusal);
    expect(() => h.windows.forEvent(undefined)).toThrow(refusal);
    closed();
    expect(() => h.windows.forEvent(h.sender(1))).toThrow(refusal);
    expect(h.windows.windows.size).toBe(0);
  });

  test("closing a window ends what it owns, then releases its grant, scopes and slot", () => {
    const h = harness();
    const window = h.context(3, "workspace-1", { portal: "local" });
    const closed = h.windows.register(window.value);
    h.events.length = 0;
    closed();
    expect(h.events).toEqual([
      "close realms:3",
      "destroy previews:workspace-1",
      "dispose artifacts:3",
      "dispose transport:workspace-1",
      "cancel prompts:3:true",
      "release grant:scope-3",
      "release:scope-3:portal",
      "release:scope-3",
      "release slot:3",
      "menu",
    ]);
    expect(h.windows.windows.has(3)).toBe(false);
  });

  test("a window without a portal releases only its own scope", () => {
    const h = harness();
    const closed = h.windows.register(h.context(1, "local").value);
    closed();
    expect(h.connectionManager.release.mock.calls).toEqual([["scope-1"]]);
  });

  test("closing the focused window hands focus to the first remaining window", () => {
    const h = harness();
    const closeFirst = h.windows.register(h.context(1, "local").value);
    const closeSecond = h.windows.register(h.context(2, "local").value);
    const closeThird = h.windows.register(h.context(3, "local").value);
    expect(h.windows.lastFocusedWindowId).toBe(3);
    // Another window closing leaves focus where it is.
    closeFirst();
    expect(h.windows.lastFocusedWindowId).toBe(3);
    closeThird();
    expect(h.windows.lastFocusedWindowId).toBe(2);
    closeSecond();
    expect(h.windows.lastFocusedWindowId).toBeNull();
  });

  test("a failed transport close is logged after the window is gone", async () => {
    const h = harness();
    const window = h.context(1, "remote-1");
    const failure = new Error("tunnel gone");
    window.value.previewTransport.disposeAll = mock(async () => {
      throw failure;
    });
    const logged = Promise.withResolvers<unknown[]>();
    h.warn.mockImplementation((...args: unknown[]) => logged.resolve(args));
    h.windows.register(window.value)();
    expect(h.windows.windows.has(1)).toBe(false);
    expect(await logged.promise).toEqual([
      "[Previews] Failed to close preview transport:",
      failure,
    ]);
  });

  test("a connection's events reach only the renderers on it, and portals of its realms", () => {
    const h = harness();
    const local = h.context(1, "local");
    const remote = h.context(2, "remote-1");
    const closedLocal = h.context(3, "local");
    const realm = h.context(10, "workspace-1", { portal: "local" });
    const closedRealm = h.context(11, "workspace-2", { portal: "local" });
    for (const window of [local, remote, closedLocal]) h.windows.register(window.value);
    h.realms.set(10, realm.value);
    h.realms.set(11, closedRealm.value);
    closedLocal.destroy();
    closedRealm.destroy();

    h.windows.emitToConnection("local", "local-backend-unavailable", { message: "down" });
    expect(local.sent).toEqual([
      ["orkestrator:event", "local-backend-unavailable", { message: "down" }],
    ]);
    expect(realm.sent).toEqual([
      [PORTAL_EVENT_CHANNEL, "local-backend-unavailable", { message: "down" }],
    ]);
    expect(remote.sent).toEqual([]);
    expect(closedLocal.sent).toEqual([]);
    expect(closedRealm.sent).toEqual([]);

    h.windows.emitToConnection("workspace-1", "workspace-event", 1);
    expect(realm.sent.at(-1)).toEqual(["orkestrator:event", "workspace-event", 1]);
    expect(local.sent).toHaveLength(1);
    expect(remote.sent).toEqual([]);
  });

  test("before connections exist, events go nowhere and a switch is refused", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    h.clearConnections();
    h.windows.emitToConnection("local", "event", null);
    expect(window.sent).toEqual([]);
    h.windows.followConnection(window.value);
    await expect(h.windows.useConnection("remote-1", h.sender(1))).rejects.toThrow(
      "Connections are not initialized",
    );
    expect(h.createPreviews).not.toHaveBeenCalled();
  });

  test("only a window, never a realm, is retitled for its sender", () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    h.realms.set(10, h.context(10, "workspace-1", { portal: "local" }).value);
    h.windows.updateWindowTitle(h.sender(10));
    h.windows.updateWindowTitle(undefined);
    h.windows.updateWindowTitle({});
    expect(h.setConnectionTitle).not.toHaveBeenCalled();
    h.windows.updateWindowTitle(h.sender(1));
    expect(h.setConnectionTitle.mock.calls).toEqual([[window.value]]);
  });

  test("previews on another node's workspace keep the node's site data", () => {
    const h = harness();
    const window = h.context(1, "workspace-1", {
      portal: "local",
      target: { nodeId: "node-7", nodeName: "Seven", path: "direct" },
    });
    h.windows.register(window.value);
    h.routes.set(window.value.scope, "workspace-2");
    h.windows.followConnection(window.value);
    expect(h.createPreviews.mock.calls).toEqual([[window.value, "workspace-2", "node:node-7"]]);
    expect(window.value.previewConnectionId).toBe("workspace-2");
  });
});

describe("using another connection from a window", () => {
  test("moves the window, then swaps its previews to the new connection", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    h.events.length = 0;
    await expect(h.windows.useConnection("remote-1", h.sender(1))).resolves.toEqual({
      activeConnectionId: "remote-1",
      connections: [],
    });
    expect(h.connectionManager.use.mock.calls).toEqual([["remote-1", "scope-1"]]);
    expect(h.events).toEqual([
      "use:remote-1",
      // The window's realms belonged to its previous command node.
      "close realms:1",
      "create previews:remote-1:remote-1",
      "destroy previews:local",
      "dispose transport:local",
      "title:1",
      "publish lists",
    ]);
    expect(window.value.previewConnectionId).toBe("remote-1");
    expect(window.value.browserPreviewManager).toBe(h.created[0]!.manager);
    expect(window.value.previewTransport).toBe(h.created[0]!.previewTransport);
  });

  test("a failed switch leaves the window's previews, title and lists alone", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    const failure = new Error("remote-1 is unreachable");
    h.connectionManager.use.mockImplementation(async () => {
      throw failure;
    });
    h.events.length = 0;
    await expect(h.windows.useConnection("remote-1", h.sender(1))).rejects.toBe(failure);
    expect(h.events).toEqual([]);
    expect(h.createPreviews).not.toHaveBeenCalled();
    expect(h.setConnectionTitle).not.toHaveBeenCalled();
    expect(h.publishConnectionLists).not.toHaveBeenCalled();
    expect(window.value.previewConnectionId).toBe("local");
    expect(window.value.browserPreviewManager).toBe(window.runtime.manager);
    expect(window.value.previewTransport).toBe(window.runtime.previewTransport);
  });

  test("previews that cannot be created keep the old ones until the next follow", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    const failure = new Error("preview partition unavailable");
    h.createPreviews.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(h.windows.useConnection("remote-1", h.sender(1))).rejects.toBe(failure);
    expect(window.value.previewConnectionId).toBe("local");
    expect(window.value.browserPreviewManager).toBe(window.runtime.manager);
    expect(window.runtime.manager.destroyAll).not.toHaveBeenCalled();
    expect(window.runtime.previewTransport.disposeAll).not.toHaveBeenCalled();
    expect(h.setConnectionTitle).not.toHaveBeenCalled();
    expect(h.publishConnectionLists).not.toHaveBeenCalled();

    // The window is on remote-1 now; the next follow replaces the old previews.
    h.windows.followConnection(window.value);
    expect(window.value.previewConnectionId).toBe("remote-1");
    expect(window.value.browserPreviewManager).toBe(h.created[0]!.manager);
    expect(window.runtime.manager.destroyAll).toHaveBeenCalledTimes(1);
  });

  test("a window that closes during the switch gets no new previews", async () => {
    const h = harness();
    const window = h.context(1, "local");
    const closed = h.windows.register(window.value);
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    h.connectionManager.use.mockImplementation(async (connectionId: string, scope: string) => {
      entered.resolve();
      await proceed.promise;
      if (h.routes.has(scope)) h.routes.set(scope, connectionId);
      return { activeConnectionId: connectionId, connections: [] };
    });
    const switching = h.windows.useConnection("remote-1", h.sender(1));
    await entered.promise;
    closed();
    proceed.resolve();
    await expect(switching).rejects.toThrow("The requesting window is no longer available.");
    expect(h.createPreviews).not.toHaveBeenCalled();
    expect(h.publishConnectionLists).not.toHaveBeenCalled();
  });

  test("a sender that is no longer a window is refused before any switch", async () => {
    const h = harness();
    await expect(h.windows.useConnection("remote-1", h.sender(1))).rejects.toThrow(
      "The requesting window is no longer available",
    );
    expect(h.connectionManager.use).not.toHaveBeenCalled();
  });
});

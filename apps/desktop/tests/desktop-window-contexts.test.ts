import { describe, expect, mock, test } from "bun:test";
import {
  DesktopWindowContexts,
  createDesktopRelayedLifecycle,
  type DesktopWindowConnections,
  type DesktopWindowContextRecord,
} from "../electron/desktop-window-contexts";
import { MAX_NODE_EVENT_WATCHES } from "@orkestrator/protocol/node-events";

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
    setRelayedEvents: mock((_connectionId: string, _events: readonly string[]) => undefined),
    relayedEventReady: mock(async (_connectionId: string, _event: string) => undefined),
  };
  let connections: DesktopWindowConnections | null =
    connectionManager as unknown as DesktopWindowConnections;
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
    connections: () => connections,
    createPreviews,
    // Prompts are cancelled while the window is still registered.
    cancelPrompts: (id) => void events.push(`cancel prompts:${id}:${windows.windows.has(id)}`),
    releaseWorkspaceGrant: (scope) => void events.push(`release grant:${scope}`),
    releaseNodeScopes: (context) => void events.push(`release node scopes:${context.contents.id}`),
    releaseSlot: (slot) => void events.push(`release slot:${slot}`),
    setConnectionTitle,
    publishConnectionLists,
    menuChanged: () => void events.push("menu"),
    logger: { warn },
  });

  function context(id: number, connectionId: string) {
    let destroyed = false;
    const sent: Sent[] = [];
    const scope = `scope-${id}`;
    routes.set(scope, connectionId);
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

describe("the per-node relayed events windows listen to", () => {
  const LEAF_EVENT = "relayed-node-event:bk_leaf";
  const OTHER_EVENT = "relayed-node-event:bk_other";
  const filters = (h: ReturnType<typeof harness>) =>
    h.connectionManager.setRelayedEvents.mock.calls.map(([id, events]) => [id, [...events]]);
  const listen = (h: ReturnType<typeof harness>, id: number, event: string) =>
    h.windows.addRelayedListen(h.sender(id), event);

  test("a connection is told the union of its windows' listens, sorted, on a change only", async () => {
    const h = harness();
    h.windows.register(h.context(1, "local").value);
    h.windows.register(h.context(2, "local").value);
    await listen(h, 1, OTHER_EVENT);
    await listen(h, 2, LEAF_EVENT);
    await listen(h, 2, OTHER_EVENT);
    expect(filters(h)).toEqual([
      ["local", [OTHER_EVENT]],
      ["local", [LEAF_EVENT, OTHER_EVENT]],
    ]);
    h.connectionManager.setRelayedEvents.mockClear();
    h.windows.removeRelayedListen(h.sender(1), OTHER_EVENT);
    h.windows.syncRelayedEvents();
    expect(filters(h)).toEqual([]);
    h.windows.removeRelayedListen(h.sender(2), OTHER_EVENT);
    expect(filters(h)).toEqual([["local", [LEAF_EVENT]]]);
  });

  test("the answer waits on the connection the window is bound to", async () => {
    const h = harness();
    h.windows.register(h.context(7, "remote-1").value);
    await listen(h, 7, LEAF_EVENT);
    expect(h.connectionManager.relayedEventReady).toHaveBeenCalledWith("remote-1", LEAF_EVENT);
    expect(filters(h)).toEqual([["remote-1", [LEAF_EVENT]]]);
  });

  test("anything but a per-node relayed event is refused", async () => {
    const h = harness();
    h.windows.register(h.context(1, "local").value);
    for (const event of ["relayed-node-event", "relayed-node-event:", "terminal-output-one", 7]) {
      expect(() => h.windows.addRelayedListen(h.sender(1), event)).toThrow(
        "per-node relayed event",
      );
    }
    expect(filters(h)).toEqual([]);
    expect(() => h.windows.addRelayedListen(h.sender(99), LEAF_EVENT)).toThrow(
      "no longer available",
    );
  });

  test("a renderer's listens are bounded, and repeating one is not another", async () => {
    const h = harness();
    h.windows.register(h.context(1, "local").value);
    for (let index = 0; index < MAX_NODE_EVENT_WATCHES; index += 1) {
      await listen(h, 1, `relayed-node-event:bk_${index}`);
    }
    expect(() => h.windows.addRelayedListen(h.sender(1), LEAF_EVENT)).toThrow("Too many");
    await listen(h, 1, "relayed-node-event:bk_0");
  });

  test("a frame goes only to the windows listening to it", async () => {
    const h = harness();
    const listening = h.context(1, "local");
    const idle = h.context(2, "local");
    const other = h.context(3, "local");
    h.windows.register(listening.value);
    h.windows.register(idle.value);
    h.windows.register(other.value);
    await listen(h, 1, LEAF_EVENT);
    await listen(h, 3, OTHER_EVENT);

    h.windows.relayBackendEvent("local", LEAF_EVENT, { kind: "leaf" });
    h.windows.relayBackendEvent("local", OTHER_EVENT, { kind: "other" });
    expect(listening.sent).toEqual([["orkestrator:event", LEAF_EVENT, { kind: "leaf" }]]);
    expect(idle.sent).toEqual([]);
    expect(other.sent).toEqual([["orkestrator:event", OTHER_EVENT, { kind: "other" }]]);
  });

  test("the old name from an older backend still goes to every window on it", () => {
    const h = harness();
    const first = h.context(1, "local");
    const second = h.context(3, "local");
    h.windows.register(first.value);
    h.windows.register(second.value);
    const frame = { nodeId: "bk_leaf", kind: "resync" };
    h.windows.relayBackendEvent("local", "relayed-node-event", frame);
    expect(first.sent).toEqual([["orkestrator:event", "relayed-node-event", frame]]);
    expect(second.sent).toEqual([["orkestrator:event", "relayed-node-event", frame]]);
  });

  test("main's connection state callback reconciles scopes before publishing", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    await listen(h, 1, LEAF_EVENT);
    h.connectionManager.setRelayedEvents.mockClear();
    const publish = mock(() => {
      expect(filters(h)).toEqual([
        ["local", []],
        ["remote", [LEAF_EVENT]],
      ]);
    });
    const lifecycle = createDesktopRelayedLifecycle(h.windows, publish);
    // A connection-owner update, without useConnection/followConnection doing
    // the reconciliation for us. This is the callback main passes to the manager.
    h.routes.set(window.value.scope, "remote");
    lifecycle.onStateChange();
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("a new document's reset drops only that window's listens", async () => {
    const h = harness();
    h.windows.register(h.context(1, "local").value);
    h.windows.register(h.context(3, "local").value);
    await listen(h, 1, OTHER_EVENT);
    await listen(h, 3, LEAF_EVENT);
    h.connectionManager.setRelayedEvents.mockClear();

    h.windows.resetRelayedListens(h.sender(3));
    expect(filters(h)).toEqual([["local", [OTHER_EVENT]]]);
    h.connectionManager.setRelayedEvents.mockClear();
    h.windows.resetRelayedListens(h.sender(3));
    expect(filters(h)).toEqual([]);
  });

  test("a closed window's listens leave the filter, and the other window's stay", async () => {
    const h = harness();
    const closed = h.windows.register(h.context(1, "local").value);
    h.windows.register(h.context(3, "local").value);
    await listen(h, 1, OTHER_EVENT);
    await listen(h, 3, LEAF_EVENT);
    h.connectionManager.setRelayedEvents.mockClear();

    closed();
    expect(filters(h)).toEqual([["local", [LEAF_EVENT]]]);
    h.connectionManager.setRelayedEvents.mockClear();
    h.windows.dropRelayedListens(1);
    expect(filters(h)).toEqual([]);
  });

  test("a window's listens follow it to another connection", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    await listen(h, 1, LEAF_EVENT);
    h.connectionManager.setRelayedEvents.mockClear();

    await h.windows.useConnection("remote", h.sender(1));
    expect(filters(h)).toEqual([
      ["local", []],
      ["remote", [LEAF_EVENT]],
    ]);
  });

  test("a window on the direct gateway transport has them from its own stream on Local only", async () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register({ ...window.value, localGatewayTransport: true });
    await listen(h, 1, LEAF_EVENT);
    expect(filters(h)).toEqual([]);
    expect(h.connectionManager.relayedEventReady).not.toHaveBeenCalled();
    h.windows.relayBackendEvent("local", LEAF_EVENT, {});
    expect(window.sent).toEqual([]);

    await h.windows.useConnection("remote", h.sender(1));
    expect(filters(h)).toEqual([["remote", [LEAF_EVENT]]]);
  });

  test("a scope released under a live renderer costs its listens, not the others'", async () => {
    const h = harness();
    const released = h.context(1, "remote");
    const staying = h.context(2, "local");
    h.windows.register(released.value);
    h.windows.register(staying.value);
    await listen(h, 1, OTHER_EVENT);
    await listen(h, 2, LEAF_EVENT);
    h.connectionManager.setRelayedEvents.mockClear();

    h.routes.delete(released.value.scope);
    expect(() => h.windows.syncRelayedEvents()).not.toThrow();
    expect(filters(h)).toEqual([["remote", []]]);
  });

  test("nothing is applied before connections exist", () => {
    const h = harness();
    h.clearConnections();
    expect(() => h.windows.syncRelayedEvents()).not.toThrow();
    expect(filters(h)).toEqual([]);
  });
});

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

  test("every renderer is a window", () => {
    const h = harness();
    const first = h.context(1, "local");
    const second = h.context(10, "remote-1");
    h.windows.register(first.value);
    h.windows.register(second.value);
    expect(h.windows.renderers()).toEqual([first.value, second.value]);
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
    const window = h.context(3, "remote-1");
    const closed = h.windows.register(window.value);
    h.events.length = 0;
    closed();
    expect(h.events).toEqual([
      "destroy previews:remote-1",
      "dispose artifacts:3",
      "dispose transport:remote-1",
      "cancel prompts:3:true",
      "release node scopes:3",
      "release grant:scope-3",
      "release:scope-3",
      "release slot:3",
      "menu",
    ]);
    expect(h.windows.windows.has(3)).toBe(false);
  });

  test("closing a window releases only its own scope", () => {
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
    const [event, fields] = await logged.promise;
    expect(event).toBe("transport.close-failed");
    expect((fields as { error: { message: string } }).error.message).toBe(failure.message);
  });

  test("a connection's events reach only the open windows on it", () => {
    const h = harness();
    const local = h.context(1, "local");
    const remote = h.context(2, "remote-1");
    const closedLocal = h.context(3, "local");
    for (const window of [local, remote, closedLocal]) h.windows.register(window.value);
    closedLocal.destroy();

    h.windows.emitToConnection("local", "local-backend-unavailable", { message: "down" });
    expect(local.sent).toEqual([
      ["orkestrator:event", "local-backend-unavailable", { message: "down" }],
    ]);
    expect(remote.sent).toEqual([]);
    expect(closedLocal.sent).toEqual([]);

    h.windows.emitToConnection("remote-1", "remote-event", 1);
    expect(remote.sent).toEqual([["orkestrator:event", "remote-event", 1]]);
    expect(local.sent).toHaveLength(1);
  });

  test("a backend event skips a local window on the direct transport, main's own does not", () => {
    const h = harness();
    const relay = h.context(1, "local");
    const direct = h.context(2, "local");
    const remote = h.context(3, "remote-1");
    (direct.value as Context).localGatewayTransport = true;
    (remote.value as Context).localGatewayTransport = true;
    for (const context of [relay, direct, remote]) h.windows.register(context.value);

    h.windows.relayBackendEvent("local", "terminal-output-local:1", { data: "x" });
    expect(relay.sent).toEqual([["orkestrator:event", "terminal-output-local:1", { data: "x" }]]);
    expect(direct.sent).toEqual([]);

    // A window on another connection still takes that connection's relay.
    h.windows.relayBackendEvent("remote-1", "remote-event", 1);
    expect(remote.sent).toEqual([["orkestrator:event", "remote-event", 1]]);

    h.windows.emitToConnection("local", "local-backend-unavailable", { message: "down" });
    expect(direct.sent).toEqual([
      ["orkestrator:event", "local-backend-unavailable", { message: "down" }],
    ]);
  });

  test("terminal output stays on main's stream only while an open window takes it there", () => {
    const h = harness();
    expect(h.windows.needsLocalTerminalRelay()).toBe(false);
    const direct = h.context(1, "local");
    (direct.value as Context).localGatewayTransport = true;
    h.windows.register(direct.value);
    expect(h.windows.needsLocalTerminalRelay()).toBe(false);

    const relay = h.context(2, "local");
    const closeRelay = h.windows.register(relay.value);
    expect(h.windows.needsLocalTerminalRelay()).toBe(true);
    closeRelay();
    expect(h.windows.needsLocalTerminalRelay()).toBe(false);
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

  test("only a known window is retitled for its sender", () => {
    const h = harness();
    const window = h.context(1, "local");
    h.windows.register(window.value);
    h.windows.updateWindowTitle(h.sender(10));
    h.windows.updateWindowTitle(undefined);
    h.windows.updateWindowTitle({});
    expect(h.setConnectionTitle).not.toHaveBeenCalled();
    h.windows.updateWindowTitle(h.sender(1));
    expect(h.setConnectionTitle.mock.calls).toEqual([[window.value]]);
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
      // The window's node scopes belonged to its previous command node.
      "release node scopes:1",
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

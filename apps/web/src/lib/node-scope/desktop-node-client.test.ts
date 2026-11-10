import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeClient } from "@orkestrator/protocol/node-client";
import {
  createDesktopNodeClient,
  desktopConnectionState,
  nodeRefusalCode,
} from "./desktop-node-client";

type Api = NonNullable<Window["orkestrator"]>;
type StreamState = "idle" | "connecting" | "connected" | "disconnected";

const COMMAND = "bk_command" as BackendId;
const LEAF = "bk_leaf" as BackendId;

function refusal(code: string, text = "refused") {
  return Object.assign(new Error(`[${code}] ${text}`), { code });
}

/** The preload's `node(nodeId)`/`nodes` and top-level API, in memory. */
function fakeHost() {
  const topLevel = new Map<string, Set<(payload: unknown) => void>>();
  const nodes = new Map<string, ReturnType<typeof nodeEntry>>();
  const release = mock((_nodeId: string) => Promise.resolve());
  function nodeEntry(nodeId: string) {
    const listeners = new Map<string, Set<(payload: unknown) => void>>();
    const stateListeners = new Set<(state: StreamState) => void>();
    let state: StreamState = "idle";
    const api = {
      nodeId,
      invoke: mock((command: string, args?: Record<string, unknown>) =>
        Promise.resolve({ nodeId, command, args }),
      ),
      listen: mock((event: string, callback: (payload: unknown) => void) => {
        const set = listeners.get(event) ?? new Set();
        listeners.set(event, set);
        set.add(callback);
        return () => {
          set.delete(callback);
        };
      }),
      eventStreamReady: mock((_event: string) => Promise.resolve()),
      eventStreamConnection: {
        state: () => state,
        subscribe(listener: (next: StreamState) => void) {
          stateListeners.add(listener);
          return () => {
            stateListeners.delete(listener);
          };
        },
      },
    };
    return {
      api,
      emit(event: string, payload: unknown) {
        for (const callback of Array.from(listeners.get(event) ?? [])) callback(payload);
      },
      listenerCount: () => Array.from(listeners.values()).reduce((n, set) => n + set.size, 0),
      stateListenerCount: () => stateListeners.size,
      setState(next: StreamState) {
        state = next;
        for (const listener of Array.from(stateListeners)) listener(next);
      },
    };
  }
  const api = {
    invoke: mock((command: string) => Promise.resolve({ topLevel: command })),
    listen: (event: string, callback: (payload: unknown) => void) => {
      const set = topLevel.get(event) ?? new Set();
      topLevel.set(event, set);
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    },
    node: mock((nodeId: string) => {
      const existing = nodes.get(nodeId) ?? nodeEntry(nodeId);
      nodes.set(nodeId, existing);
      return existing.api;
    }),
    nodes: { release, gateway: mock() },
  };
  return {
    api: api as unknown as Api,
    raw: api,
    node: (nodeId: string) => {
      api.node(nodeId);
      return nodes.get(nodeId)!;
    },
    emitTopLevel(event: string, payload: unknown) {
      for (const callback of Array.from(topLevel.get(event) ?? [])) callback(payload);
    },
    release,
  };
}

let clients: NodeClient[] = [];
afterEach(() => {
  for (const client of clients) client.dispose();
  clients = [];
});

function open(host: ReturnType<typeof fakeHost>, nodeId = LEAF) {
  const client = createDesktopNodeClient({ nodeId, host: () => host.api, commandNodeId: COMMAND });
  clients.push(client);
  return client;
}

describe("createDesktopNodeClient", () => {
  test("invokes and listens on the node's preload API, not the top-level one", async () => {
    const host = fakeHost();
    const client = open(host);
    await expect(client.invokeRaw("get_projects", { a: 1 })).resolves.toEqual({
      nodeId: LEAF,
      command: "get_projects",
      args: { a: 1 },
    });
    expect(host.raw.invoke).not.toHaveBeenCalled();
    const handler = mock((_payload: unknown) => {});
    client.listenRaw("projects-changed", handler);
    host.emitTopLevel("projects-changed", "command");
    host.node(LEAF).emit("projects-changed", "leaf");
    expect(handler.mock.calls).toEqual([["leaf"]]);
  });

  test("the window's command node keeps the top-level API", async () => {
    const host = fakeHost();
    const client = open(host, COMMAND);
    await expect(client.invokeRaw("get_config")).resolves.toEqual({ topLevel: "get_config" });
    const handler = mock((_payload: unknown) => {});
    client.listenRaw("projects-changed", handler);
    host.emitTopLevel("projects-changed", 1);
    expect(handler).toHaveBeenCalledWith(1);
    expect(host.raw.node).not.toHaveBeenCalled();
  });

  test("a leaf's previews are addressed by the leaf, never the window's gateway (4006 Finding 1)", () => {
    const host = fakeHost();
    const leaf = open(host) as NodeClient & { resolvePreviewUrl?: (url: string) => string };
    // The canonical address: main's preview runtime for the leaf (the attach
    // names it) loads it through the leaf's own gateway. Without this the
    // preview store fell back to the window gateway: the command node's page.
    expect(leaf.resolvePreviewUrl?.("http://localhost:5173/app?x=1#h")).toBe(
      "http://localhost:5173/app?x=1#h",
    );
    // The window's own node keeps the window gateway's addressing.
    const command = open(host, COMMAND) as NodeClient & { resolvePreviewUrl?: unknown };
    expect(command.resolvePreviewUrl).toBeUndefined();
  });

  test("an event for node B never reaches a node-A client", () => {
    const host = fakeHost();
    const a = open(host, LEAF);
    const b = open(host, "bk_other" as BackendId);
    const handlerA = mock((_payload: unknown) => {});
    const handlerB = mock((_payload: unknown) => {});
    a.listenRaw("projects-changed", handlerA);
    b.listenRaw("projects-changed", handlerB);
    host.node("bk_other").emit("projects-changed", "b");
    expect(handlerA).not.toHaveBeenCalled();
    expect(handlerB).toHaveBeenCalledWith("b");
  });

  test("connection: live while connected, lapsed after a drop or a closed scope, failed when refused", async () => {
    const host = fakeHost();
    const client = open(host);
    client.listenRaw("projects-changed", () => {});
    const node = host.node(LEAF);
    expect(client.connection.get()).toBe("connecting");
    node.setState("connected");
    expect(client.connection.get()).toBe("live");
    node.setState("disconnected");
    expect(client.connection.get()).toBe("lapsed");

    node.api.invoke.mockImplementationOnce(() => Promise.reject(refusal("node-unavailable")));
    await expect(client.invokeRaw("get_projects")).rejects.toThrow("[node-unavailable]");
    expect(client.connection.get()).toBe("failed");

    node.setState("connected");
    expect(client.connection.get()).toBe("live");

    // A refused administration command says nothing about the connection.
    node.api.invoke.mockImplementationOnce(() => Promise.reject(refusal("node-admin-refused")));
    await expect(client.invokeRaw("set_config")).rejects.toThrow("[node-admin-refused]");
    expect(client.connection.get()).toBe("live");

    // Only the message crosses the context bridge: the refusal is still read
    // from it, and the error the caller shows has the text without the prefix.
    node.setState("disconnected");
    node.api.invoke.mockImplementationOnce(() =>
      Promise.reject(new Error("[node-unavailable] The workspace could not open.")),
    );
    const failure = await client.invokeRaw("get_projects").catch((error: unknown) => error);
    expect((failure as Error).message).toBe("The workspace could not open.");
    expect(nodeRefusalCode(failure)).toBe("node-unavailable");
    expect(client.connection.get()).toBe("failed");
  });

  test("eventStreamReady opens the node and reports its refusal", async () => {
    const host = fakeHost();
    const client = open(host);
    await client.terminal.outputReady("session-1");
    const node = host.node(LEAF);
    expect(node.api.eventStreamReady).toHaveBeenCalledWith("terminal-output-session-1");
    node.api.eventStreamReady.mockImplementationOnce(() => Promise.reject(refusal("unknown-node")));
    await expect(client.eventStreamReady()).rejects.toThrow("[unknown-node]");
    expect(client.connection.get()).toBe("failed");
  });

  test("suspend stops delivery and resume restores it without re-registering", () => {
    const host = fakeHost();
    const client = open(host);
    const handler = mock((_payload: unknown) => {});
    client.listenRaw("projects-changed", handler);
    const node = host.node(LEAF);
    client.suspend();
    expect(node.listenerCount()).toBe(0);
    node.emit("projects-changed", 1);
    client.resume();
    node.emit("projects-changed", 2);
    expect(handler.mock.calls).toEqual([[2]]);
  });

  test("dispose drops listeners, stops watching and releases the node's scope", async () => {
    const host = fakeHost();
    const client = open(host);
    client.listenRaw("projects-changed", () => {});
    const node = host.node(LEAF);
    client.dispose();
    client.dispose();
    expect(node.listenerCount()).toBe(0);
    expect(node.stateListenerCount()).toBe(0);
    expect(host.release.mock.calls).toEqual([[LEAF]]);
    await expect(client.invokeRaw("get_projects")).rejects.toThrow("disposed");
  });

  test("a host without node scopes refuses instead of reaching the command node", async () => {
    const client = createDesktopNodeClient({
      nodeId: LEAF,
      host: () => ({ invoke: mock(), listen: mock() }) as unknown as Api,
      commandNodeId: COMMAND,
    });
    clients.push(client);
    await expect(client.invokeRaw("get_projects")).rejects.toThrow("other machines' scopes");
    expect(client.listenRaw("projects-changed", () => {})).toBeFunction();
  });
});

describe("nodeRefusalCode", () => {
  test("reads the code from error.code or the message prefix", () => {
    expect(nodeRefusalCode(refusal("unknown-node"))).toBe("unknown-node");
    expect(nodeRefusalCode(new Error("[node-scope-closed] The window closed."))).toBe(
      "node-scope-closed",
    );
    expect(nodeRefusalCode(new Error("plain failure"))).toBeNull();
    expect(nodeRefusalCode("[unknown-node] not an error")).toBeNull();
    expect(nodeRefusalCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBeNull();
  });
});

describe("desktopConnectionState", () => {
  test("maps stream, history and refusal", () => {
    const state = (stream: StreamState, everConnected = false, refusal: string | null = null) =>
      desktopConnectionState({ stream, everConnected, refusal });
    expect(state("connected", true, "unknown-node")).toBe("live");
    expect(state("idle")).toBe("connecting");
    expect(state("connecting")).toBe("connecting");
    expect(state("disconnected")).toBe("failed");
    expect(state("disconnected", true)).toBe("lapsed");
    expect(state("connecting", false, "node-scope-closed")).toBe("lapsed");
    expect(state("idle", true, "node-unavailable")).toBe("failed");
  });
});

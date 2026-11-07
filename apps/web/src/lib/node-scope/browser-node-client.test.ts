import { afterEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  GatewayEventStreamConnectionState,
  NodeTransport,
  NodeTransportOptions,
} from "@/lib/native/node-transport";
import {
  browserConnectionState,
  createBrowserNodeClient,
  type BrowserNodeClient,
} from "./browser-node-client";

const NODE = "bk_leaf" as BackendId;

/** An in-memory transport that records what the client asked of it. */
function fakeTransport(options: NodeTransportOptions) {
  const listeners = new Map<string, Set<(payload: unknown) => unknown>>();
  const streamListeners = new Set<(state: GatewayEventStreamConnectionState) => void>();
  let stream: GatewayEventStreamConnectionState = "idle";
  const listenCalls: string[] = [];
  const transport = {
    invoke: mock((command: string, args?: Record<string, unknown>) =>
      Promise.resolve({ command, args }),
    ),
    listen: (event: string, callback: (payload: unknown) => unknown) => {
      listenCalls.push(event);
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(callback);
      return () => {
        set.delete(callback);
        if (set.size === 0) listeners.delete(event);
      };
    },
    eventStreamReady: mock((_event: string) => Promise.resolve()),
    eventStreamConnection: {
      state: () => stream,
      subscribe: (listener: (state: GatewayEventStreamConnectionState) => void) => {
        streamListeners.add(listener);
        return () => {
          streamListeners.delete(listener);
        };
      },
    },
    baseUrl: options.baseUrl,
    requestCredentials: "omit" as RequestCredentials,
    url: (pathname: string) => `${options.baseUrl}${pathname}`,
    requestHeaders: () => undefined,
    readResponse: async <T>() => undefined as T,
    credential: () => undefined,
    setCredential: mock((_token: string) => {}),
    dispose: mock(() => {}),
  };
  return {
    transport: transport as unknown as NodeTransport,
    raw: transport,
    listenCalls,
    emit(event: string, payload: unknown) {
      for (const callback of Array.from(listeners.get(event) ?? [])) callback(payload);
    },
    transportListeners: () => Array.from(listeners.values()).reduce((n, set) => n + set.size, 0),
    streamListenerCount: () => streamListeners.size,
    setStream(state: GatewayEventStreamConnectionState) {
      stream = state;
      for (const listener of Array.from(streamListeners)) listener(state);
    },
    rejectCredential: () => options.onCredentialRejected?.(),
  };
}

let clients: BrowserNodeClient[] = [];
afterEach(() => {
  for (const client of clients) client.dispose();
  clients = [];
});

function open(transportOptions: Partial<NodeTransportOptions> = {}) {
  let fake!: ReturnType<typeof fakeTransport>;
  const onCredentialRejected = mock(() => {});
  const client = createBrowserNodeClient({
    nodeId: NODE,
    transport: {
      baseUrl: "https://leaf.example",
      credential: "grant",
      onCredentialRejected,
      ...transportOptions,
    } as NodeTransportOptions,
    createTransport: (options) => {
      fake = fakeTransport(options);
      return fake.transport;
    },
  });
  clients.push(client);
  return { client, fake, onCredentialRejected };
}

describe("createBrowserNodeClient", () => {
  test("invokes on its own transport and exposes the node's URLs", async () => {
    const { client, fake } = open();
    expect(client.nodeId).toBe(NODE);
    expect(client.baseUrl).toBe("https://leaf.example");
    expect(client.url("/media/a.png")).toBe("https://leaf.example/media/a.png");
    await expect(client.invokeRaw("get_config", { a: 1 })).resolves.toEqual({
      command: "get_config",
      args: { a: 1 },
    });
    expect(fake.raw.invoke).toHaveBeenCalledTimes(1);
  });

  test("shares one transport subscription per event and delivers to every handler", () => {
    const { client, fake } = open();
    const first = mock((_payload: unknown) => {});
    const second = mock((_payload: unknown) => {});
    const stopFirst = client.listenRaw("projects-changed", first);
    const stopSecond = client.listenRaw("projects-changed", second);
    expect(fake.listenCalls).toEqual(["projects-changed"]);
    fake.emit("projects-changed", { id: 1 });
    expect(first).toHaveBeenCalledWith({ id: 1 });
    expect(second).toHaveBeenCalledWith({ id: 1 });
    stopFirst();
    stopFirst();
    expect(fake.transportListeners()).toBe(1);
    stopSecond();
    expect(fake.transportListeners()).toBe(0);
  });

  test("suspend detaches the transport but keeps handlers; resume attaches them again", () => {
    const { client, fake } = open();
    const handler = mock((_payload: unknown) => {});
    client.listenRaw("projects-changed", handler);
    client.terminal.listenOutput("session-1", handler);
    client.suspend();
    expect(fake.transportListeners()).toBe(0);
    fake.emit("projects-changed", 1);
    expect(handler).not.toHaveBeenCalled();
    client.resume();
    expect(fake.listenCalls).toEqual([
      "projects-changed",
      "terminal-output-session-1",
      "projects-changed",
      "terminal-output-session-1",
    ]);
    fake.emit("terminal-output-session-1", "frame");
    expect(handler).toHaveBeenCalledWith("frame");
  });

  test("connection follows the main stream; a refused credential is lapsed until a new one", () => {
    const { client, fake, onCredentialRejected } = open();
    const seen: string[] = [];
    client.connection.subscribe((state) => seen.push(state));
    expect(client.connection.get()).toBe("connecting");
    fake.setStream("connected");
    expect(client.connection.get()).toBe("live");
    fake.rejectCredential();
    expect(client.connection.get()).toBe("lapsed");
    expect(onCredentialRejected).toHaveBeenCalledTimes(1);
    fake.setStream("disconnected");
    expect(client.connection.get()).toBe("lapsed");
    client.setCredential("renewed");
    expect(fake.raw.setCredential).toHaveBeenCalledWith("renewed");
    expect(client.connection.get()).toBe("connecting");
    fake.setStream("connected");
    expect(seen).toEqual(["live", "lapsed", "connecting", "live"]);
  });

  test("eventStreamReady waits for the main stream without an event, and for the event's stream with one", async () => {
    const { client, fake } = open();
    await client.terminal.outputReady("session-1");
    expect(fake.raw.eventStreamReady).toHaveBeenCalledWith("terminal-output-session-1");
    let ready = false;
    const main = client.eventStreamReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    fake.setStream("connected");
    await main;
    expect(ready).toBe(true);
    expect(fake.streamListenerCount()).toBe(1);
  });

  test("dispose closes listeners, pending waits and the transport, and refuses later calls", async () => {
    const { client, fake } = open();
    client.listenRaw("projects-changed", () => {});
    const pending = client.eventStreamReady();
    client.dispose();
    client.dispose();
    await expect(pending).rejects.toThrow("disposed");
    expect(fake.transportListeners()).toBe(0);
    expect(fake.streamListenerCount()).toBe(0);
    expect(fake.raw.dispose).toHaveBeenCalledTimes(1);
    await expect(client.invokeRaw("get_config")).rejects.toThrow("disposed");
    expect(client.listenRaw("x", () => {})).toBeFunction();
    expect(fake.listenCalls).toEqual(["projects-changed"]);
  });

  test("over a real transport created unavailable it is failed and every command throws", async () => {
    const client = createBrowserNodeClient({
      nodeId: NODE,
      transport: { baseUrl: "https://leaf.example", unavailableReason: "No route to the leaf." },
    });
    clients.push(client);
    expect(client.connection.get()).toBe("failed");
    await expect(client.invokeRaw("get_config")).rejects.toThrow("No route to the leaf.");
  });

  test("two clients own independent transports", () => {
    const a = open();
    const b = open();
    const handler = mock((_payload: unknown) => {});
    a.client.listenRaw("projects-changed", handler);
    b.fake.emit("projects-changed", 1);
    expect(handler).not.toHaveBeenCalled();
    a.client.dispose();
    expect(b.fake.raw.dispose).not.toHaveBeenCalled();
  });
});

describe("browserConnectionState", () => {
  test("unavailable beats refused beats the stream", () => {
    expect(
      browserConnectionState({ unavailable: true, credentialRejected: true, stream: "connected" }),
    ).toBe("failed");
    expect(
      browserConnectionState({ unavailable: false, credentialRejected: true, stream: "connected" }),
    ).toBe("lapsed");
    for (const stream of ["idle", "connecting", "disconnected"] as const)
      expect(
        browserConnectionState({ unavailable: false, credentialRejected: false, stream }),
      ).toBe("connecting");
  });
});

import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
} from "@orkestrator/protocol/terminal-websocket";
import { TerminalWebSocketClient, type TerminalSocketPayload } from "./terminal-websocket-client";

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: unknown[] = [];
  closes: Array<{ code: number; reason: string }> = [];

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
const clients: TerminalWebSocketClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

function setVisibility(value: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

const CALLBACKS = {
  onFallbackRequired: () => undefined,
  onSocketReady: () => undefined,
  onChannelReady: () => undefined,
  onChannelUnavailable: () => undefined,
};

const PROBE_TIMEOUT_MS = 5;
const pastProbeTimeout = () => new Promise((resolve) => setTimeout(resolve, PROBE_TIMEOUT_MS * 4));

function controlFrames(socket: MockWebSocket): Array<{ type: string; [key: string]: unknown }> {
  return socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { type: string });
}

function pings(socket: MockWebSocket): number[] {
  return controlFrames(socket)
    .filter((frame) => frame.type === "ping")
    .map((frame) => frame.nonce as number);
}

/** `features` is what the server's ready frame advertises; omitted, it predates them. */
function subscribedHarness(features?: string[], heartbeatIntervalMs?: number) {
  let now = 1_000_000;
  const sockets: MockWebSocket[] = [];
  const unavailable = mock((_sessionId: string) => undefined);
  const client = new TerminalWebSocketClient({
    ...CALLBACKS,
    url: "ws://gateway.test/__orkestrator/terminal",
    reconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    subscriptionRetryDelayMs: 0,
    acknowledgementDelayMs: 0,
    foregroundProbeTimeoutMs: PROBE_TIMEOUT_MS,
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    reconnectNow: () => now,
    createSocket: () => {
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onChannelUnavailable: unavailable,
  });
  clients.push(client);
  const payloads: TerminalSocketPayload[] = [];
  const unsubscribe = client.subscribe("session-a", (payload) => {
    payloads.push(payload);
  });
  const socket = sockets[0]!;
  socket.open();
  socket.receive(
    JSON.stringify({
      type: "ready",
      version: 1,
      socketId: "one",
      ...(features ? { features } : {}),
    }),
  );
  const subscribe = socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { type: string; requestId?: number })
    .find((frame) => frame.type === "subscribe")!;
  socket.receive(
    JSON.stringify({
      type: "subscribed",
      requestId: subscribe.requestId,
      sessionId: "session-a",
      channelId: 7,
      baseGeneration: 1,
      baseRevision: 0,
      targetGeneration: 1,
      targetRevision: 0,
      recovery: "current",
    }),
  );
  const hideFor = (ms: number) => {
    setVisibility("hidden");
    now += ms;
    setVisibility("visible");
  };
  return { client, sockets, socket, payloads, unavailable, hideFor, unsubscribe };
}

describe("terminal WebSocket on returning to the page (WEB-11)", () => {
  test("a socket that answers the foreground ping is kept, with no channel reconciled", async () => {
    const { sockets, socket, payloads, unavailable, hideFor } = subscribedHarness(["ping"]);
    hideFor(10 * 60_000);
    const [nonce] = pings(socket);
    expect(nonce).toBeNumber();
    socket.receive(JSON.stringify({ type: "pong", nonce }));
    await pastProbeTimeout();

    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(unavailable).not.toHaveBeenCalled();
    expect(payloads.filter((payload) => "desynced" in payload)).toEqual([]);
    expect(controlFrames(socket).filter((frame) => frame.type === "subscribe")).toHaveLength(1);

    // The kept channel carries on from its cursor.
    socket.receive(
      encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.output,
        channelId: 7,
        generation: 1,
        revision: 1,
        bytes: new TextEncoder().encode("after"),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(payloads.at(-1)).toMatchObject({ generation: 1, revision: 1 });
  });

  test("a socket that stays OPEN but never answers the ping is replaced", async () => {
    const { sockets, socket, payloads, unavailable, hideFor } = subscribedHarness(["ping"]);
    hideFor(200);
    expect(pings(socket)).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    await pastProbeTimeout();
    expect(socket.closes.at(-1)?.reason).toBe("Foreground reconciliation");
    expect(sockets).toHaveLength(2);
    expect(unavailable).toHaveBeenCalledWith("session-a");
    expect(payloads.at(-1)).toMatchObject({ desynced: true });
  });

  test("a pong for an earlier probe does not prove the current one", async () => {
    const { sockets, socket, hideFor } = subscribedHarness(["ping"]);
    hideFor(200);
    const [nonce] = pings(socket);
    socket.receive(JSON.stringify({ type: "pong", nonce: nonce! + 1 }));
    await pastProbeTimeout();
    expect(sockets).toHaveLength(2);
  });

  test("returning again while a probe is out sends no second ping", () => {
    const { socket, hideFor } = subscribedHarness(["ping"]);
    hideFor(200);
    hideFor(200);
    expect(pings(socket)).toHaveLength(1);
  });

  test("hidden again before the answer, the socket is left for the next return", async () => {
    const { sockets, socket, hideFor } = subscribedHarness(["ping"]);
    hideFor(200);
    setVisibility("hidden");
    await pastProbeTimeout();
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);

    setVisibility("visible");
    expect(pings(socket)).toHaveLength(2);
    socket.receive(JSON.stringify({ type: "pong", nonce: pings(socket)[1] }));
    await pastProbeTimeout();
    expect(sockets).toHaveLength(1);
  });

  test("disposing during a probe leaves nothing to fire", async () => {
    const { client, sockets, hideFor } = subscribedHarness(["ping"]);
    hideFor(200);
    client.dispose();
    await pastProbeTimeout();
    expect(sockets).toHaveLength(1);
  });

  test.each([0, 200, 4_999, 5_000, 600_000])(
    "a server that does not answer pings has its OPEN socket replaced after a %i ms hide",
    async (hiddenMs) => {
      const { sockets, socket, payloads, unavailable, hideFor } = subscribedHarness();
      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(pings(socket)).toEqual([]);
      // No terminal close/error is delivered. The main event stream stays
      // healthy (never calls dropConnection); no input or resize drives recovery.
      hideFor(hiddenMs);
      await Promise.resolve();
      expect(socket.closes.at(-1)?.reason).toBe("Foreground reconciliation");
      expect(sockets).toHaveLength(2);
      expect(unavailable).toHaveBeenCalledWith("session-a");
      expect(payloads.at(-1)).toMatchObject({ desynced: true });

      const replacement = sockets[1]!;
      replacement.open();
      replacement.receive(JSON.stringify({ type: "ready", version: 1, socketId: "two" }));
      const subscribe = replacement.sent
        .filter((frame): frame is string => typeof frame === "string")
        .map((frame) => JSON.parse(frame) as { type: string; requestId: number })
        .find((frame) => frame.type === "subscribe")!;
      replacement.receive(
        JSON.stringify({
          type: "subscribed",
          requestId: subscribe.requestId,
          sessionId: "session-a",
          channelId: 8,
          baseGeneration: 1,
          baseRevision: 0,
          targetGeneration: 1,
          targetRevision: 0,
          recovery: "current",
        }),
      );
      replacement.receive(
        encodeTerminalBinaryFrame({
          type: TERMINAL_BINARY_FRAME_TYPE.output,
          channelId: 8,
          generation: 1,
          revision: 1,
          bytes: new TextEncoder().encode("recovered"),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(payloads.at(-1)).toMatchObject({ generation: 1, revision: 1 });
      expect(new TextDecoder().decode(payloads.at(-1)?.bytes)).toBe("recovered");
    },
  );

  test("hiding alone leaves background terminal work connected", () => {
    const { sockets, socket, unavailable } = subscribedHarness();
    setVisibility("hidden");
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(unavailable).not.toHaveBeenCalled();
  });

  test("a socket that has not been answered retries at once on a desktop too", () => {
    const sockets: MockWebSocket[] = [];
    const client = new TerminalWebSocketClient({
      ...CALLBACKS,
      url: "ws://gateway.test/__orkestrator/terminal",
      createSocket: () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });
    clients.push(client);
    client.subscribe("session-a", () => undefined);

    setVisibility("hidden");
    setVisibility("visible");
    expect(sockets[0]!.closes.at(-1)?.reason).toBe("Foreground reconciliation");
    expect(sockets).toHaveLength(2);
  });
});

describe("terminal WebSocket heartbeat while the page stays visible (to-do 7200 task 4)", () => {
  const INTERVAL_MS = 25;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (condition: () => boolean) => {
    for (let waited = 0; !condition(); waited += 1) {
      if (waited > 200) throw new Error("condition not reached");
      await sleep(INTERVAL_MS / 4);
    }
  };
  const visibleHarness = (features: string[] | undefined) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    return subscribedHarness(features, INTERVAL_MS);
  };

  test("a quiet socket that leaves two pings unanswered is replaced", async () => {
    const { sockets, socket, payloads, unavailable } = visibleHarness(["ping"]);
    // The `subscribed` frame was the last thing heard, so the first quiet
    // interval sends a ping, and the socket survives its first miss.
    await waitFor(() => pings(socket).length === 1);
    expect(sockets).toHaveLength(1);

    await waitFor(() => sockets.length === 2);
    expect(pings(socket)).toHaveLength(2);
    expect(socket.closes.at(-1)?.reason).toBe("Foreground reconciliation");
    expect(sockets).toHaveLength(2);
    expect(unavailable).toHaveBeenCalledWith("session-a");
    expect(payloads.at(-1)).toMatchObject({ desynced: true });
  });

  test("a socket that answers its pings is kept", async () => {
    const { sockets, socket, unavailable } = visibleHarness(["ping"]);
    for (let answered = 0; answered < 4;) {
      await sleep(INTERVAL_MS / 2);
      const sent = pings(socket);
      if (sent.length > answered) {
        socket.receive(JSON.stringify({ type: "pong", nonce: sent.at(-1) }));
        answered = sent.length;
      }
    }
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(unavailable).not.toHaveBeenCalled();
  });

  test("a busy socket is never pinged: any frame proves it live", async () => {
    const { sockets, socket } = visibleHarness(["ping"]);
    for (let revision = 1; revision <= 40; revision += 1) {
      socket.receive(
        encodeTerminalBinaryFrame({
          type: TERMINAL_BINARY_FRAME_TYPE.output,
          channelId: 7,
          generation: 1,
          revision,
          bytes: new TextEncoder().encode("x"),
        }),
      );
      await sleep(INTERVAL_MS / 5);
    }
    // Strictly none on an idle host; a stalled test runner may let one tick
    // pass quietly, which still must not replace a socket this busy.
    expect(pings(socket).length).toBeLessThanOrEqual(1);
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
  });

  test("a hidden page sends no heartbeat, so background work keeps its socket", async () => {
    const { sockets, socket } = visibleHarness(["ping"]);
    setVisibility("hidden");
    await sleep(INTERVAL_MS * 5);
    expect(pings(socket)).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
  });

  test("returning to the page restarts the heartbeat after the foreground probe", async () => {
    const { sockets, socket, hideFor } = visibleHarness(["ping"]);
    hideFor(200);
    const [probe] = pings(socket);
    socket.receive(JSON.stringify({ type: "pong", nonce: probe }));
    await sleep(INTERVAL_MS * 6);
    // The probe's answer is the last frame: the heartbeat pings twice and then replaces.
    expect(pings(socket).length).toBeGreaterThanOrEqual(3);
    expect(sockets).toHaveLength(2);
  });

  test("a server that does not answer pings is never heartbeated", async () => {
    const { sockets, socket } = visibleHarness(undefined);
    await sleep(INTERVAL_MS * 5);
    expect(pings(socket)).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  test("disposing and unsubscribing both stop the heartbeat", async () => {
    const disposed = visibleHarness(["ping"]);
    disposed.client.dispose();
    await sleep(INTERVAL_MS * 4);
    expect(pings(disposed.socket)).toEqual([]);

    const idle = visibleHarness(["ping"]);
    idle.unsubscribe();
    await sleep(INTERVAL_MS * 4);
    expect(pings(idle.socket)).toEqual([]);
  });
});

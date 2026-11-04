import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
} from "@orkestrator/protocol/terminal-websocket";
import {
  MOBILE_FOREGROUND_REBUILD_AFTER_HIDDEN_MS,
  TerminalWebSocketClient,
  type TerminalSocketPayload,
} from "./terminal-websocket-client";

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

function subscribedHarness(mobileHost: boolean) {
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
    reconnectNow: () => now,
    mobileHost,
    createSocket: () => {
      const socket = new MockWebSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onChannelUnavailable: unavailable,
  });
  clients.push(client);
  const payloads: TerminalSocketPayload[] = [];
  client.subscribe("session-a", (payload) => {
    payloads.push(payload);
  });
  const socket = sockets[0]!;
  socket.open();
  socket.receive(JSON.stringify({ type: "ready", version: 1, socketId: "one" }));
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
  return { client, sockets, socket, payloads, unavailable, hideFor };
}

describe("terminal WebSocket on returning to the page (WEB-11)", () => {
  test("a healthy desktop socket stays up, with no channel reconciled, after any hide", async () => {
    const { sockets, socket, payloads, unavailable, hideFor } = subscribedHarness(false);
    hideFor(10 * 60_000);
    await Promise.resolve();

    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
    expect(payloads.filter((payload) => "desynced" in payload)).toEqual([]);
    expect(unavailable).not.toHaveBeenCalled();
  });

  test("a kept channel still receives output in order after the hide", async () => {
    const { socket, payloads, hideFor } = subscribedHarness(false);
    hideFor(60_000);

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

  test("a mobile socket hidden for a moment stays up", () => {
    const { sockets, socket, hideFor } = subscribedHarness(true);
    hideFor(MOBILE_FOREGROUND_REBUILD_AFTER_HIDDEN_MS - 1);
    expect(sockets).toHaveLength(1);
    expect(socket.closes).toEqual([]);
  });

  test("a mobile socket hidden past the bound is rebuilt and every channel recovers", async () => {
    const { sockets, socket, payloads, hideFor } = subscribedHarness(true);
    hideFor(MOBILE_FOREGROUND_REBUILD_AFTER_HIDDEN_MS);
    await Promise.resolve();

    expect(socket.closes.at(-1)?.reason).toBe("Foreground reconciliation");
    expect(sockets).toHaveLength(2);
    expect(payloads.at(-1)).toMatchObject({ desynced: true });
  });

  test("a socket that has not been answered retries at once on a desktop too", () => {
    const sockets: MockWebSocket[] = [];
    const client = new TerminalWebSocketClient({
      ...CALLBACKS,
      url: "ws://gateway.test/__orkestrator/terminal",
      mobileHost: false,
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

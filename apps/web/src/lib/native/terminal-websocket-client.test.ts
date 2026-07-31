import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
} from "@orkestrator/protocol/terminal-websocket";
import {
  TerminalWebSocketClient,
  terminalWebSocketUrl,
  type TerminalSocketPayload,
  type TerminalWebSocketClientOptions,
} from "./terminal-websocket-client";

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  sent: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
  closes: Array<{ code: number; reason: string }> = [];
  throwOnSend = false;

  constructor(readonly url: string, readonly protocols: string | string[]) {}

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.throwOnSend) throw new Error("mock send failure");
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.closes.push({ code, reason });
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

type Harness = {
  client: TerminalWebSocketClient;
  sockets: MockWebSocket[];
  fallback: ReturnType<typeof mock>;
  socketReady: ReturnType<typeof mock>;
  channelReady: ReturnType<typeof mock>;
  channelUnavailable: ReturnType<typeof mock>;
};

const clients: TerminalWebSocketClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function createHarness(overrides: Partial<TerminalWebSocketClientOptions> = {}): Harness {
  const sockets: MockWebSocket[] = [];
  const fallback = mock(() => undefined);
  const socketReady = mock(() => undefined);
  const channelReady = mock((_sessionId: string) => undefined);
  const channelUnavailable = mock((_sessionId: string) => undefined);
  const client = new TerminalWebSocketClient({
    url: "ws://gateway.test/__orkestrator/terminal",
    reconnectDelayMs: 0,
    maxReconnectDelayMs: 0,
    subscriptionRetryDelayMs: 0,
    createSocket: (url, protocols) => {
      const socket = new MockWebSocket(url, protocols);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    onFallbackRequired: fallback,
    onSocketReady: socketReady,
    onChannelReady: channelReady,
    onChannelUnavailable: channelUnavailable,
    ...overrides,
  });
  clients.push(client);
  return { client, sockets, fallback, socketReady, channelReady, channelUnavailable };
}

function sentControls(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

function sentBinaries(socket: MockWebSocket): ReturnType<typeof decodeTerminalBinaryFrame>[] {
  return socket.sent
    .filter((value) => typeof value !== "string")
    .map((value) => decodeTerminalBinaryFrame(value as Uint8Array));
}

function openAndReady(socket: MockWebSocket, socketId = "socket-one"): void {
  socket.open();
  socket.receive(JSON.stringify({ type: "ready", version: 1, socketId }));
}

function subscribeFrame(socket: MockWebSocket, sessionId: string): Record<string, unknown> {
  const frame = sentControls(socket).findLast(
    (candidate) => candidate.type === "subscribe" && candidate.sessionId === sessionId,
  );
  if (!frame) throw new Error(`No subscribe frame for ${sessionId}`);
  return frame;
}

function acceptSubscription(
  socket: MockWebSocket,
  sessionId: string,
  channelId: number,
  generation = 1,
  revision = 0,
  recovery: "current" | "snapshot-required" = "current",
): void {
  const requestId = subscribeFrame(socket, sessionId).requestId as number;
  socket.receive(JSON.stringify({
    type: "subscribed",
    requestId,
    sessionId,
    channelId,
    baseGeneration: recovery === "current" ? generation : null,
    baseRevision: recovery === "current" ? revision : null,
    targetGeneration: generation,
    targetRevision: revision,
    recovery,
  }));
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
}

describe("TerminalWebSocketClient", () => {
  test("owns one socket, multiplexes channels, acknowledges operations, and reconnects cursors", async () => {
    const { client, sockets, fallback, socketReady, channelReady } = createHarness();
    const outputA = mock((_payload: TerminalSocketPayload) => undefined);
    const outputB = mock((_payload: TerminalSocketPayload) => undefined);
    const unsubscribeA = client.subscribe("session-a", outputA);
    const unsubscribeB = client.subscribe("session-b", outputB);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.protocols).toBe(TERMINAL_WEBSOCKET_SUBPROTOCOL);
    expect(sockets[0]!.binaryType).toBe("arraybuffer");

    const first = sockets[0]!;
    openAndReady(first);
    acceptSubscription(first, "session-a", 11, 1, 0);
    acceptSubscription(first, "session-b", 22, 3, 0);
    await Promise.all([client.ready("session-a"), client.ready("session-b")]);
    expect(channelReady.mock.calls.map((call) => call[0]).sort()).toEqual(["session-a", "session-b"]);

    first.receive(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 11,
      generation: 1,
      revision: 1,
      bytes: new TextEncoder().encode("alpha"),
    }));
    first.receive(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 22,
      generation: 3,
      revision: 1,
      bytes: new TextEncoder().encode("beta"),
    }));
    await tick();
    expect(new TextDecoder().decode(outputA.mock.calls.at(-1)?.[0].bytes)).toBe("alpha");
    expect(new TextDecoder().decode(outputB.mock.calls.at(-1)?.[0].bytes)).toBe("beta");
    expect(sentControls(first)).toContainEqual({ type: "ack", channelId: 11, generation: 1, revision: 1 });

    const inputResult = client.sendInput("session-a", "pwd\r");
    const input = sentBinaries(first).find((frame) => frame.type === TERMINAL_BINARY_FRAME_TYPE.input)!;
    first.receive(JSON.stringify({
      type: "operation-result", channelId: 11, operationId: input.revision, operation: "input", ok: true,
    }));
    expect(await inputResult).toBe(true);

    const resizeResult = client.resize("session-b", 120, 40);
    const resize = sentControls(first).findLast((frame) => frame.type === "resize")!;
    expect(resize).toMatchObject({ type: "resize", channelId: 22, cols: 120, rows: 40 });
    first.receive(JSON.stringify({
      type: "operation-result", channelId: 22, operationId: resize.operationId,
      operation: "resize", ok: true,
    }));
    expect(await resizeResult).toBe(true);

    first.close(1006, "network lost");
    await tick();
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    openAndReady(second, "socket-two");
    expect(sentControls(second).filter((frame) => frame.type === "subscribe")).toEqual([
      { type: "subscribe", requestId: 3, sessionId: "session-a", knownGeneration: 1, knownRevision: 1 },
      { type: "subscribe", requestId: 4, sessionId: "session-b", knownGeneration: 3, knownRevision: 1 },
    ]);
    expect(socketReady).toHaveBeenCalledTimes(2);

    unsubscribeA();
    unsubscribeB();
  });

  test("authenticates, waits for ready before subscribing, rotates tokens, and rebuilds when visible", async () => {
    const { client, sockets } = createHarness({ token: "old-token" });
    client.subscribe("session-a", () => undefined);
    const first = sockets[0]!;
    first.open();
    expect(sentControls(first)).toEqual([{
      type: "authenticate", version: 1, token: "old-token",
    }]);
    // A second desired channel added before server readiness must not overtake authentication.
    client.subscribe("session-b", () => undefined);
    expect(sentControls(first).filter((frame) => frame.type === "subscribe")).toHaveLength(0);
    first.receive(JSON.stringify({ type: "ready", version: 1, socketId: "one" }));
    expect(sentControls(first).filter((frame) => frame.type === "subscribe")).toHaveLength(2);

    client.updateToken("new-token");
    await tick();
    expect(first.closes.at(-1)?.reason).toBe("Gateway credential changed");
    const second = sockets[1]!;
    second.open();
    expect(sentControls(second)[0]).toEqual({ type: "authenticate", version: 1, token: "new-token" });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(sockets).toHaveLength(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(second.closes.at(-1)?.reason).toBe("Foreground reconciliation");
    expect(sockets).toHaveLength(3);
  });

  test("falls back and retries when socket construction or subscription fails", async () => {
    let attempts = 0;
    const sockets: MockWebSocket[] = [];
    const fallback = mock(() => undefined);
    const unavailable = mock((_sessionId: string) => undefined);
    const client = new TerminalWebSocketClient({
      url: "ws://gateway.test/__orkestrator/terminal",
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      subscriptionRetryDelayMs: 0,
      createSocket: (url, protocols) => {
        attempts += 1;
        if (attempts === 1) throw new Error("constructor failed");
        const socket = new MockWebSocket(url, protocols);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onFallbackRequired: fallback,
      onSocketReady: () => undefined,
      onChannelUnavailable: unavailable,
    });
    clients.push(client);
    client.subscribe("session-a", () => undefined);
    await tick();
    expect(fallback).toHaveBeenCalledTimes(1);
    openAndReady(sockets[0]!);
    const requestId = subscribeFrame(sockets[0]!, "session-a").requestId;
    sockets[0]!.receive(JSON.stringify({
      type: "error", code: "terminal-unavailable", message: "not yet", requestId,
    }));
    await client.ready("session-a");
    await tick();
    expect(unavailable).toHaveBeenCalledWith("session-a");
    expect(sentControls(sockets[0]!).filter((frame) => frame.type === "subscribe")).toHaveLength(2);
  });

  test("reference-counts duplicate callbacks and cleans up orphaned subscription replies", () => {
    const { client, sockets } = createHarness();
    const callback = mock((_payload: TerminalSocketPayload) => undefined);
    const firstUnlisten = client.subscribe("session-a", callback);
    const secondUnlisten = client.subscribe("session-a", callback);
    openAndReady(sockets[0]!);
    expect(sentControls(sockets[0]!).filter((frame) => frame.type === "subscribe")).toHaveLength(1);
    acceptSubscription(sockets[0]!, "session-a", 7);
    firstUnlisten();
    expect(sentControls(sockets[0]!).some((frame) => frame.type === "unsubscribe")).toBe(false);
    secondUnlisten();
    expect(sentControls(sockets[0]!)).toContainEqual({ type: "unsubscribe", channelId: 7 });

    const keepAlive = client.subscribe("session-c", () => undefined);
    const unlisten = client.subscribe("session-b", callback);
    const secondSocket = sockets.at(-1)!;
    openAndReady(secondSocket, "two");
    const requestId = subscribeFrame(secondSocket, "session-b").requestId;
    unlisten();
    secondSocket.receive(JSON.stringify({
      type: "subscribed", requestId, sessionId: "session-b", channelId: 9,
      baseGeneration: 1, baseRevision: 0, targetGeneration: 1, targetRevision: 0, recovery: "current",
    }));
    // The reply belongs to a removed desired subscription, so its server channel is closed.
    expect(sentControls(secondSocket)).toContainEqual({ type: "unsubscribe", channelId: 9 });
    keepAlive();
  });

  test("bounds output while awaiting a snapshot and resubscribes from the snapshot cursor", async () => {
    const { client, sockets, channelReady, channelUnavailable } = createHarness({
      maxAwaitingSnapshotFrames: 1,
      maxAwaitingSnapshotBytes: 16,
    });
    const outputs = mock((_payload: TerminalSocketPayload) => undefined);
    client.subscribe("session-a", outputs);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 10, 2, 5, "snapshot-required");
    expect(channelUnavailable).toHaveBeenCalledWith("session-a");
    for (const revision of [6, 7]) {
      socket.receive(encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.output,
        channelId: 10,
        generation: 2,
        revision,
        bytes: new Uint8Array([revision]),
      }));
    }
    await tick();
    client.observeSnapshot("session-a", { generation: 2, revision: 5 });
    await tick();
    expect(sentControls(socket)).toContainEqual({ type: "unsubscribe", channelId: 10 });
    expect(subscribeFrame(socket, "session-a")).toMatchObject({ knownGeneration: 2, knownRevision: 5 });
    expect(channelReady).not.toHaveBeenCalled();

    acceptSubscription(socket, "session-a", 11, 2, 5);
    expect(channelReady).toHaveBeenCalledWith("session-a");
  });

  test("retries after snapshot failure and recovers a desynchronized channel", async () => {
    const { client, sockets, channelReady, channelUnavailable } = createHarness();
    const outputs = mock((_payload: TerminalSocketPayload) => undefined);
    client.subscribe("session-a", outputs);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 10, 1, 0, "snapshot-required");
    client.observeSnapshotFailure("session-a");
    await tick();
    expect(sentControls(socket)).toContainEqual({ type: "unsubscribe", channelId: 10 });
    acceptSubscription(socket, "session-a", 11, 1, 0, "snapshot-required");
    client.observeSnapshot("session-a", { generation: 1, revision: 0 });
    await tick();
    expect(channelReady).toHaveBeenCalledWith("session-a");

    socket.receive(JSON.stringify({
      type: "desync", channelId: 11, generation: 1, revision: 3, reason: "revision-gap",
    }));
    expect(outputs.mock.calls.at(-1)?.[0]).toMatchObject({ desynced: true, generation: 1, revision: 3 });
    expect(channelUnavailable.mock.calls.length).toBeGreaterThanOrEqual(2);
    client.observeSnapshot("session-a", { generation: 1, revision: 3 });
    await tick();
    expect(subscribeFrame(socket, "session-a")).toMatchObject({ knownGeneration: 1, knownRevision: 3 });
  });

  test("rejects failed or mismatched operations and all pending work on close", async () => {
    const { client, sockets } = createHarness();
    client.subscribe("session-a", () => undefined);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 4);

    const failedInput = client.sendInput("session-a", "x");
    const input = sentBinaries(socket).at(-1)!;
    socket.receive(JSON.stringify({
      type: "operation-result", channelId: 4, operationId: input.revision,
      operation: "input", ok: false, message: "write rejected",
    }));
    await expect(failedInput).rejects.toThrow("write rejected");

    const mismatchedResize = client.resize("session-a", 80, 24);
    const resize = sentControls(socket).findLast((frame) => frame.type === "resize")!;
    socket.receive(JSON.stringify({
      type: "operation-result", channelId: 99, operationId: resize.operationId,
      operation: "resize", ok: true,
    }));
    expect(socket.closes.at(-1)?.reason).toBe("Mismatched operation response");
    await expect(mismatchedResize).rejects.toThrow("closed before the operation completed");

    expect(await client.sendInput("missing", "x")).toBe(false);
    expect(await client.resize("missing", 80, 24)).toBe(false);
  });

  test("propagates synchronous socket send failures without leaking pending operations", async () => {
    for (const operation of ["input", "resize"] as const) {
      const { client, sockets, channelUnavailable } = createHarness();
      client.subscribe("session-a", () => undefined);
      const socket = sockets[0]!;
      openAndReady(socket);
      acceptSubscription(socket, "session-a", 4);
      socket.throwOnSend = true;
      const result = operation === "input"
        ? client.sendInput("session-a", "x")
        : client.resize("session-a", 80, 24);
      await expect(result).rejects.toThrow("mock send failure");
      expect(channelUnavailable).toHaveBeenCalledWith("session-a");
      client.dispose();
    }
  });

  test("bounds pending operation acknowledgements by count and bytes", async () => {
    const { client, sockets, channelUnavailable } = createHarness({
      maxPendingOperations: 1,
      maxPendingOperationBytes: 2,
    });
    client.subscribe("session-a", () => undefined);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 4);

    const pending = client.sendInput("session-a", "ab");
    await expect(client.resize("session-a", 80, 24)).rejects.toThrow("operation queue limit exceeded");
    await expect(pending).rejects.toThrow("Terminal channel is recovering");
    expect(channelUnavailable).toHaveBeenCalledWith("session-a");
    await tick();
    expect(sentControls(socket)).toContainEqual({ type: "unsubscribe", channelId: 4 });
    expect(sentControls(socket).filter((frame) => frame.type === "subscribe")).toHaveLength(2);
  });

  test("times out missing operation acknowledgements and reconnects through fallback", async () => {
    const { client, sockets, fallback, channelUnavailable } = createHarness({ operationTimeoutMs: 1 });
    client.subscribe("session-a", () => undefined);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 4);

    const pending = client.resize("session-a", 80, 24);
    await expect(pending).rejects.toThrow("resize acknowledgement timed out");
    expect(channelUnavailable).toHaveBeenCalledWith("session-a");
    expect(socket.closes.at(-1)).toEqual({
      code: 4008,
      reason: "Terminal operation acknowledgement timed out",
    });
    expect(fallback).toHaveBeenCalled();
  });

  test("splits large UTF-8 input only at code point boundaries", async () => {
    const { client, sockets } = createHarness({ maxPendingOperationBytes: 4 * 1024 * 1024 });
    client.subscribe("session-a", () => undefined);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 4);
    const maxPayload = TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES;
    const value = `${"a".repeat(maxPayload - 1)}🙂tail`;
    const result = client.sendInput("session-a", value);
    const frames = sentBinaries(socket).filter((frame) => frame.type === TERMINAL_BINARY_FRAME_TYPE.input);
    expect(frames).toHaveLength(2);
    expect(frames[0]!.bytes.byteLength).toBe(maxPayload - 1);
    expect(frames.map((frame) => new TextDecoder(undefined, { fatal: true }).decode(frame.bytes)).join(""))
      .toBe(value);
    for (const frame of frames) {
      socket.receive(JSON.stringify({
        type: "operation-result", channelId: 4, operationId: frame.revision, operation: "input", ok: true,
      }));
    }
    expect(await result).toBe(true);
  });

  test("closes on malformed control, binary, unsupported, and wrong-direction frames", async () => {
    for (const data of ["not json", new Uint8Array([1, 2, 3]), { unsupported: true }]) {
      const { client, sockets } = createHarness();
      client.subscribe("session-a", () => undefined);
      const socket = sockets[0]!;
      openAndReady(socket);
      socket.receive(data);
      await tick();
      expect(socket.closes.at(-1)?.code).toBe(4004);
      client.dispose();
    }

    const { client, sockets } = createHarness();
    client.subscribe("session-a", () => undefined);
    const socket = sockets[0]!;
    openAndReady(socket);
    acceptSubscription(socket, "session-a", 5);
    socket.receive(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 5,
      generation: 1,
      revision: 1,
      bytes: new Uint8Array(),
    }));
    await tick();
    expect(socket.closes.at(-1)?.reason).toBe("Server sent an input frame");
  });

  test("builds public and same-origin WebSocket URLs", () => {
    expect(terminalWebSocketUrl("https://example.test/gateway")).toBe(
      "wss://example.test/__orkestrator/terminal",
    );
    expect(terminalWebSocketUrl("http://example.test:8080")).toBe(
      "ws://example.test:8080/__orkestrator/terminal",
    );
    (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://app.test/page");
    expect(terminalWebSocketUrl()).toBe("wss://app.test/__orkestrator/terminal");
  });
});

import { describe, expect, mock, test } from "bun:test";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
} from "@orkestrator/protocol/terminal-websocket";
import { TerminalWebSocketClient } from "./terminal-websocket-client";

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

  constructor(readonly url: string, readonly protocols: string | string[]) {}

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: string | Uint8Array): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

function sentControls(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.sent
    .filter((value): value is string => typeof value === "string")
    .map((value) => JSON.parse(value) as Record<string, unknown>);
}

describe("TerminalWebSocketClient", () => {
  test("owns one socket, multiplexes raw channels, and rebuilds desired subscriptions", async () => {
    const sockets: MockWebSocket[] = [];
    const fallback = mock(() => undefined);
    const socketReady = mock(() => undefined);
    const client = new TerminalWebSocketClient({
      url: "ws://gateway.test/__orkestrator/terminal",
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
      createSocket: (url, protocols) => {
        const socket = new MockWebSocket(url, protocols);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      onFallbackRequired: fallback,
      onSocketReady: socketReady,
    });
    const outputA = mock((_payload: unknown) => undefined);
    const outputB = mock((_payload: unknown) => undefined);
    const unsubscribeA = client.subscribe("session-a", outputA);
    const unsubscribeB = client.subscribe("session-b", outputB);
    expect(sockets).toHaveLength(1);

    const first = sockets[0]!;
    first.open();
    first.receive(JSON.stringify({ type: "ready", version: 1, socketId: "socket-one" }));
    const subscriptions = sentControls(first).filter((frame) => frame.type === "subscribe");
    expect(subscriptions.map((frame) => frame.sessionId).sort()).toEqual(["session-a", "session-b"]);
    const requestA = subscriptions.find((frame) => frame.sessionId === "session-a")!.requestId as number;
    const requestB = subscriptions.find((frame) => frame.sessionId === "session-b")!.requestId as number;
    first.receive(JSON.stringify({
      type: "subscribed", requestId: requestA, sessionId: "session-a", channelId: 11,
      baseGeneration: null, baseRevision: null, targetGeneration: 1, targetRevision: 0,
      recovery: "snapshot-required",
    }));
    first.receive(JSON.stringify({
      type: "subscribed", requestId: requestB, sessionId: "session-b", channelId: 22,
      baseGeneration: null, baseRevision: null, targetGeneration: 3, targetRevision: 0,
      recovery: "snapshot-required",
    }));
    await Promise.all([client.ready("session-a"), client.ready("session-b")]);
    client.observeSnapshot("session-a", { generation: 1, revision: 0 });
    client.observeSnapshot("session-b", { generation: 3, revision: 0 });

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
    await Promise.resolve();
    expect(new TextDecoder().decode((outputA.mock.calls.at(-1)?.[0] as { bytes: Uint8Array }).bytes)).toBe("alpha");
    expect(new TextDecoder().decode((outputB.mock.calls.at(-1)?.[0] as { bytes: Uint8Array }).bytes)).toBe("beta");

    expect(client.sendInput("session-a", "pwd\r")).toBe(true);
    const input = first.sent.find((value) => typeof value !== "string");
    expect(input).toBeDefined();
    expect(decodeTerminalBinaryFrame(input as Uint8Array)).toMatchObject({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 11,
      generation: 1,
      revision: 1,
    });
    expect(client.resize("session-b", 120, 40)).toBe(true);
    expect(sentControls(first)).toContainEqual({ type: "resize", channelId: 22, cols: 120, rows: 40 });

    first.close(1006, "network lost");
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.open();
    second.receive(JSON.stringify({ type: "ready", version: 1, socketId: "socket-two" }));
    expect(sentControls(second).filter((frame) => frame.type === "subscribe")).toEqual([
      { type: "subscribe", requestId: 3, sessionId: "session-a", knownGeneration: 1, knownRevision: 1 },
      { type: "subscribe", requestId: 4, sessionId: "session-b", knownGeneration: 3, knownRevision: 1 },
    ]);
    expect(socketReady).toHaveBeenCalledTimes(2);

    unsubscribeA();
    unsubscribeB();
    client.dispose();
  });
});

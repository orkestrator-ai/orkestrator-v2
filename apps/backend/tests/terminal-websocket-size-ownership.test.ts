/**
 * The terminal WebSocket's part in size ownership (`terminal-size-ownership.ts`):
 * it forwards the window's client id with each size update, and a socket that
 * closes gives up what its client owned after the backend's grace period.
 */
import { describe, expect, mock, test } from "bun:test";
import { TERMINAL_WEBSOCKET_SUBPROTOCOL } from "@orkestrator/protocol/terminal-websocket";
import type { WebSocket } from "ws";
import {
  nextTerminalControl,
  openTerminalSocket,
  startGateway,
  waitUntil,
  type WebSocketInbox,
} from "./gateway-test-harness.js";

type Call = { command: string; args: Record<string, unknown> };

function recordingBackend(options: { resizeGate?: Promise<void> } = {}) {
  const calls: Call[] = [];
  const backend = {
    invoke: mock(async (command: string, args: Record<string, unknown>) => {
      calls.push({ command, args });
      if (command === "get_terminal_session") return { id: args.sessionId, running: true };
      if (command === "get_terminal_output_snapshot") {
        return { output: "", generation: 1, revision: 0, truncated: false };
      }
      if (command === "terminal_resize") {
        await options.resizeGate;
        return { delivered: true, applied: true, owned: true };
      }
      if (command === "release_terminal_size") return { released: 1 };
      return undefined;
    }),
  };
  return { backend, calls };
}

async function subscribe(socket: WebSocket, inbox: WebSocketInbox, sessionId: string) {
  socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId }));
  const subscribed = await nextTerminalControl(inbox, "subscribed");
  if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
  await nextTerminalControl(inbox, "lifecycle");
  return subscribed.channelId;
}

function sendResize(
  socket: WebSocket,
  channelId: number,
  operationId: number,
  extra: Record<string, unknown> = {},
) {
  socket.send(
    JSON.stringify({ type: "resize", channelId, operationId, cols: 120, rows: 40, ...extra }),
  );
}

const options = { protocols: TERMINAL_WEBSOCKET_SUBPROTOCOL };

describe("terminal WebSocket size ownership", () => {
  test("forwards the client id with a size update, and omits a missing or malformed one", async () => {
    const { backend, calls } = recordingBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session");

    sendResize(socket, channel, 1, { clientId: "desktop-1" });
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({ ok: true });
    sendResize(socket, channel, 2);
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({ ok: true });
    // A malformed id is dropped; it must not close every terminal on the socket.
    sendResize(socket, channel, 3, { clientId: "has spaces" });
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({ ok: true });

    expect(calls.filter((call) => call.command === "terminal_resize").map((c) => c.args)).toEqual([
      { sessionId: "session", cols: 120, rows: 40, clientId: "desktop-1" },
      { sessionId: "session", cols: 120, rows: 40 },
      { sessionId: "session", cols: 120, rows: 40 },
    ]);
    socket.terminate();
  });

  test("a closed socket gives up its client's size ownership with a grace period", async () => {
    const { backend, calls } = recordingBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session");
    sendResize(socket, channel, 1, { clientId: "phone-1" });
    await nextTerminalControl(inbox, "operation-result");

    socket.terminate();
    await waitUntil(
      () => calls.some((call) => call.command === "release_terminal_size"),
      "The closed socket did not release its size ownership",
    );
    expect(calls.filter((call) => call.command === "release_terminal_size")).toEqual([
      { command: "release_terminal_size", args: { clientId: "phone-1", disconnected: true } },
    ]);
  });

  test("a socket that never sent a client id releases nothing", async () => {
    const { backend, calls } = recordingBackend();
    const { info } = await startGateway({ backend });
    const first = await openTerminalSocket(info, options);
    const channel = await subscribe(first.socket, first.inbox, "session");
    sendResize(first.socket, channel, 1);
    await nextTerminalControl(first.inbox, "operation-result");
    first.socket.terminate();

    // A later socket's full round trip shows the close has been handled.
    const second = await openTerminalSocket(info, options);
    await subscribe(second.socket, second.inbox, "session");
    expect(calls.some((call) => call.command === "release_terminal_size")).toBe(false);
    second.socket.terminate();
  });

  test("a client id another live socket still uses keeps its ownership", async () => {
    const { backend, calls } = recordingBackend();
    const { info } = await startGateway({ backend });
    const reconnected = await openTerminalSocket(info, options);
    const newChannel = await subscribe(reconnected.socket, reconnected.inbox, "session");
    sendResize(reconnected.socket, newChannel, 1, { clientId: "desktop-1" });
    await nextTerminalControl(reconnected.inbox, "operation-result");

    const stale = await openTerminalSocket(info, options);
    const staleChannel = await subscribe(stale.socket, stale.inbox, "session");
    sendResize(stale.socket, staleChannel, 1, { clientId: "desktop-1" });
    await nextTerminalControl(stale.inbox, "operation-result");
    stale.socket.terminate();

    const probe = await openTerminalSocket(info, options);
    await subscribe(probe.socket, probe.inbox, "session");
    expect(calls.some((call) => call.command === "release_terminal_size")).toBe(false);
    probe.socket.terminate();
    reconnected.socket.terminate();
    await waitUntil(
      () => calls.some((call) => call.command === "release_terminal_size"),
      "The last socket for the client did not release its size ownership",
    );
  });

  test("a resize still queued when the socket closes runs before the release", async () => {
    let openGate: () => void = () => undefined;
    const resizeGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const { backend, calls } = recordingBackend({ resizeGate });
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session");
    sendResize(socket, channel, 1, { clientId: "phone-1" });
    await waitUntil(
      () => calls.some((call) => call.command === "terminal_resize"),
      "The resize was not dispatched",
    );
    socket.terminate();
    // Nothing is released while the resize that would renew the lease is queued.
    const probe = await openTerminalSocket(info, options);
    await subscribe(probe.socket, probe.inbox, "other-session");
    expect(calls.some((call) => call.command === "release_terminal_size")).toBe(false);

    openGate();
    await waitUntil(
      () => calls.some((call) => call.command === "release_terminal_size"),
      "The release did not follow the queued resize",
    );
    const order = calls
      .map((call) => call.command)
      .filter((command) => command === "terminal_resize" || command === "release_terminal_size");
    expect(order).toEqual(["terminal_resize", "release_terminal_size"]);
    probe.socket.terminate();
  });
});

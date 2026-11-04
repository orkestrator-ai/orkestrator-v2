import { describe, expect, mock, test } from "bun:test";
import {
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS,
  TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
  type TerminalWebSocketServerControlFrame,
} from "@orkestrator/protocol/terminal-websocket";
import type { WebSocket } from "ws";

import { compatibilityPathUsage } from "../src/core/compatibility-path-usage";
import {
  nextTerminalControl,
  nextTurn,
  openTerminalSocket,
  settleTurns,
  stallSocket,
  startGateway,
  terminalServerSocket,
  waitUntil,
  type WebSocketInbox,
} from "./gateway-test-harness.js";

/**
 * Every write and resize waits on one gate, so a test can queue a whole sequence
 * and then let it complete within one event-loop turn: what one flush sees.
 */
function gatedBackend() {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const writes: string[] = [];
  const backend = {
    invoke: mock(async (command: string, args: Record<string, unknown>) => {
      if (command === "get_terminal_session") return { id: args.sessionId, running: true };
      if (command === "get_terminal_output_snapshot") {
        return { output: "", generation: 1, revision: 0, truncated: false };
      }
      if (command === "terminal_resize") {
        await gate;
        return undefined;
      }
      if (command === "terminal_write") {
        const data = String(args.data);
        writes.push(data);
        await gate;
        if (data === "refused") return { delivered: false };
        if (data === "thrown") throw new Error("write failed");
        return { delivered: true };
      }
      return undefined;
    }),
  };
  return { backend, writes, open: () => open() };
}

async function subscribe(socket: WebSocket, inbox: WebSocketInbox, sessionId: string, id: number) {
  socket.send(JSON.stringify({ type: "subscribe", requestId: id, sessionId }));
  const subscribed = await nextTerminalControl(inbox, "subscribed");
  if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
  await nextTerminalControl(inbox, "lifecycle");
  return subscribed.channelId;
}

function sendInput(socket: WebSocket, channelId: number, operationId: number, text: string) {
  socket.send(
    encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId,
      generation: 1,
      revision: operationId,
      bytes: new TextEncoder().encode(text),
    }),
  );
}

/** Answered once the server has handled everything sent before it. */
async function serverCaughtUp(socket: WebSocket, inbox: WebSocketInbox, nonce: number) {
  socket.send(JSON.stringify({ type: "ping", nonce }));
  await nextTerminalControl(inbox, "pong");
}

/** The result frames the peer receives, up to and including the one `done` accepts. */
async function readResults(
  inbox: WebSocketInbox,
  done: (frame: TerminalWebSocketServerControlFrame) => boolean,
) {
  const frames: TerminalWebSocketServerControlFrame[] = [];
  while (true) {
    const message = await inbox.next();
    if (message.binary) continue;
    const frame = parseTerminalWebSocketServerControlFrame(message.data.toString("utf8"));
    frames.push(frame);
    if (done(frame)) return frames;
  }
}

const inputResult = (channelId: number, throughOperationId: number) => ({
  type: "input-results",
  channelId,
  throughOperationId,
});

describe("terminal WebSocket cumulative input results", () => {
  const options = { protocols: TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS };

  test("input that completes together is answered by one frame, and runs in order", async () => {
    const { backend, writes, open } = gatedBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session", 1);

    const keys = Array.from({ length: 50 }, (_, index) => `key-${index + 1}`);
    keys.forEach((key, index) => sendInput(socket, channel, index + 1, key));
    await serverCaughtUp(socket, inbox, 1);
    open();

    const frames = await readResults(
      inbox,
      (frame) => frame.type === "input-results" && frame.throughOperationId === keys.length,
    );
    expect(frames).toEqual([inputResult(channel, keys.length)] as typeof frames);
    await waitUntil(() => writes.length === keys.length, "Writes did not all run");
    expect(writes).toEqual(keys);
    socket.terminate();
  });

  test.each([
    ["refused", "Terminal session is not running"],
    ["thrown", "Terminal operation failed"],
  ])("a %s write is answered alone, between the results around it", async (text, message) => {
    const { backend, writes, open } = gatedBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session", 1);

    const sent = ["a", "b", text, "c", "d"];
    sent.forEach((key, index) => sendInput(socket, channel, index + 1, key));
    await serverCaughtUp(socket, inbox, 1);
    open();

    const frames = await readResults(
      inbox,
      (frame) => frame.type === "input-results" && frame.throughOperationId === 5,
    );
    expect(frames).toEqual([
      inputResult(channel, 2),
      {
        type: "operation-result",
        channelId: channel,
        operationId: 3,
        operation: "input",
        ok: false,
        message,
      },
      inputResult(channel, 5),
    ] as typeof frames);
    await waitUntil(() => writes.length === sent.length, "Writes did not all run");
    expect(writes).toEqual(sent);
    socket.terminate();
  });

  test("a resize keeps its own answer and its place", async () => {
    const { backend, open } = gatedBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session", 1);

    sendInput(socket, channel, 1, "a");
    socket.send(
      JSON.stringify({ type: "resize", channelId: channel, operationId: 2, cols: 9, rows: 9 }),
    );
    sendInput(socket, channel, 3, "b");
    await serverCaughtUp(socket, inbox, 1);
    open();

    const frames = await readResults(
      inbox,
      (frame) => frame.type === "input-results" && frame.throughOperationId === 3,
    );
    expect(frames).toEqual([
      inputResult(channel, 1),
      {
        type: "operation-result",
        channelId: channel,
        operationId: 2,
        operation: "resize",
        ok: true,
      },
      inputResult(channel, 3),
    ] as typeof frames);
    socket.terminate();
  });

  test("each channel has its own result", async () => {
    const { backend, open } = gatedBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const first = await subscribe(socket, inbox, "first", 1);
    const second = await subscribe(socket, inbox, "second", 2);

    sendInput(socket, first, 1, "a");
    sendInput(socket, second, 2, "b");
    sendInput(socket, first, 3, "c");
    await serverCaughtUp(socket, inbox, 1);
    open();

    const seen = new Map<number, number>();
    await readResults(inbox, (frame) => {
      if (frame.type === "input-results") seen.set(frame.channelId, frame.throughOperationId);
      return seen.size === 2;
    });
    expect(seen).toEqual(
      new Map([
        [first, 3],
        [second, 2],
      ]),
    );
    socket.terminate();
  });

  test("a single keystroke is answered with nothing further to prompt it", async () => {
    const { backend, open } = gatedBackend();
    open();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session", 1);

    sendInput(socket, channel, 1, "a");
    expect(await nextTerminalControl(inbox, "input-results")).toEqual(
      inputResult(channel, 1) as TerminalWebSocketServerControlFrame,
    );
    socket.terminate();
  });

  test("a result does not wait behind paused output", async () => {
    const { backend, open } = gatedBackend();
    open();
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info, options);
    const channel = await subscribe(socket, inbox, "session", 1);
    const stall = stallSocket(terminalServerSocket(gateway));

    for (let revision = 1; revision <= 25; revision += 1) {
      gateway.emit("terminal-output-session", {
        text: "x".repeat(16 * 1024),
        generation: 1,
        revision,
      });
      await nextTurn();
    }
    await settleTurns();
    const sendsWhilePaused = stall.sends();

    sendInput(socket, channel, 1, "a");
    await waitUntil(
      () =>
        stall.held.some(
          (send) => typeof send.data === "string" && send.data.includes("input-results"),
        ),
      "The result waited behind paused output",
    );
    expect(stall.sends()).toBe(sendsWhilePaused + 1);
    await stall.drain();
    socket.terminate();
  });
});

describe("terminal WebSocket subprotocol negotiation", () => {
  const perInputCount = () =>
    compatibilityPathUsage.snapshot().paths["terminal-websocket.per-input-results"]?.count ?? 0;

  test("a client that offers both gets input results and takes no older path", async () => {
    const { info } = await startGateway();
    const before = perInputCount();
    const { socket } = await openTerminalSocket(info, {
      protocols: TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS,
    });
    expect(socket.protocol).toBe(TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL);
    expect(perInputCount()).toBe(before);
    socket.terminate();
  });

  test("the input-results subprotocol alone is accepted", async () => {
    const { info } = await startGateway();
    const { socket } = await openTerminalSocket(info, {
      protocols: TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL,
    });
    expect(socket.protocol).toBe(TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL);
    socket.terminate();
  });

  test("an older client that offers only v1 keeps one result per input, in order", async () => {
    const { backend, writes, open } = gatedBackend();
    const { info } = await startGateway({ backend });
    const before = perInputCount();
    const { socket, inbox } = await openTerminalSocket(info);
    expect(socket.protocol).toBe(TERMINAL_WEBSOCKET_SUBPROTOCOL);
    expect(perInputCount()).toBe(before + 1);
    const channel = await subscribe(socket, inbox, "session", 1);

    sendInput(socket, channel, 1, "a");
    sendInput(socket, channel, 2, "refused");
    sendInput(socket, channel, 3, "b");
    await serverCaughtUp(socket, inbox, 1);
    open();

    const frames = await readResults(
      inbox,
      (frame) => frame.type === "operation-result" && frame.operationId === 3,
    );
    expect(frames).toEqual([
      {
        type: "operation-result",
        channelId: channel,
        operationId: 1,
        operation: "input",
        ok: true,
      },
      {
        type: "operation-result",
        channelId: channel,
        operationId: 2,
        operation: "input",
        ok: false,
        message: "Terminal session is not running",
      },
      {
        type: "operation-result",
        channelId: channel,
        operationId: 3,
        operation: "input",
        ok: true,
      },
    ] as typeof frames);
    await waitUntil(() => writes.length === 3, "Writes did not all run");
    socket.terminate();
  });
});

describe("terminal WebSocket shared decoders", () => {
  function recordingBackend() {
    const writes: string[] = [];
    return {
      writes,
      backend: {
        invoke: mock(async (command: string, args: Record<string, unknown>) => {
          if (command === "get_terminal_session") return { id: args.sessionId, running: true };
          if (command === "get_terminal_output_snapshot") {
            return { output: "", generation: 1, revision: 0, truncated: false };
          }
          if (command === "terminal_write") writes.push(String(args.data));
          return { delivered: true };
        }),
      },
    };
  }

  function sendInputBytes(socket: WebSocket, channelId: number, id: number, bytes: Uint8Array) {
    socket.send(
      encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.input,
        channelId,
        generation: 1,
        revision: id,
        bytes,
      }),
    );
  }

  test("handling messages constructs no decoder", async () => {
    const { backend, writes } = recordingBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const channel = await subscribe(socket, inbox, "session", 1);

    const real = globalThis.TextDecoder;
    let constructed = 0;
    globalThis.TextDecoder = class extends real {
      constructor(...args: ConstructorParameters<typeof TextDecoder>) {
        super(...args);
        constructed += 1;
      }
    } as typeof TextDecoder;
    try {
      for (let id = 1; id <= 5; id += 1) sendInput(socket, channel, id, `key-${id}`);
      socket.send(JSON.stringify({ type: "ack", channelId: channel, generation: 1, revision: 0 }));
      await serverCaughtUp(socket, inbox, 1);
      await waitUntil(() => writes.length === 5, "Writes did not all run");
    } finally {
      globalThis.TextDecoder = real;
    }
    expect(constructed).toBe(0);
    socket.terminate();
  });

  test("a split UTF-8 sequence does not carry into the next input", async () => {
    const { backend, writes } = recordingBackend();
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const channel = await subscribe(socket, inbox, "session", 1);

    // The euro sign is E2 82 AC. A streaming decoder would hold back the first
    // frame's two bytes and join them to the second's; each frame decodes alone.
    sendInputBytes(socket, channel, 1, new Uint8Array([0x41, 0xe2, 0x82]));
    sendInputBytes(socket, channel, 2, new Uint8Array([0xac, 0x42]));
    sendInputBytes(socket, channel, 3, new TextEncoder().encode("€"));
    await waitUntil(() => writes.length === 3, "Writes did not all run");
    expect(writes).toEqual(["A�", "�B", "€"]);
    socket.terminate();
  });

  test("a control frame that fails to decode leaves other sockets working", async () => {
    const { backend } = recordingBackend();
    const { info } = await startGateway({ backend });
    const bad = await openTerminalSocket(info);
    const good = await openTerminalSocket(info);
    const closed = new Promise<void>((resolve) => bad.socket.once("close", () => resolve()));
    bad.socket.on("error", () => undefined);
    bad.socket.send(Buffer.from([0xc3, 0x28]), { binary: false });
    await closed;

    await subscribe(good.socket, good.inbox, "session", 1);
    await serverCaughtUp(good.socket, good.inbox, 1);
    good.socket.terminate();
  });
});

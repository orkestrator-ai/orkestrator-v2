import { describe, expect, mock, test } from "bun:test";
import {
  decodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
  type TerminalWebSocketServerControlFrame,
} from "@orkestrator/protocol/terminal-websocket";
import type { WebSocket } from "ws";

import type { OrkestratorGateway } from "../src/gateway";
import { TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES } from "../src/terminal-websocket-server";
import {
  nextTerminalControl,
  openTerminalSocket,
  readGatewayMetrics,
  startGateway,
  waitUntil,
  type WebSocketInbox,
} from "./gateway-test-harness.js";

const FRAME_TEXT_BYTES = 16 * 1024;
const FRAME_WIRE_BYTES = FRAME_TEXT_BYTES + 16;

const backend = {
  invoke: mock(async (command: string, args: Record<string, unknown>) => {
    if (command === "get_terminal_session") return { id: args.sessionId, running: true };
    if (command === "get_terminal_output_snapshot") {
      return { output: "", generation: 1, revision: 0, truncated: false };
    }
    return undefined;
  }),
};

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settleTurns(turns = 10) {
  for (let turn = 0; turn < turns; turn += 1) await nextTurn();
}

function serverSocket(gateway: OrkestratorGateway): WebSocket {
  const terminal = (
    gateway as unknown as { terminalWebSocket: { sockets: Set<{ ws: WebSocket }> } }
  ).terminalWebSocket;
  const state = [...terminal.sockets][0];
  if (!state) throw new Error("Expected terminal WebSocket state");
  return state.ws;
}

/**
 * Stands in for a peer that has stopped reading: every send stays in
 * `bufferedAmount` with its callback unfired until the test releases it, in the
 * order a socket would have. Measured against the real thing under Bun's `ws`
 * by the `terminal-flood` workload in `scripts/gateway-frame-costs.ts`.
 */
function stallSocket(ws: WebSocket) {
  type Send = (
    data: string | Uint8Array,
    options: { binary: boolean },
    callback: (error?: Error) => void,
  ) => void;
  const realSend = ws.send.bind(ws) as unknown as Send;
  const held: Array<{ data: string | Uint8Array; release: () => void; fail: () => void }> = [];
  let buffered = 0;
  let peakBuffered = 0;
  let sends = 0;
  Object.defineProperty(ws, "bufferedAmount", {
    configurable: true,
    get: () => buffered,
  });
  (ws as unknown as { send: Send }).send = (data, options, callback) => {
    const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
    sends += 1;
    buffered += bytes;
    peakBuffered = Math.max(peakBuffered, buffered);
    held.push({
      data,
      fail: () => {
        buffered -= bytes;
        callback(new Error("send failed"));
      },
      release: () => {
        buffered -= bytes;
        realSend(data, options, callback);
      },
    });
  };
  return {
    held,
    buffered: () => buffered,
    peakBuffered: () => peakBuffered,
    sends: () => sends,
    /** Lets the peer read everything held so far. New sends keep stalling. */
    releaseHeld: () => {
      for (const send of held.splice(0)) send.release();
    },
    /** Lets the peer read until the gateway has nothing left to send. */
    drain: async () => {
      for (let idleTurns = 0; idleTurns < 5;) {
        if (held.length === 0) {
          idleTurns += 1;
        } else {
          idleTurns = 0;
          for (const send of held.splice(0)) send.release();
        }
        await settleTurns(2);
      }
    },
  };
}

async function subscribe(socket: WebSocket, inbox: WebSocketInbox, sessionId: string, id: number) {
  socket.send(JSON.stringify({ type: "subscribe", requestId: id, sessionId }));
  const subscribed = await nextTerminalControl(inbox, "subscribed");
  if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
  // The `lifecycle` frame follows from the same flush; let it reach the socket
  // so a stall installed next starts from an empty backlog.
  await nextTerminalControl(inbox, "lifecycle");
  return subscribed.channelId;
}

/** Reads what the peer received until `done`, keeping output per channel in arrival order. */
function collectFrames(inbox: WebSocketInbox) {
  const output = new Map<number, Array<{ revision: number; text: string }>>();
  const control: TerminalWebSocketServerControlFrame[] = [];
  let stopped = false;
  void (async () => {
    while (!stopped) {
      const message = await inbox.next();
      if (message.binary) {
        const frame = decodeTerminalBinaryFrame(message.data);
        const frames = output.get(frame.channelId) ?? [];
        frames.push({
          revision: frame.revision,
          text: new TextDecoder().decode(frame.bytes),
        });
        output.set(frame.channelId, frames);
      } else {
        control.push(parseTerminalWebSocketServerControlFrame(message.data.toString("utf8")));
      }
    }
  })();
  return {
    output,
    control,
    stop: () => {
      stopped = true;
    },
  };
}

function frameText(revision: number): string {
  return `${String(revision).padStart(8, "0")}${"x".repeat(FRAME_TEXT_BYTES - 8)}`;
}

describe("terminal WebSocket back-pressure", () => {
  test("a flooding channel desyncs alone, with flushing paused at the watermark", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const noisy = await subscribe(socket, inbox, "noisy", 1);
    const quiet = await subscribe(socket, inbox, "quiet", 2);
    const received = collectFrames(inbox);
    const stall = stallSocket(serverSocket(gateway));

    // More than the socket soft limit, so without the watermark this flood alone
    // would put the socket over it and the quiet channel's next frame would desync.
    const noisyFrames = 160;
    expect(noisyFrames * FRAME_WIRE_BYTES).toBeGreaterThan(
      TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
    );
    let quietRevision = 0;
    for (let revision = 1; revision <= noisyFrames; revision += 1) {
      gateway.emit("terminal-output-noisy", { text: frameText(revision), generation: 1, revision });
      if (revision % 16 === 0) {
        quietRevision += 1;
        gateway.emit("terminal-output-quiet", {
          text: `quiet-${quietRevision}`,
          generation: 1,
          revision: quietRevision,
        });
      }
      await nextTurn();
    }
    await settleTurns();

    // The socket stopped taking output at the watermark, plus the one frame
    // that crossed it and the control frames, which ignore it.
    expect(stall.peakBuffered()).toBeGreaterThanOrEqual(
      TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES,
    );
    expect(stall.peakBuffered()).toBeLessThan(
      TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES + 2 * FRAME_WIRE_BYTES,
    );
    expect((await readGatewayMetrics(info)).terminalWebSocket.desyncs).toBe(1);

    await stall.drain();
    await waitUntil(
      () =>
        (received.output.get(quiet)?.length ?? 0) === quietRevision &&
        received.control.some((frame) => frame.type === "desync"),
      "The quiet channel's frames or the noisy desync never arrived",
    );
    const desyncs = received.control.filter((frame) => frame.type === "desync");
    expect(desyncs).toHaveLength(1);
    expect(desyncs[0]).toMatchObject({ channelId: noisy, reason: "slow-consumer" });
    expect(received.output.get(quiet)!.map((frame) => frame.text)).toEqual(
      Array.from({ length: quietRevision }, (_, index) => `quiet-${index + 1}`),
    );
    // What the noisy channel kept is a prefix: nothing lost before the desync.
    const noisyRevisions = received.output.get(noisy)!.map((frame) => frame.revision);
    expect(noisyRevisions).toEqual(noisyRevisions.map((_, index) => index + 1));
    expect((await readGatewayMetrics(info)).terminalWebSocket.desyncs).toBe(1);
    received.stop();
    socket.terminate();
  });

  test("a paused flush does no work and resumes from the send callback alone", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const channel = await subscribe(socket, inbox, "paused", 1);
    const received = collectFrames(inbox);
    const stall = stallSocket(serverSocket(gateway));

    for (let revision = 1; revision <= 25; revision += 1) {
      gateway.emit("terminal-output-paused", {
        text: frameText(revision),
        generation: 1,
        revision,
      });
      await nextTurn();
    }
    await settleTurns();
    const sendsWhilePaused = stall.sends();
    expect(sendsWhilePaused).toBeLessThan(25);

    await settleTurns(20);
    expect(stall.sends()).toBe(sendsWhilePaused);

    // No emit from here on: only the callbacks of the released sends can move
    // the rest of the backlog.
    stall.releaseHeld();
    await waitUntil(() => stall.sends() > sendsWhilePaused, "Flush did not resume");

    await stall.drain();
    await waitUntil(
      () => received.output.get(channel)?.length === 25,
      "Queued frames never arrived",
    );
    received.stop();
    socket.terminate();
  });

  test("a send callback error terminates a paused socket and releases its backlog", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    await subscribe(socket, inbox, "paused", 1);
    const ws = serverSocket(gateway);
    const stall = stallSocket(ws);
    for (let revision = 1; revision <= 25; revision++) {
      gateway.emit("terminal-output-paused", {
        text: frameText(revision),
        generation: 1,
        revision,
      });
      await nextTurn();
    }
    await settleTurns();
    const terminal = (
      gateway as unknown as {
        terminalWebSocket: {
          sockets: Set<{ flushPaused: boolean; inFlightSends: number; queuedBytes: number }>;
        };
      }
    ).terminalWebSocket;
    const state = terminal.sockets.values().next().value!;
    expect(state.flushPaused).toBe(true);
    for (const send of stall.held.splice(0)) send.fail();
    await waitUntil(() => terminal.sockets.size === 0, "Failed socket was not removed");
    expect(state.inFlightSends).toBe(0);
    expect(state.queuedBytes).toBe(0);
    socket.terminate();
  });

  test("a resumed flush delivers every queued frame on each channel, in order", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const first = await subscribe(socket, inbox, "first", 1);
    const second = await subscribe(socket, inbox, "second", 2);
    const received = collectFrames(inbox);
    const stall = stallSocket(serverSocket(gateway));

    // Enough to pause the flush with both channels holding a backlog, without
    // reaching either channel's soft limit.
    const framesPerChannel = 24;
    for (let revision = 1; revision <= framesPerChannel; revision += 1) {
      for (const session of ["first", "second"]) {
        gateway.emit(`terminal-output-${session}`, {
          text: `${session}:${frameText(revision)}`,
          generation: 1,
          revision,
        });
      }
      await nextTurn();
    }
    await settleTurns();
    const queuedBytes = (
      gateway as unknown as {
        terminalWebSocket: { sockets: Set<{ queuedBytes: number }> };
      }
    ).terminalWebSocket.sockets
      .values()
      .next().value!.queuedBytes;
    expect(queuedBytes).toBeGreaterThan(0);

    await stall.drain();
    await waitUntil(
      () =>
        received.output.get(first)?.length === framesPerChannel &&
        received.output.get(second)?.length === framesPerChannel,
      "Queued frames never arrived",
    );
    for (const [session, channel] of [
      ["first", first],
      ["second", second],
    ] as const) {
      expect(received.output.get(channel)).toEqual(
        Array.from({ length: framesPerChannel }, (_, index) => ({
          revision: index + 1,
          text: `${session}:${frameText(index + 1)}`,
        })),
      );
    }
    expect((await readGatewayMetrics(info)).terminalWebSocket.desyncs).toBe(0);
    received.stop();
    socket.terminate();
  });

  test("control frames keep moving while channel output is paused", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    await subscribe(socket, inbox, "paused", 1);
    const stall = stallSocket(serverSocket(gateway));

    for (let revision = 1; revision <= 25; revision += 1) {
      gateway.emit("terminal-output-paused", {
        text: frameText(revision),
        generation: 1,
        revision,
      });
      await nextTurn();
    }
    await settleTurns();
    const sendsWhilePaused = stall.sends();

    socket.send(JSON.stringify({ type: "ping", nonce: 4242 }));
    await waitUntil(
      () => stall.held.some((send) => typeof send.data === "string" && send.data.includes("4242")),
      "The pong waited behind paused output",
    );
    // The pong went out alone: the pass that sent it left the output queued.
    expect(stall.sends()).toBe(sendsWhilePaused + 1);

    await stall.drain();
    socket.terminate();
  });

  test("bytes in the socket that no send of ours accounts for cannot strand output", async () => {
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const channel = await subscribe(socket, inbox, "pinned", 1);
    const received = collectFrames(inbox);
    // Above the watermark for good, while the frames themselves really go out:
    // with nothing in flight no callback could ever wake a pause, so there must
    // not be one.
    Object.defineProperty(serverSocket(gateway), "bufferedAmount", {
      configurable: true,
      value: TERMINAL_WEBSOCKET_FLUSH_LOW_WATERMARK_BYTES,
    });

    for (let revision = 1; revision <= 3; revision += 1) {
      gateway.emit("terminal-output-pinned", { text: `line-${revision}`, generation: 1, revision });
    }
    await waitUntil(
      () => received.output.get(channel)?.length === 3,
      "Output stayed behind a socket with nothing in flight",
    );
    expect(received.output.get(channel)!.map((frame) => frame.text)).toEqual([
      "line-1",
      "line-2",
      "line-3",
    ]);
    received.stop();
    socket.terminate();
  });
});

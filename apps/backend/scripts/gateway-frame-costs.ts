import { configureLogger } from "@orkestrator/protocol/logger";
/**
 * Before-and-after workloads for the gateway frame costs in 1202 task 11
 * (GW-5, GW-6, GW-12, GW-14). Runs the real gateway in this process against a
 * fake backend:
 *
 *   mise exec -- bun apps/backend/scripts/gateway-frame-costs.ts \
 *     [--workloads terminal-flood,terminal-burst,fan-out,scoped-replay,replay-lookup] \
 *     [--runs 5] [--out result.json]
 *
 * Every run starts a fresh gateway on an ephemeral 127.0.0.1 port with a
 * temporary data directory and a random token that is never printed. It never
 * touches a real data directory, backend, terminal or provider.
 *
 * Workloads:
 *   terminal-flood  GW-6. One terminal WebSocket with two channels, whose peer
 *                   stops reading. A noisy channel emits 1,024 frames of 16 KiB
 *                   and a quiet one 32 frames of 1 KiB. The peer then resumes and
 *                   every frame it receives is tallied per channel.
 *   terminal-burst  GW-6's cost to a healthy client: the same emission, with a peer
 *                   that keeps reading throughout.
 *   fan-out         GW-5. 200 authoritative events of 64 KiB to 4 event streams;
 *                   counts the `Buffer.byteLength` calls inside `emit` that measure
 *                   a frame, as opposed to a metric label.
 *   scoped-replay   GW-12. A `?events=menu-` stream reconnects across 1,500
 *                   omitted events, one matching event and 500 more omitted ones.
 *   replay-lookup   GW-14. `since()` on a full 2,048-frame window.
 *
 * Measured figures are aggregates only, never content. JSON goes to stdout (or
 * `--out`).
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import {
  decodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
} from "@orkestrator/protocol/terminal-websocket";

import { OrkestratorGateway } from "../src/gateway.js";
import { GatewayEventReplay } from "../src/gateway-event-replay.js";

const NOISY_FRAMES = 1_024;
const NOISY_FRAME_BYTES = 16 * 1024;
const QUIET_FRAME_EVERY = 32;
const QUIET_FRAME_BYTES = 1024;
const FAN_OUT_EVENTS = 200;
const FAN_OUT_CLIENTS = 4;
const FAN_OUT_PAYLOAD = "café ".repeat(13_108);
const REPLAY_SKIPPED_BEFORE = 1_500;
const REPLAY_SKIPPED_AFTER = 500;
const LOOKUP_WINDOW_FRAMES = 2_048;
const LOOKUP_TAIL_FRAMES = 64;
const LOOKUP_TAIL_CALLS = 100_000;
const LOOKUP_FULL_CALLS = 10_000;

type GatewayInternals = {
  eventReplay: GatewayEventReplay;
  metrics: {
    snapshot(): { terminalWebSocket: { desyncs: number; peakQueuedBytes: number } };
  };
};

export type StartedGateway = {
  gateway: OrkestratorGateway;
  internals: GatewayInternals;
  url: URL;
  token: string;
  stop(): Promise<void>;
};

const terminalBackend = {
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "get_terminal_session") return { id: args.sessionId, running: true };
    if (command === "get_terminal_output_snapshot") {
      return { output: "", generation: 1, revision: 0 };
    }
    return null;
  },
};

export async function startGateway(
  backend: ConstructorParameters<typeof OrkestratorGateway>[0]["backend"] = terminalBackend,
  options: Partial<ConstructorParameters<typeof OrkestratorGateway>[0]> = {},
): Promise<StartedGateway> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-gateway-frame-costs-"));
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), '<div id="root"></div>');
  const token = randomBytes(24).toString("hex");
  const gateway = new OrkestratorGateway({
    backend,
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: token },
    allowNonTailscaleBind: true,
    legacyPreviewPortAccess: async () => "allowed" as const,
    ...options,
  });
  const info = await gateway.start();
  if (!info) throw new Error("Gateway did not start");
  return {
    gateway,
    internals: gateway as unknown as GatewayInternals,
    url: new URL(info.url),
    token,
    stop: async () => {
      await gateway.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Resolves once `progress` has not moved for `idleMs`. */
async function waitForIdle(progress: () => number, idleMs: number) {
  let last = progress();
  let lastMoved = Date.now();
  while (Date.now() - lastMoved < idleMs) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const current = progress();
    if (current !== last) {
      last = current;
      lastMoved = Date.now();
    }
  }
}

function sendMaskedText(socket: Socket, text: string) {
  const payload = Buffer.from(text, "utf8");
  if (payload.byteLength >= 126) throw new Error("Control frame too long for this helper");
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, masked]));
}

/** Unmasked server-to-client frames, from a socket this script reads by hand. */
class ServerFrameReader {
  private pending: Buffer = Buffer.alloc(0);
  bytes = 0;

  constructor(private readonly onFrame: (opcode: number, payload: Buffer) => void) {}

  push(chunk: Buffer) {
    this.bytes += chunk.byteLength;
    this.pending = this.pending.byteLength === 0 ? chunk : Buffer.concat([this.pending, chunk]);
    while (this.pending.byteLength >= 2) {
      const opcode = this.pending[0]! & 0x0f;
      const short = this.pending[1]! & 0x7f;
      const headerBytes = short === 127 ? 10 : short === 126 ? 4 : 2;
      if (this.pending.byteLength < headerBytes) return;
      const length =
        short === 127
          ? Number(this.pending.readBigUInt64BE(2))
          : short === 126
            ? this.pending.readUInt16BE(2)
            : short;
      if (this.pending.byteLength < headerBytes + length) return;
      this.onFrame(opcode, this.pending.subarray(headerBytes, headerBytes + length));
      this.pending = this.pending.subarray(headerBytes + length);
    }
  }
}

type ChannelTally = { frames: number; desyncs: number; inOrder: boolean; lastRevision: number };

export async function terminalFlood(options = { peerStalls: true }) {
  const { gateway, internals, url, token, stop } = await startGateway();
  const raw = netConnect({ host: url.hostname, port: Number(url.port) });
  try {
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    let upgraded = false;
    let closed = false;
    raw.once("close", () => {
      closed = true;
    });
    const sessionByChannel = new Map<number, string>();
    const tallies = new Map<string, ChannelTally>();
    const tally = (session: string) => {
      let entry = tallies.get(session);
      if (!entry) {
        entry = { frames: 0, desyncs: 0, inOrder: true, lastRevision: 0 };
        tallies.set(session, entry);
      }
      return entry;
    };
    const reader = new ServerFrameReader((opcode, payload) => {
      if (opcode === 1) {
        const frame = parseTerminalWebSocketServerControlFrame(payload.toString("utf8"));
        if (frame.type === "subscribed") sessionByChannel.set(frame.channelId, frame.sessionId);
        if (frame.type === "desync") tally(sessionByChannel.get(frame.channelId)!).desyncs += 1;
      } else if (opcode === 2) {
        const frame = decodeTerminalBinaryFrame(payload);
        const entry = tally(sessionByChannel.get(frame.channelId)!);
        entry.frames += 1;
        if (frame.revision !== entry.lastRevision + 1) entry.inOrder = false;
        entry.lastRevision = frame.revision;
      }
    });
    raw.on("data", (chunk: Buffer) => {
      if (upgraded) {
        reader.push(chunk);
        return;
      }
      const end = chunk.indexOf("\r\n\r\n");
      if (end < 0) throw new Error("Upgrade response split across chunks");
      upgraded = true;
      if (end + 4 < chunk.byteLength) reader.push(chunk.subarray(end + 4));
    });
    raw.write(
      `GET /__orkestrator/terminal HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Protocol: ${TERMINAL_WEBSOCKET_SUBPROTOCOL}\r\n` +
        `Origin: http://${url.host}\r\n` +
        `Authorization: Bearer ${token}\r\n\r\n`,
    );
    await waitUntil(() => upgraded, "Terminal socket never upgraded");
    sendMaskedText(raw, JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "noisy" }));
    sendMaskedText(raw, JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "quiet" }));
    await waitUntil(() => sessionByChannel.size === 2, "Terminal channels never subscribed");
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (options.peerStalls) raw.pause();
    const noisyText = "x".repeat(NOISY_FRAME_BYTES);
    const quietText = "q".repeat(QUIET_FRAME_BYTES);
    let quietRevision = 0;
    const floodStartedAt = performance.now();
    for (let revision = 1; revision <= NOISY_FRAMES; revision += 1) {
      gateway.emit("terminal-output-noisy", { text: noisyText, generation: 1, revision });
      if (revision % QUIET_FRAME_EVERY === 0) {
        quietRevision += 1;
        gateway.emit("terminal-output-quiet", {
          text: quietText,
          generation: 1,
          revision: quietRevision,
        });
      }
      await nextTurn();
    }
    if (options.peerStalls) await new Promise((resolve) => setTimeout(resolve, 100));
    const metricsAtStall = internals.metrics.snapshot().terminalWebSocket;

    if (options.peerStalls) raw.resume();
    else {
      await waitUntil(
        () => tally("noisy").frames + tally("noisy").desyncs * NOISY_FRAMES >= NOISY_FRAMES,
        "A reading peer never received the burst",
      );
    }
    const deliveredMs = Math.round(performance.now() - floodStartedAt);
    await waitForIdle(() => reader.bytes, 500);
    const noisy = tally("noisy");
    const quiet = tally("quiet");
    const result = {
      noisyDesyncs: noisy.desyncs,
      quietDesyncs: quiet.desyncs,
      noisyFramesDelivered: noisy.frames,
      noisyInOrder: noisy.inOrder,
      quietFramesEmitted: quietRevision,
      quietFramesDelivered: quiet.frames,
      quietInOrder: quiet.inOrder,
      peakQueuedBytes: metricsAtStall.peakQueuedBytes,
      socketClosed: closed,
      ...(options.peerStalls ? {} : { deliveredMs }),
    };
    return result;
  } finally {
    raw.destroy();
    await stop();
  }
}

type EventStream = {
  bytes(): number;
  text(): string;
  close(): void;
};

function openEventStream(
  started: StartedGateway,
  search: string,
  options: { keepText: boolean },
): EventStream {
  let bytes = 0;
  let text = "";
  const request = httpRequest(
    {
      hostname: started.url.hostname,
      port: started.url.port,
      path: `/__orkestrator/events${search}`,
      headers: { authorization: `Bearer ${started.token}` },
    },
    (response) => {
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (options.keepText) text += chunk.toString("utf8");
      });
    },
  );
  request.on("error", () => undefined);
  request.end();
  return { bytes: () => bytes, text: () => text, close: () => request.destroy() };
}

async function fanOut() {
  const started = await startGateway();
  const streams = Array.from({ length: FAN_OUT_CLIENTS }, () =>
    openEventStream(started, "", { keepText: false }),
  );
  await waitUntil(
    () => streams.every((stream) => stream.bytes() > 0),
    "Event streams never connected",
  );
  const payload = { text: FAN_OUT_PAYLOAD };
  const expectedFrameBytes = Buffer.byteLength(FAN_OUT_PAYLOAD);

  let frameMeasures = 0;
  const realByteLength = Buffer.byteLength;
  const countingByteLength = ((...args: Parameters<typeof Buffer.byteLength>) => {
    const bytes = realByteLength(...args);
    if (bytes >= expectedFrameBytes) frameMeasures += 1;
    return bytes;
  }) as typeof Buffer.byteLength;
  let emitMs = 0;
  for (let index = 0; index < FAN_OUT_EVENTS; index += 1) {
    const before = streams.map((stream) => stream.bytes());
    Buffer.byteLength = countingByteLength;
    const startedAt = performance.now();
    started.gateway.emit("environment-renamed", payload);
    emitMs += performance.now() - startedAt;
    Buffer.byteLength = realByteLength;
    await waitUntil(
      () =>
        streams.every(
          (stream, position) => stream.bytes() - before[position]! >= expectedFrameBytes,
        ),
      "A fan-out frame was never delivered",
    );
  }
  for (const stream of streams) stream.close();
  await started.stop();
  return {
    frameMeasuresPerEmit: frameMeasures / FAN_OUT_EVENTS,
    emitMicrosecondsPerEvent: Math.round((emitMs / FAN_OUT_EVENTS) * 1000),
  };
}

function frameIds(text: string): string[] {
  return text.split("\n\n").flatMap((frame) => {
    const id = /^id: (.+)$/m.exec(frame)?.[1];
    return id ? [id] : [];
  });
}

async function scopedReplay() {
  const started = await startGateway();
  const first = openEventStream(started, "?events=menu-", { keepText: true });
  await waitUntil(() => first.text().includes("gateway.connected"), "Scoped stream never opened");
  const cursor = frameIds(first.text())[0];
  if (!cursor) throw new Error("Scoped stream carried no cursor");
  first.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  for (let index = 0; index < REPLAY_SKIPPED_BEFORE; index += 1) {
    started.gateway.emit("environment-renamed", { index });
  }
  started.gateway.emit("menu-zoom", "in");
  for (let index = 0; index < REPLAY_SKIPPED_AFTER; index += 1) {
    started.gateway.emit("environment-renamed", { index });
  }
  const latestCursor = started.internals.eventReplay.latestCursor;

  const resumed = openEventStream(started, `?events=menu-&since=${encodeURIComponent(cursor)}`, {
    keepText: true,
  });
  await waitUntil(() => resumed.text().includes("menu-zoom"), "Scoped replay never matched");
  await waitForIdle(() => resumed.bytes(), 200);
  const text = resumed.text();
  const result = {
    skippedEvents: REPLAY_SKIPPED_BEFORE + REPLAY_SKIPPED_AFTER,
    cursorFrames: text.split('"event":"gateway.cursor"').length - 1,
    matchingFrames: text.split('"event":"menu-zoom"').length - 1,
    streamBytes: resumed.bytes(),
    endsAtLatestCursor: frameIds(text).at(-1) === latestCursor,
  };
  resumed.close();
  await started.stop();
  return result;
}

function timeCalls(calls: number, call: () => unknown): number {
  const startedAt = performance.now();
  for (let index = 0; index < calls; index += 1) call();
  return Math.round(((performance.now() - startedAt) / calls) * 1_000_000);
}

function replayLookup() {
  const replay = new GatewayEventReplay("frame-costs", {
    frameCapacity: LOOKUP_WINDOW_FRAMES,
    maxBytes: Number.MAX_SAFE_INTEGER,
    idleRetentionMs: 60_000,
  });
  for (let index = 0; index < LOOKUP_WINDOW_FRAMES; index += 1) {
    replay.append("environment-renamed", { index });
  }
  const tailCursor = replay.latestRevision - LOOKUP_TAIL_FRAMES;
  const fullCursor = replay.oldestRevision - 1;
  const result = {
    tailFrames: replay.since(tailCursor).frames.length,
    tailNanosecondsPerCall: timeCalls(LOOKUP_TAIL_CALLS, () => replay.since(tailCursor)),
    fullFrames: replay.since(fullCursor).frames.length,
    fullNanosecondsPerCall: timeCalls(LOOKUP_FULL_CALLS, () => replay.since(fullCursor)),
  };
  replay.releaseRetained();
  return result;
}

const WORKLOADS: Record<string, () => unknown> = {
  "terminal-flood": terminalFlood,
  "terminal-burst": () => terminalFlood({ peerStalls: false }),
  "fan-out": fanOut,
  "scoped-replay": scopedReplay,
  "replay-lookup": replayLookup,
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  configureLogger({ level: "error" });
  const selected = argument("workloads")?.split(",") ?? Object.keys(WORKLOADS);
  const runs = Number(argument("runs") ?? 5);
  const results: Record<string, unknown[]> = {};
  for (const name of selected) {
    const workload = WORKLOADS[name];
    if (!workload) throw new Error(`Unknown workload: ${name}`);
    const workloadResults: unknown[] = [];
    results[name] = workloadResults;
    for (let run = 0; run < runs; run += 1) workloadResults.push(await workload());
  }
  const output = `${JSON.stringify(results, null, 2)}\n`;
  const out = argument("out");
  if (out) await writeFile(out, output);
  else process.stdout.write(output);
  process.exit(0);
}

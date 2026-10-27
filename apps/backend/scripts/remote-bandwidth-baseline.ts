/**
 * Remote client bandwidth baseline (todo 0052; plans/stream-efficience.md,
 * Phase 2). Runs the real gateway in this process against a fake backend and
 * synthetic workloads, and measures what remote clients would receive:
 *
 *   mise exec -- bun apps/backend/scripts/remote-bandwidth-baseline.ts \
 *     [--transports body,on,websocket] [--workloads quiet,interactive,build,...] \
 *     [--sessions 1,4] [--clients 3] [--no-slow-client] [--duration-ms 6000] \
 *     [--idle-ms 2000] [--keepalive-ms 5000] [--rate-kbps 0] [--latency-ms 0] \
 *     [--seed 1] [--out result.json]
 *
 * Every case starts a fresh gateway on an ephemeral 127.0.0.1 port with a
 * temporary data directory and a random token that is never printed. It never
 * touches a real data directory, backend, terminal or provider.
 *
 * Transports, per client (as the browser connects):
 *   body       main SSE stream + one shared terminal SSE stream, compression `body`
 *   on         the same two streams, compression `on` (streaming gzip)
 *   websocket  main SSE stream (`body`) + the terminal WebSocket, no message
 *              compression; output ACKs coalesced for 50 ms like the browser
 *
 * Every client but the slow one reads normally. The slow client opens the same
 * streams and never reads them, so the gateway's slow-consumer limits decide
 * what happens to it. `--rate-kbps`/`--latency-ms` put each client behind its
 * own userspace forwarder that caps server-to-client throughput and delays
 * both directions; this is a constrained link, not the Tailscale Serve route.
 *
 * Measured per case (aggregates only, never content): client wire bytes
 * (TCP bytes read, headers included) and per minute; the gateway's source
 * (serialised) and encoded SSE bytes and WebSocket payload and framed bytes;
 * p50/p95 first-update latency (emit to arrival, every frame, healthy
 * clients); completion latency (last emit to the last healthy client holding
 * it); process CPU (gateway and clients share this process) and retained heap
 * after a forced GC; streaming compressor peak, declines and failures; stream
 * drops and desyncs; WebSocket desyncs, peak queue and ACK frames per output
 * frame. JSON goes to stdout (or `--out`), a Markdown table to stderr.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { constants as zlibConstants, createGunzip } from "node:zlib";

import {
  decodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
} from "@orkestrator/protocol/terminal-websocket";

import { OrkestratorGateway } from "../src/gateway.js";
import { startThrottle, type Throttle } from "./remote-bandwidth-throttle.js";
import {
  TERMINAL_WEBSOCKET_MAX_CHANNELS_PER_SOCKET,
  TERMINAL_WEBSOCKET_MAX_CHANNELS,
  TERMINAL_WEBSOCKET_MAX_SOCKETS,
} from "../src/terminal-websocket-server.js";

export const BASELINE_SCHEMA = "orkestrator.remote-bandwidth-baseline.v1";
export const TRANSPORTS = ["body", "on", "websocket"] as const;
export type Transport = (typeof TRANSPORTS)[number];

const ACK_DELAY_MS = 50;
const TERMINAL_PREFIX = "terminal-output-";
const AGENT_EVENT = "native-agent-session-activity";

// ---------------------------------------------------------------------------
// Workloads: synthetic content only, from a seeded generator.

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const PRINTABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_.:;!?";

export interface Workload {
  id: string;
  description: string;
  /** Terminal output tick per session; absent means no terminal output. */
  terminalIntervalMs?: number;
  terminalChunk?: (random: () => number, index: number) => string;
  agentIntervalMs?: number;
  agentPayload?: (random: () => number, index: number) => Record<string, unknown>;
}

const buildLine = (random: () => number, index: number) =>
  `[${String(index).padStart(5, " ")}/99999] Compiling packages/module-${Math.floor(
    random() * 40,
  )}/src/component-${Math.floor(random() * 200)}.ts ... ok (${Math.floor(random() * 90)} ms)\r\n`;

const agentPayload = (random: () => number, index: number) => ({
  environment_id: "baseline-environment",
  logical_session_key: "env-baseline:tab-1",
  agent: "claude",
  state: index % 7 === 0 ? "waiting" : "working",
  previous_state: "working",
  generation: "baseline-observer",
  revision: index,
  summary: Array.from({ length: 6 }, () => buildLine(random, index)).join(""),
});

export const WORKLOADS: readonly Workload[] = [
  { id: "quiet", description: "No output; keepalives only" },
  {
    id: "interactive",
    description: "1-80 B bursts every 150 ms per terminal",
    terminalIntervalMs: 150,
    terminalChunk: (random) => {
      const length = 1 + Math.floor(random() * 80);
      return Array.from({ length }, () => PRINTABLE[Math.floor(random() * 26)]).join("");
    },
  },
  {
    id: "build",
    description: "~2 KB of redundant build log every 20 ms per terminal",
    terminalIntervalMs: 20,
    terminalChunk: (random, index) =>
      Array.from({ length: 22 }, (_, line) => buildLine(random, index * 22 + line)).join(""),
  },
  {
    id: "incompressible",
    description: "2 KB of random printable text every 20 ms per terminal",
    terminalIntervalMs: 20,
    terminalChunk: (random) =>
      Array.from({ length: 2048 }, () => PRINTABLE[Math.floor(random() * PRINTABLE.length)]).join(
        "",
      ),
  },
  {
    id: "agent",
    description: "~600 B agent event every 100 ms, no terminal output",
    agentIntervalMs: 100,
    agentPayload,
  },
  {
    id: "agent-build",
    description: "Agent events plus build output",
    agentIntervalMs: 100,
    agentPayload,
    terminalIntervalMs: 20,
    terminalChunk: (random, index) =>
      Array.from({ length: 22 }, (_, line) => buildLine(random, index * 22 + line)).join(""),
  },
];

// ---------------------------------------------------------------------------
// Options

export interface BaselineOptions {
  transports: Transport[];
  workloads: Workload[];
  sessions: number[];
  clients: number;
  slowClient: boolean;
  durationMs: number;
  idleMs: number;
  keepaliveMs: number;
  rateKbps: number;
  latencyMs: number;
  seed: number;
  out: string | null;
}

export class UsageError extends Error {}

function positiveInteger(name: string, value: string | undefined, allowZero = false): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new UsageError(`${name} needs ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

export function parseOptions(argv: readonly string[]): BaselineOptions {
  const options: BaselineOptions = {
    transports: [...TRANSPORTS],
    workloads: [...WORKLOADS],
    sessions: [1],
    clients: 3,
    slowClient: true,
    durationMs: 6_000,
    idleMs: 2_000,
    keepaliveMs: 5_000,
    rateKbps: 0,
    latencyMs: 0,
    seed: 1,
    out: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new UsageError(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--transports": {
        const names = value().split(",");
        for (const name of names) {
          if (!TRANSPORTS.includes(name as Transport)) {
            throw new UsageError(`Unknown transport ${name}`);
          }
        }
        options.transports = names as Transport[];
        break;
      }
      case "--workloads": {
        options.workloads = value()
          .split(",")
          .map((name) => {
            const workload = WORKLOADS.find((candidate) => candidate.id === name);
            if (!workload) throw new UsageError(`Unknown workload ${name}`);
            return workload;
          });
        break;
      }
      case "--sessions":
        options.sessions = value()
          .split(",")
          .map((entry) => positiveInteger("--sessions", entry));
        break;
      case "--clients":
        options.clients = positiveInteger(flag, value());
        break;
      case "--no-slow-client":
        options.slowClient = false;
        break;
      case "--duration-ms":
        options.durationMs = positiveInteger(flag, value());
        break;
      case "--idle-ms":
        options.idleMs = positiveInteger(flag, value(), true);
        break;
      case "--keepalive-ms":
        options.keepaliveMs = positiveInteger(flag, value());
        break;
      case "--rate-kbps":
        options.rateKbps = positiveInteger(flag, value(), true);
        break;
      case "--latency-ms":
        options.latencyMs = positiveInteger(flag, value(), true);
        break;
      case "--seed":
        options.seed = positiveInteger(flag, value());
        break;
      case "--out":
        options.out = value();
        break;
      default:
        throw new UsageError(`Unknown option ${flag}`);
    }
  }
  if (options.transports.includes("websocket")) {
    for (const sessions of options.sessions) validateSocketCapacity(sessions, options);
  }
  return options;
}

function validateSocketCapacity(sessions: number, options: BaselineOptions): void {
  const clients = options.clients + Number(options.slowClient);
  if (sessions > TERMINAL_WEBSOCKET_MAX_CHANNELS_PER_SOCKET) {
    throw new UsageError(
      `WebSocket sessions exceed the per-socket limit of ${TERMINAL_WEBSOCKET_MAX_CHANNELS_PER_SOCKET}`,
    );
  }
  if (
    clients > TERMINAL_WEBSOCKET_MAX_SOCKETS ||
    clients * sessions > TERMINAL_WEBSOCKET_MAX_CHANNELS
  ) {
    throw new UsageError("WebSocket clients/sessions exceed gateway aggregate capacity");
  }
}

// ---------------------------------------------------------------------------
// Clients

interface Arrival {
  key: string;
  at: number;
}

interface ClientConnection {
  wireBytes(): number;
  close(): void;
}

function openSse(
  port: number,
  token: string,
  search: string,
  slow: boolean,
  onFrame: (event: string, payload: unknown, at: number) => void,
): Promise<ClientConnection> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/__orkestrator/events${search}`,
        headers: { authorization: `Bearer ${token}`, "accept-encoding": "gzip" },
      },
      (response: IncomingMessage) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(new Error(`SSE startup failed: HTTP ${response.statusCode}`));
          return;
        }
        request.setTimeout(0);
        const socket = response.socket;
        const connection: ClientConnection = {
          wireBytes: () => socket.bytesRead,
          close: () => response.destroy(),
        };
        if (slow) {
          response.pause();
          socket.pause();
          resolve(connection);
          return;
        }
        const source =
          response.headers["content-encoding"] === "gzip"
            ? response.pipe(createGunzip({ finishFlush: zlibConstants.Z_SYNC_FLUSH }))
            : response;
        let pending = "";
        source.on("data", (chunk: Buffer) => {
          const at = performance.now();
          pending += chunk.toString("utf8");
          let boundary = pending.indexOf("\n\n");
          while (boundary !== -1) {
            const block = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            for (const line of block.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const frame = JSON.parse(line.slice(6)) as { event: string; payload: unknown };
                onFrame(frame.event, frame.payload, at);
              } catch {
                // Not a JSON frame; nothing to time.
              }
            }
            boundary = pending.indexOf("\n\n");
          }
        });
        source.on("error", () => undefined);
        resolve(connection);
      },
    );
    request.setTimeout(10_000, () => request.destroy(new Error("SSE startup timed out")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * A minimal RFC 6455 client over a raw socket, so the wire bytes are exact and
 * the slow client can really stop reading. Server frames are unfragmented
 * (the terminal gateway sends whole messages); client frames are masked.
 */
export function rawWebSocket(
  port: number,
  onMessage: (data: Buffer, binary: boolean) => void,
  onFailure: (error: Error) => void = () => undefined,
  timeoutMs = 10_000,
): Promise<{ socket: Socket; send: (text: string) => void }> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket = netConnect(port, "127.0.0.1");
    let upgraded = false;
    let failed = false;
    const fail = (error: Error) => {
      if (failed) return;
      failed = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
      onFailure(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Terminal WebSocket upgrade timed out")),
      timeoutMs,
    );
    socket.on("error", fail);
    socket.once("close", () => fail(new Error("Terminal WebSocket closed")));
    const send = (text: string) => {
      const payload = Buffer.from(text, "utf8");
      const mask = randomBytes(4);
      const header =
        payload.byteLength < 126
          ? Buffer.from([0x81, 0x80 | payload.byteLength])
          : Buffer.from([0x81, 0x80 | 126, payload.byteLength >> 8, payload.byteLength & 0xff]);
      const masked = Buffer.alloc(payload.byteLength);
      for (let index = 0; index < payload.byteLength; index += 1) {
        masked[index] = payload[index]! ^ mask[index % 4]!;
      }
      socket.write(Buffer.concat([header, mask, masked]));
    };
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > 4 * 1024 * 1024) {
        fail(new Error("Terminal WebSocket frame exceeds baseline parser limit"));
        return;
      }
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const accept = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        if (!head.startsWith("HTTP/1.1 101") || !head.includes(accept)) {
          fail(new Error("Terminal WebSocket upgrade was refused"));
          return;
        }
        clearTimeout(timer);
        upgraded = true;
        resolve({ socket, send });
      }
      for (;;) {
        if (buffer.byteLength < 2) return;
        const opcode = buffer[0]! & 0x0f;
        if (
          (buffer[0]! & 0xf0) !== 0x80 ||
          (buffer[1]! & 0x80) !== 0 ||
          ![1, 2, 8, 9, 10].includes(opcode)
        ) {
          fail(new Error("Unsupported terminal WebSocket frame"));
          return;
        }
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.byteLength < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.byteLength < 10) return;
          length = Number(buffer.readBigUInt64BE(2));
          offset = 10;
        }
        if (length > 4 * 1024 * 1024) {
          fail(new Error("Terminal WebSocket frame exceeds baseline parser limit"));
          return;
        }
        if (buffer.byteLength < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        try {
          if (opcode === 1 || opcode === 2) onMessage(Buffer.from(payload), opcode === 2);
          else if (opcode === 8) {
            fail(new Error("Terminal WebSocket closed by server"));
            return;
          }
        } catch (error) {
          fail(error instanceof Error ? error : new Error("Invalid terminal WebSocket message"));
          return;
        }
      }
    });
    socket.write(
      [
        "GET /__orkestrator/terminal HTTP/1.1",
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Protocol: ${TERMINAL_WEBSOCKET_SUBPROTOCOL}`,
        "",
        "",
      ].join("\r\n"),
    );
  });
}

export async function openTerminalSocket(
  port: number,
  token: string,
  sessionIds: readonly string[],
  slow: boolean,
  onOutput: (sessionId: string, revision: number, at: number) => void,
  timeoutMs = 10_000,
): Promise<ClientConnection> {
  const channels = new Map<number, { sessionId: string; generation: number; revision: number }>();
  let ackTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAcks = new Set<number>();
  let send: (text: string) => void = () => undefined;
  const flushAcks = () => {
    ackTimer = null;
    for (const channelId of pendingAcks) {
      const channel = channels.get(channelId);
      if (!channel) continue;
      send(
        JSON.stringify({
          type: "ack",
          channelId,
          generation: channel.generation,
          revision: channel.revision,
        }),
      );
    }
    pendingAcks.clear();
  };
  let resolveReady: () => void = () => undefined;
  let rejectReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // The handshake may fail before we await readiness below.
  void ready.catch(() => undefined);
  const requested = new Set(sessionIds);
  const subscribed = new Set<string>();
  const connection = await rawWebSocket(
    port,
    (data, binary) => {
      const at = performance.now();
      if (binary) {
        const frame = decodeTerminalBinaryFrame(data);
        if (frame.type !== TERMINAL_BINARY_FRAME_TYPE.output) return;
        const channel = channels.get(frame.channelId);
        if (!channel) return;
        channel.generation = frame.generation;
        channel.revision = Math.max(channel.revision, frame.revision);
        onOutput(channel.sessionId, frame.revision, at);
        pendingAcks.add(frame.channelId);
        ackTimer ??= setTimeout(flushAcks, ACK_DELAY_MS);
        return;
      }
      const control = parseTerminalWebSocketServerControlFrame(data.toString("utf8"));
      if (control.type === "ready") {
        sessionIds.forEach((sessionId, requestId) =>
          send(JSON.stringify({ type: "subscribe", requestId: requestId + 1, sessionId })),
        );
      } else if (control.type === "subscribed") {
        channels.set(control.channelId, {
          sessionId: control.sessionId,
          generation: control.targetGeneration,
          revision: control.targetRevision,
        });
        if (!requested.has(control.sessionId)) {
          rejectReady(new Error("Unexpected terminal subscription"));
          return;
        }
        subscribed.add(control.sessionId);
        if (subscribed.size === requested.size) resolveReady();
      } else if (control.type === "error") {
        rejectReady(new Error(`Terminal WebSocket startup failed: ${control.code}`));
      }
    },
    (error) => {
      if (ackTimer) clearTimeout(ackTimer);
      rejectReady(error);
    },
    timeoutMs,
  );
  send = connection.send;
  connection.socket.on("error", () => undefined);
  send(JSON.stringify({ type: "authenticate", version: 1, token }));
  const startupTimer = setTimeout(
    () => rejectReady(new Error("Terminal WebSocket subscriptions timed out")),
    timeoutMs,
  );
  try {
    if (requested.size === 0) resolveReady();
    await ready;
  } catch (error) {
    if (ackTimer) clearTimeout(ackTimer);
    connection.socket.destroy();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  if (slow) connection.socket.pause();
  return {
    wireBytes: () => connection.socket.bytesRead,
    close: () => {
      if (ackTimer) clearTimeout(ackTimer);
      connection.socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// One case

export function aggregateArrivals(
  emittedAt: ReadonlyMap<string, number>,
  arrivals: readonly (readonly Arrival[])[],
  finalKeys: readonly string[],
  lastEmitAt: number,
): { firstUpdate: number[]; missing: number; completion: number | null } {
  const firstUpdate: number[] = [];
  let missing = 0;
  let complete = finalKeys.length > 0 && arrivals.length > 0;
  let completion = 0;
  for (const record of arrivals) {
    const seen = new Map<string, number>();
    for (const arrival of record) if (!seen.has(arrival.key)) seen.set(arrival.key, arrival.at);
    for (const [key, emitted] of emittedAt) {
      const at = seen.get(key);
      if (at === undefined) missing += 1;
      else firstUpdate.push(at - emitted);
    }
    for (const key of finalKeys) {
      const at = seen.get(key);
      if (at === undefined) complete = false;
      else completion = Math.max(completion, at - lastEmitAt);
    }
  }
  return { firstUpdate, missing, completion: complete ? completion : null };
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
}

const round = (value: number | null, digits = 1) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

export interface CaseResult {
  transport: Transport;
  workload: string;
  sessions: number;
  healthyClients: number;
  slowClient: boolean;
  durationMs: number;
  link: { rateKbps: number; latencyMs: number };
  wire: {
    healthyBytesPerClient: number;
    healthyBytesPerClientPerMinute: number;
    slowClientBytes: number | null;
  };
  gateway: {
    sseSourceBytes: number;
    sseEncodedBytes: number;
    websocketOutputPayloadBytes: number;
    websocketFramedSentBytes: number;
  };
  latencyMs: {
    firstUpdateP50: number | null;
    firstUpdateP95: number | null;
    completion: number | null;
  };
  framesTimed: number;
  framesMissing: number;
  cpuMs: number;
  retainedHeapDeltaBytes: number;
  compression: { peakActive: number; started: number; declined: number; failures: number };
  stream: { dropped: number; softDesyncs: number; stalled: number; keepalives: number };
  websocket: {
    desyncs: number;
    peakQueuedBytes: number;
    outputFrames: number;
    acknowledgementFrames: number;
    acksPerOutputFrame: number | null;
  };
}

type MetricsSnapshot = {
  stream: {
    dropped: number;
    stalled: number;
    softDesyncs: number;
    keepalives: number;
    sourceBytes: number;
    encodedBodyBytes: number;
  };
  compression: {
    streamingPeakActive: number;
    streamingStarted: number;
    streamingDeclined: number;
    streamingFailures: number;
  };
  terminalWebSocket: {
    desyncs: number;
    peakQueuedBytes: number;
    outputFrames: number;
    outputPayloadBytes: number;
    acknowledgementFrames: number;
    framedSentBytes: number;
  };
};

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runCase(
  options: BaselineOptions,
  transport: Transport,
  workload: Workload,
  sessions: number,
): Promise<CaseResult> {
  if (transport === "websocket") validateSocketCapacity(sessions, options);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-bandwidth-"));
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot, { recursive: true });
  await writeFile(path.join(rendererRoot, "index.html"), '<div id="root"></div>');
  const token = randomBytes(24).toString("hex");
  const sessionIds = Array.from({ length: sessions }, (_, index) => `baseline-${index + 1}`);
  const gateway = new OrkestratorGateway({
    backend: {
      invoke: async (command: string) => {
        if (command === "get_terminal_session") return { running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0, truncated: false };
        }
        return null;
      },
    },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: token },
    logger: silentLogger,
    allowNonTailscaleBind: true,
    compression: transport === "on" ? "on" : "body",
    keepaliveMs: options.keepaliveMs,
  });
  const throttles: Throttle[] = [];
  const connections: ClientConnection[] = [];
  const healthy: ClientConnection[] = [];
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let slowConnections: ClientConnection[] = [];
  try {
    const info = await gateway.start();
    if (!info) throw new Error("Gateway did not start");
    const gatewayPort = Number(new URL(info.url).port);
    const clientPort = async () => {
      if (options.rateKbps === 0 && options.latencyMs === 0) return gatewayPort;
      const throttle = await startThrottle(gatewayPort, options.rateKbps, options.latencyMs);
      throttles.push(throttle);
      return throttle.port;
    };

    const emittedAt = new Map<string, number>();
    const arrivals: Arrival[][] = [];
    const openClient = async (slow: boolean) => {
      const record: Arrival[] = [];
      const note = (key: string, at: number) => record.push({ key, at });
      const own: ClientConnection[] = [];
      const remember = (connection: ClientConnection) => {
        own.push(connection);
        connections.push(connection);
      };
      remember(
        await openSse(
          await clientPort(),
          token,
          `?excludeEvents=${TERMINAL_PREFIX}`,
          slow,
          (event, payload, at) => {
            if (event !== AGENT_EVENT) return;
            note(`agent:${(payload as { revision: number }).revision}`, at);
          },
        ),
      );
      if (transport === "websocket") {
        remember(
          await openTerminalSocket(
            await clientPort(),
            token,
            sessionIds,
            slow,
            (sessionId, revision, at) => note(`${sessionId}:${revision}`, at),
          ),
        );
      } else {
        const include = sessionIds.map((id) => `${TERMINAL_PREFIX}${id}`).join(",");
        remember(
          await openSse(
            await clientPort(),
            token,
            `?excludeEvents=${TERMINAL_PREFIX}&includeEvents=${encodeURIComponent(include)}`,
            slow,
            (event, payload, at) => {
              if (!event.startsWith(TERMINAL_PREFIX)) return;
              const sessionId = event.slice(TERMINAL_PREFIX.length);
              note(`${sessionId}:${(payload as { revision: number }).revision}`, at);
            },
          ),
        );
      }
      if (!slow) arrivals.push(record);
      return own;
    };
    for (let index = 0; index < options.clients; index += 1) {
      healthy.push(...(await openClient(false)));
    }
    if (options.slowClient) slowConnections = await openClient(true);
    await sleep(200);

    const before = (
      gateway as unknown as { metrics: { snapshot(): MetricsSnapshot } }
    ).metrics.snapshot();
    const healthyBefore = healthy.map((connection) => connection.wireBytes());
    const slowBefore = slowConnections.map((connection) => connection.wireBytes());
    Bun.gc(true);
    const heapBefore = process.memoryUsage().heapUsed;
    const cpuBefore = process.cpuUsage();

    const random = seededRandom(options.seed);
    const revisions = new Map(sessionIds.map((id) => [id, 0]));
    let agentRevision = 0;
    let lastEmitAt = 0;
    const finalKeys = new Map<string, string>();
    const started = performance.now();
    if (workload.terminalIntervalMs && workload.terminalChunk) {
      let tick = 0;
      timers.push(
        setInterval(() => {
          tick += 1;
          for (const sessionId of sessionIds) {
            const revision = revisions.get(sessionId)! + 1;
            revisions.set(sessionId, revision);
            const key = `${sessionId}:${revision}`;
            lastEmitAt = performance.now();
            emittedAt.set(key, lastEmitAt);
            finalKeys.set(sessionId, key);
            gateway.emit(`${TERMINAL_PREFIX}${sessionId}`, {
              text: workload.terminalChunk!(random, tick),
              revision,
              generation: 1,
            });
          }
        }, workload.terminalIntervalMs),
      );
    }
    if (workload.agentIntervalMs && workload.agentPayload) {
      timers.push(
        setInterval(() => {
          agentRevision += 1;
          const key = `agent:${agentRevision}`;
          lastEmitAt = performance.now();
          emittedAt.set(key, lastEmitAt);
          finalKeys.set("agent", key);
          gateway.emit(AGENT_EVENT, workload.agentPayload!(random, agentRevision));
        }, workload.agentIntervalMs),
      );
    }
    await sleep(options.durationMs);
    for (const timer of timers) clearInterval(timer);
    // The idle tail lets queued output drain and keepalives tick.
    await sleep(options.idleMs);
    const elapsedMs = performance.now() - started;

    const cpu = process.cpuUsage(cpuBefore);
    Bun.gc(true);
    const heapAfter = process.memoryUsage().heapUsed;
    const after = (
      gateway as unknown as { metrics: { snapshot(): MetricsSnapshot } }
    ).metrics.snapshot();

    const { firstUpdate, missing, completion } = aggregateArrivals(
      emittedAt,
      arrivals,
      [...finalKeys.values()],
      lastEmitAt,
    );
    const healthyBytes =
      healthy.reduce(
        (sum, connection, index) => sum + connection.wireBytes() - healthyBefore[index]!,
        0,
      ) / options.clients;
    const slowBytes = options.slowClient
      ? slowConnections.reduce(
          (sum, connection, index) => sum + connection.wireBytes() - slowBefore[index]!,
          0,
        )
      : null;
    const outputFrames =
      after.terminalWebSocket.outputFrames - before.terminalWebSocket.outputFrames;
    const ackFrames =
      after.terminalWebSocket.acknowledgementFrames -
      before.terminalWebSocket.acknowledgementFrames;
    return {
      transport,
      workload: workload.id,
      sessions,
      healthyClients: options.clients,
      slowClient: options.slowClient,
      durationMs: Math.round(elapsedMs),
      link: { rateKbps: options.rateKbps, latencyMs: options.latencyMs },
      wire: {
        healthyBytesPerClient: Math.round(healthyBytes),
        healthyBytesPerClientPerMinute: Math.round((healthyBytes * 60_000) / elapsedMs),
        slowClientBytes: slowBytes,
      },
      gateway: {
        sseSourceBytes: after.stream.sourceBytes - before.stream.sourceBytes,
        sseEncodedBytes: after.stream.encodedBodyBytes - before.stream.encodedBodyBytes,
        websocketOutputPayloadBytes:
          after.terminalWebSocket.outputPayloadBytes - before.terminalWebSocket.outputPayloadBytes,
        websocketFramedSentBytes:
          after.terminalWebSocket.framedSentBytes - before.terminalWebSocket.framedSentBytes,
      },
      latencyMs: {
        firstUpdateP50: round(percentile(firstUpdate, 0.5)),
        firstUpdateP95: round(percentile(firstUpdate, 0.95)),
        completion: round(completion),
      },
      framesTimed: firstUpdate.length,
      framesMissing: missing,
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      retainedHeapDeltaBytes: heapAfter - heapBefore,
      compression: {
        peakActive: after.compression.streamingPeakActive,
        started: after.compression.streamingStarted - before.compression.streamingStarted,
        declined: after.compression.streamingDeclined,
        failures: after.compression.streamingFailures,
      },
      stream: {
        dropped: after.stream.dropped - before.stream.dropped,
        softDesyncs: after.stream.softDesyncs - before.stream.softDesyncs,
        stalled: after.stream.stalled - before.stream.stalled,
        keepalives: after.stream.keepalives - before.stream.keepalives,
      },
      websocket: {
        desyncs: after.terminalWebSocket.desyncs - before.terminalWebSocket.desyncs,
        peakQueuedBytes: after.terminalWebSocket.peakQueuedBytes,
        outputFrames,
        acknowledgementFrames: ackFrames,
        acksPerOutputFrame: outputFrames > 0 ? round(ackFrames / outputFrames, 3) : null,
      },
    };
  } finally {
    for (const timer of timers) clearInterval(timer);
    for (const connection of connections) connection.close();
    await gateway.stop().catch(() => undefined);
    for (const throttle of throttles) await throttle.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Report

export function markdownTable(results: readonly CaseResult[]): string {
  const kb = (bytes: number | null) => (bytes === null ? "—" : (bytes / 1024).toFixed(1));
  const lines = [
    "| Workload | Sessions | Transport | KiB/min per client | Gateway source KiB | Encoded/framed KiB | p50 / p95 ms | Completion ms | Missing | CPU ms | Compressors peak / declined | Drops / desyncs | ACK per output |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const result of results) {
    const source = result.gateway.sseSourceBytes + result.gateway.websocketOutputPayloadBytes;
    const encoded = result.gateway.sseEncodedBytes + result.gateway.websocketFramedSentBytes;
    lines.push(
      `| ${result.workload} | ${result.sessions} | ${result.transport} | ${kb(
        result.wire.healthyBytesPerClientPerMinute,
      )} | ${kb(source)} | ${kb(encoded)} | ${result.latencyMs.firstUpdateP50 ?? "—"} / ${
        result.latencyMs.firstUpdateP95 ?? "—"
      } | ${result.latencyMs.completion ?? "—"} | ${result.framesMissing} | ${result.cpuMs} | ${
        result.compression.peakActive
      } / ${result.compression.declined} | ${result.stream.dropped + result.stream.softDesyncs} / ${
        result.websocket.desyncs
      } | ${result.websocket.acksPerOutputFrame ?? "—"} |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const results: CaseResult[] = [];
  for (const workload of options.workloads) {
    for (const sessions of workload.terminalIntervalMs ? options.sessions : [1]) {
      for (const transport of options.transports) {
        results.push(await runCase(options, transport, workload, sessions));
        process.stderr.write(".");
      }
    }
  }
  process.stderr.write("\n");
  const report = {
    schema: BASELINE_SCHEMA,
    date: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    bun: Bun.version,
    options: {
      ...options,
      workloads: options.workloads.map((workload) => workload.id),
    },
    results,
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await writeFile(options.out, json);
  else process.stdout.write(json);
  process.stderr.write(`${markdownTable(results)}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  });
}

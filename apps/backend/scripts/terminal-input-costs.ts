import { configureLogger } from "@orkestrator/protocol/logger";
/**
 * Before-and-after workloads for GW-16 (1202 task 11). Runs the real gateway and
 * the renderer's real terminal client in this process against a fake backend:
 *
 *   mise exec -- bun apps/backend/scripts/terminal-input-costs.ts \
 *     [--workloads typing,burst,burst-slow-write,output,proxy-chunks] \
 *     [--runs 5] [--out result.json]
 *
 * Every run starts a fresh gateway on an ephemeral 127.0.0.1 port with a
 * temporary data directory and a random token that is never printed. It never
 * touches a real data directory, backend, terminal or provider.
 *
 * Workloads:
 *   typing            200 keystrokes, one every 15 ms, each echoed as terminal
 *                     output: result frames, ack frames, decoders and the time from
 *                     sending a keystroke to its result.
 *   burst             200 keystrokes sent in one turn (key repeat, or a backlog
 *                     released by a slow link), with writes that complete at once.
 *   burst-slow-write  The same burst with a write that takes 1 ms, so results finish
 *                     in different event-loop turns.
 *   output            One channel receiving 100 frames a second for 5 seconds.
 *   proxy-chunks      A 64-chunk body through each idle deadline: the buffered proxy,
 *                     the browser-preview rewrite and the preview forwarder. Counts
 *                     the timers created with that deadline.
 *
 * Measured figures are aggregates only, never content. JSON goes to stdout (or
 * `--out`).
 */
import { writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import {
  DEFAULT_PREVIEW_FORWARD_LIMITS,
  forwardPreviewRequest,
} from "@orkestrator/protocol/node/preview-forward";

import { TerminalWebSocketClient } from "../../web/src/lib/native/terminal-websocket-client.ts";
import { startGateway, type StartedGateway } from "./gateway-frame-costs.js";

export const SESSION = "input-costs";
const TYPING_KEYS = 200;
const TYPING_INTERVAL_MS = 15;
const BURST_KEYS = 200;
const OUTPUT_FRAMES = 500;
const OUTPUT_INTERVAL_MS = 10;
const PROXY_CHUNKS = 64;
const PROXY_CHUNK_BYTES = 1024;
const PROXY_BODY_BYTES = PROXY_CHUNKS * PROXY_CHUNK_BYTES;
/** An idle deadline no other timer in the process uses, so it can be counted. */
const PROXY_IDLE_MS = 61_237;

type TerminalMetrics = {
  acknowledgementFrames: number;
  acknowledgementPayloadBytes: number;
  sentFrames: number;
  sentPayloadBytes: number;
};

type WireTally = {
  resultFrames: number;
  resultBytes: number;
  failures: number;
};

export type TerminalClientFixture = {
  started: StartedGateway;
  client: TerminalWebSocketClient;
  /** Control frames the client received, by type. */
  wire: WireTally;
  /** Every `terminal_write` the backend ran, in order. */
  writes: string[];
  /** The subprotocol the server selected. */
  protocol: () => string;
  metrics: () => TerminalMetrics;
  stop: () => Promise<void>;
};

/** `terminal_write`'s answer for one write; a throw rejects it. */
export type WriteBehaviour = (data: string, index: number) => unknown | Promise<unknown>;

/**
 * The renderer's client, against a real gateway. The client only asks `document`
 * for visibility changes, which never happen here.
 */
export async function startTerminalClient(
  options: {
    write?: WriteBehaviour;
    echo?: boolean;
    sessions?: string[];
    /** Overrides what the client offers: v1 alone is what an older renderer sends. */
    protocols?: string[];
  } = {},
): Promise<TerminalClientFixture> {
  const sessions = options.sessions ?? [SESSION];
  const writes: string[] = [];
  let echoRevision = 0;
  let started: StartedGateway | undefined;
  started = await startGateway({
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command === "get_terminal_session") return { id: args.sessionId, running: true };
      if (command === "get_terminal_output_snapshot") {
        return { output: "", generation: 1, revision: 0 };
      }
      if (command === "terminal_write") {
        const data = String(args.data);
        const index = writes.length;
        writes.push(data);
        const result = await options.write?.(data, index);
        if (options.echo) {
          echoRevision += 1;
          started?.gateway.emit(`terminal-output-${args.sessionId}`, {
            text: data,
            generation: 1,
            revision: echoRevision,
          });
        }
        return result ?? { delivered: true };
      }
      return { delivered: true };
    },
  });
  const installedDocument = !("document" in globalThis);
  if (installedDocument) {
    Object.assign(globalThis, {
      document: {
        visibilityState: "visible",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  }
  const wire: WireTally = { resultFrames: 0, resultBytes: 0, failures: 0 };
  let socketProtocol = "";
  const readyChannels = new Set<string>();
  let onChannelReady = () => {};
  const client = new TerminalWebSocketClient({
    url: `${started.url.origin.replace(/^http/, "ws")}/__orkestrator/terminal`,
    token: started.token,
    createSocket: (url, protocols) => {
      const socket = new WebSocket(url, options.protocols ?? protocols);
      socket.addEventListener("open", () => {
        socketProtocol = socket.protocol;
      });
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        const frame = JSON.parse(message.data) as {
          type?: string;
          ok?: boolean;
          operation?: string;
        };
        const isInputResult =
          frame.type === "input-results" ||
          (frame.type === "operation-result" && frame.operation === "input");
        if (!isInputResult) return;
        wire.resultFrames += 1;
        wire.resultBytes += Buffer.byteLength(message.data);
        if (frame.ok === false) wire.failures += 1;
      });
      return socket;
    },
    onFallbackRequired: () => undefined,
    onSocketReady: () => undefined,
    onChannelReady: (sessionId) => {
      readyChannels.add(sessionId);
      onChannelReady();
    },
  });
  for (const session of sessions) {
    client.subscribe(session, () => undefined);
  }
  for (const session of sessions) {
    await client.ready(session);
    // A first subscription has nothing to resume from, so the channel waits for
    // the snapshot the terminal fetches. Nothing has been output yet.
    client.observeSnapshot(session, { generation: 1, revision: 0 });
  }
  await new Promise<void>((resolve) => {
    onChannelReady = () => {
      if (readyChannels.size === sessions.length) resolve();
    };
    onChannelReady();
  });
  const internals = started.internals as unknown as {
    metrics: { snapshot(): { terminalWebSocket: TerminalMetrics } };
  };
  const running = started;
  return {
    started: running,
    client,
    wire,
    writes,
    protocol: () => socketProtocol,
    metrics: () => internals.metrics.snapshot().terminalWebSocket,
    stop: async () => {
      client.dispose();
      await running.stop();
      if (installedDocument) Reflect.deleteProperty(globalThis, "document");
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Counts TextDecoder constructions for as long as it is installed. */
export function countTextDecoders() {
  const real = globalThis.TextDecoder;
  let constructed = 0;
  globalThis.TextDecoder = class extends real {
    constructor(...args: ConstructorParameters<typeof TextDecoder>) {
      super(...args);
      constructed += 1;
    }
  } as typeof TextDecoder;
  return {
    constructed: () => constructed,
    restore: () => {
      globalThis.TextDecoder = real;
    },
  };
}

async function typing() {
  const fixture = await startTerminalClient({ echo: true });
  const decoders = countTextDecoders();
  try {
    const latencies: number[] = [];
    const settledOrder: number[] = [];
    const pending: Promise<void>[] = [];
    for (let key = 0; key < TYPING_KEYS; key += 1) {
      const sentAt = performance.now();
      const completion = fixture.client.enqueueInput(SESSION, `k${key}`);
      if (!completion) throw new Error("The channel refused a keystroke");
      pending.push(
        completion.then(() => {
          latencies.push(performance.now() - sentAt);
          settledOrder.push(key);
        }),
      );
      await sleep(TYPING_INTERVAL_MS);
    }
    await Promise.all(pending);
    // Lets a coalesced acknowledgement that is due go out before it is counted.
    await sleep(1_100);
    const metrics = fixture.metrics();
    return {
      keystrokes: TYPING_KEYS,
      protocol: fixture.protocol(),
      resultFrames: fixture.wire.resultFrames,
      resultBytes: fixture.wire.resultBytes,
      acknowledgementFrames: metrics.acknowledgementFrames,
      decodersConstructed: decoders.constructed(),
      latencyP50Ms: round(percentile(latencies, 0.5)),
      latencyP95Ms: round(percentile(latencies, 0.95)),
      latencyMaxMs: round(Math.max(...latencies)),
      settledInOrder: settledOrder.every((key, index) => key === index),
      writesInOrder: fixture.writes.every((data, index) => data === `k${index}`),
      writes: fixture.writes.length,
    };
  } finally {
    decoders.restore();
    await fixture.stop();
  }
}

async function burst(write?: WriteBehaviour) {
  const fixture = await startTerminalClient({ write });
  const decoders = countTextDecoders();
  try {
    const settledOrder: number[] = [];
    const startedAt = performance.now();
    const pending: Promise<void>[] = [];
    for (let key = 0; key < BURST_KEYS; key += 1) {
      const completion = fixture.client.enqueueInput(SESSION, `k${key}`);
      if (!completion) throw new Error("The channel refused a keystroke");
      pending.push(completion.then(() => void settledOrder.push(key)));
    }
    await Promise.all(pending);
    const allSettledMs = performance.now() - startedAt;
    return {
      keystrokes: BURST_KEYS,
      protocol: fixture.protocol(),
      resultFrames: fixture.wire.resultFrames,
      resultBytes: fixture.wire.resultBytes,
      decodersConstructed: decoders.constructed(),
      allSettledMs: round(allSettledMs),
      settledInOrder: settledOrder.every((key, index) => key === index),
      writesInOrder: fixture.writes.every((data, index) => data === `k${index}`),
      writes: fixture.writes.length,
    };
  } finally {
    decoders.restore();
    await fixture.stop();
  }
}

async function output() {
  const fixture = await startTerminalClient();
  try {
    const startedAt = performance.now();
    for (let revision = 1; revision <= OUTPUT_FRAMES; revision += 1) {
      fixture.started.gateway.emit(`terminal-output-${SESSION}`, {
        text: "line of terminal output\r\n",
        generation: 1,
        revision,
      });
      await sleep(OUTPUT_INTERVAL_MS);
    }
    const seconds = (performance.now() - startedAt) / 1000;
    const metrics = fixture.metrics();
    return {
      outputFrames: OUTPUT_FRAMES,
      seconds: round(seconds),
      acknowledgementFrames: metrics.acknowledgementFrames,
      acknowledgementsPerSecond: round(metrics.acknowledgementFrames / seconds),
      acknowledgementPayloadBytes: metrics.acknowledgementPayloadBytes,
    };
  } finally {
    await fixture.stop();
  }
}

/** Counts the timers created with the workload's idle deadline. */
function countIdleTimers() {
  const realSet = globalThis.setTimeout;
  let created = 0;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === PROXY_IDLE_MS) created += 1;
    return (realSet as (...parameters: unknown[]) => unknown)(handler, delay, ...args);
  }) as typeof setTimeout;
  return {
    created: () => created,
    restore: () => {
      globalThis.setTimeout = realSet;
    },
  };
}

/** Writes the body in separate chunks, each with a pause so it arrives as its own read. */
async function chunkedUpstream(contentType: string): Promise<Server> {
  const chunk = "x".repeat(PROXY_CHUNK_BYTES);
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": contentType, "content-length": PROXY_BODY_BYTES });
    for (let index = 0; index < PROXY_CHUNKS; index += 1) {
      response.write(chunk);
      await sleep(2);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

const portOf = (server: Server) => (server.address() as AddressInfo).port;

function fetchBody(url: URL, headers: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve(response.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body);
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function proxyChunks() {
  const results: Record<string, { timersCreated: number; bytes: number }> = {};
  const gatewayUpstream = await chunkedUpstream("text/plain; charset=utf-8");
  const previewUpstream = await chunkedUpstream("text/html; charset=utf-8");
  const started = await startGateway(undefined, {
    compression: "body",
    proxyBodyIdleTimeoutMs: PROXY_IDLE_MS,
  });
  const headers = { authorization: `Bearer ${started.token}`, "accept-encoding": "gzip" };
  const measure = async (name: string, run: () => Promise<Buffer>) => {
    const timers = countIdleTimers();
    try {
      const body = await run();
      results[name] = { timersCreated: timers.created(), bytes: body.byteLength };
    } finally {
      timers.restore();
    }
  };
  await measure("bufferedProxy", () =>
    fetchBody(
      new URL(`/__orkestrator/proxy/loopback/${portOf(gatewayUpstream)}/`, started.url),
      headers,
    ),
  );
  await measure("previewRewrite", () =>
    fetchBody(
      new URL(`/__orkestrator/browser/loopback/${portOf(previewUpstream)}/`, started.url),
      headers,
    ),
  );
  const upstreamPort = portOf(gatewayUpstream);
  const forwarder = createServer((request, response) => {
    void forwardPreviewRequest(
      request,
      response,
      {
        privateAuthority: `localhost:${upstreamPort}`,
        privateOrigins: [`http://localhost:${upstreamPort}`],
        publicOrigin: "http://preview.invalid",
        stripRequestHeaders: [],
      },
      { ...DEFAULT_PREVIEW_FORWARD_LIMITS, bodyIdleTimeoutMs: PROXY_IDLE_MS },
      {
        connect: async () => {
          const socket = connect(upstreamPort, "127.0.0.1");
          await new Promise((resolve) => socket.once("connect", resolve));
          return socket;
        },
      },
    );
  });
  await new Promise<void>((resolve) => forwarder.listen(0, "127.0.0.1", resolve));
  await measure("previewForward", () =>
    fetchBody(new URL(`http://127.0.0.1:${portOf(forwarder)}/`), {}),
  );
  await closeServer(forwarder);
  await closeServer(gatewayUpstream);
  await closeServer(previewUpstream);
  await started.stop();
  return { chunks: PROXY_CHUNKS, sites: results };
}

const WORKLOADS: Record<string, () => unknown> = {
  typing,
  burst: () => burst(),
  "burst-slow-write": () => burst(() => sleep(1)),
  output,
  "proxy-chunks": proxyChunks,
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
  const out = argument("out");
  const text = `${JSON.stringify(results, null, 2)}\n`;
  if (out) await writeFile(out, text);
  else process.stdout.write(text);
  process.exit(0);
}

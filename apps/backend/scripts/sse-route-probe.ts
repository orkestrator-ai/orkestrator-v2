/**
 * Does a route hold or re-encode gzip SSE? (todo 0052, task 1.) Sends a slow,
 * steady synthetic stream from a real gateway and reports what reaches the far
 * end of the route, so the same command can compare Tailscale Serve with the
 * direct tailnet listener:
 *
 *   mise exec -- bun apps/backend/scripts/sse-route-probe.ts serve \
 *     [--bind 127.0.0.1] [--port 0] [--compression on] [--keepalive-ms 25000]
 *
 *   mise exec -- bun apps/backend/scripts/sse-route-probe.ts measure \
 *     --url <origin> --token-file <path> [--label serve] [--http2] \
 *     [--accept-encoding "gzip, deflate, br, zstd" | none] [--frames 30] \
 *     [--interval-ms 1000] [--idle-ms 60000] [--reconnect-after 0] [--out result.json]
 *
 * `serve` starts the gateway on a temporary data directory with a fake backend
 * and a random token. It prints the URL and the path of a mode-0600 token file,
 * never the token, and never touches a real data directory, backend, terminal
 * or provider. It refuses the production ports. `measure` asks it for `--frames`
 * ticks, then an idle gap, then one last tick, and exits 1 unless the route
 * delivered every tick unheld.
 *
 * Needs no clock alignment: delay is relative to the fastest tick of the run, so
 * the two clocks' offset cancels. A tick counts as held when it arrives later
 * than half an interval (at least `HELD_FLOOR_MS`) behind that fastest tick.
 *
 * Re-encoding shows as a difference between the bytes this client read and the
 * bytes the gateway says it encoded, or as a different `Content-Encoding`. Output
 * holds aggregates and synthetic ids only.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { connect as http2Connect } from "node:http2";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { createGunzip } from "node:zlib";

import { OrkestratorGateway } from "../src/gateway.js";
import type { GatewayCompressionMode } from "../src/gateway-support-core.js";

export const PROBE_SCHEMA = "orkestrator.sse-route-probe.v1";
export const PROBE_EVENT = "sse-route-probe-tick";
const PROBE_START_COMMAND = "sse_route_probe_start";
export const HELD_FLOOR_MS = 50;
/** What Chromium sends, so a run measures the path a browser takes. */
export const BROWSER_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const RESERVED_PORTS = new Set([34121, 34122]);
/** Lets the last bytes reach the client before the two byte counts are compared. */
const BYTE_COUNT_SETTLE_MS = 250;

// ---------------------------------------------------------------------------
// A client that keeps the undecoded body, because the wire bytes are the point.

export type SseProbeStream = {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** Everything read off the socket, undecoded. */
  raw(): Buffer;
  /** The decoded body so far. */
  text(): string;
  /** The decoder's complaint, such as a body that ended without its gzip trailer. */
  decodeError(): Error | null;
  /** The peer finished the body normally. */
  ended(): boolean;
  /** The connection went away before the body finished. */
  aborted(): boolean;
  onDecoded(listener: () => void): void;
  close(): void;
};

export type SseProbeOptions = {
  headers?: Record<string, string>;
  http2?: boolean;
  headerTimeoutMs?: number;
  signal?: AbortSignal;
};

/** Resolves once the response headers arrive, without waiting for a first frame. */
export function openSseProbeStream(
  url: string,
  options: SseProbeOptions = {},
): Promise<SseProbeStream> {
  const target = new URL(url);
  const chunks: Buffer[] = [];
  const listeners: Array<() => void> = [];
  let decoded = "";
  let decodeError: Error | null = null;
  let ended = false;
  let aborted = false;
  let closed = false;

  return new Promise((resolve, reject) => {
    let close = () => {};
    const fail = (error: Error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      close();
      reject(error);
    };
    const abort = () => fail(new Error("SSE request cancelled"));
    const timer = setTimeout(
      () => fail(new Error("Timed out waiting for SSE response headers")),
      options.headerTimeoutMs ?? 10_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    const onResponse = (
      status: number,
      headers: IncomingHttpHeaders,
      body: NodeJS.ReadableStream,
    ) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const decoder = headers["content-encoding"] === "gzip" ? createGunzip() : null;
      const decodedChunk = (chunk: Buffer) => {
        decoded += chunk.toString("utf8");
        for (const listener of listeners) listener();
      };
      decoder?.on("data", decodedChunk);
      decoder?.on("error", (error) => {
        if (!closed && !aborted) decodeError = error;
      });
      body.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        if (decoder) decoder.write(chunk);
        else decodedChunk(chunk);
      });
      body.on("end", () => {
        ended = true;
        decoder?.end();
      });
      const lost = () => {
        if (!ended) aborted = true;
      };
      body.on("close", lost);
      body.on("error", lost);
      resolve({
        status,
        headers,
        raw: () => Buffer.concat(chunks),
        text: () => decoded,
        decodeError: () => decodeError,
        ended: () => ended,
        aborted: () => aborted,
        onDecoded: (listener) => listeners.push(listener),
        close: () => {
          closed = true;
          close();
          decoder?.destroy();
        },
      });
    };

    if (options.http2) {
      const session = http2Connect(target.origin);
      session.on("error", (error) => {
        aborted = true;
        fail(error);
      });
      const stream = session.request({
        ":method": "GET",
        ":path": `${target.pathname}${target.search}`,
        ...options.headers,
      });
      close = () => {
        stream.destroy();
        session.destroy();
      };
      stream.on("error", (error) => {
        aborted = true;
        fail(error);
      });
      stream.on("response", (headers) =>
        onResponse(Number(headers[":status"]), headers as IncomingHttpHeaders, stream),
      );
      if (options.signal?.aborted) abort();
      stream.end();
      return;
    }

    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        headers: options.headers,
      },
      (response) => {
        response.on("aborted", () => {
          aborted = true;
        });
        onResponse(response.statusCode ?? 0, response.headers, response);
      },
    );
    close = () => request.destroy();
    request.on("error", (error) => {
      aborted = true;
      fail(error);
    });
    if (options.signal?.aborted) abort();
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Analysis.

export type TickArrival = {
  seq: number;
  sentAtMs: number;
  arrivedAtMs: number;
};

export type ArrivalAnalysis = {
  ticks: number;
  missing: number;
  duplicates: number;
  outOfOrder: number;
  delayP50Ms: number;
  delayP95Ms: number;
  delayMaxMs: number;
  heldThresholdMs: number;
  heldTicks: number;
};

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, rank)] ?? 0;
}

const roundMs = (value: number) => Math.round(value * 10) / 10;

export function analyzeArrivals(
  arrivals: readonly TickArrival[],
  expectedTicks: number,
  intervalMs: number,
): ArrivalAnalysis {
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  let previousSeq = -1;
  for (const { seq } of arrivals) {
    if (seen.has(seq)) duplicates += 1;
    seen.add(seq);
    if (seq < previousSeq) outOfOrder += 1;
    previousSeq = Math.max(previousSeq, seq);
  }
  // The two clocks' offset is in every sample, so the fastest tick cancels it.
  const transit = arrivals.map(({ sentAtMs, arrivedAtMs }) => arrivedAtMs - sentAtMs);
  const fastest = transit.length > 0 ? Math.min(...transit) : 0;
  const delays = transit.map((value) => value - fastest).sort((a, b) => a - b);
  const heldThresholdMs = Math.max(intervalMs / 2, HELD_FLOOR_MS);
  return {
    ticks: seen.size,
    missing: Math.max(0, expectedTicks - seen.size),
    duplicates,
    outOfOrder,
    delayP50Ms: roundMs(percentile(delays, 0.5)),
    delayP95Ms: roundMs(percentile(delays, 0.95)),
    delayMaxMs: roundMs(delays.at(-1) ?? 0),
    heldThresholdMs,
    heldTicks: delays.filter((delay) => delay > heldThresholdMs).length,
  };
}

// ---------------------------------------------------------------------------
// The gateway side.

export type ProbeSchedule = {
  frames: number;
  intervalMs: number;
  idleMs: number;
};

export type ProbeServerOptions = {
  bind: string;
  port: number;
  compression: GatewayCompressionMode;
  keepaliveMs: number;
};

export type ProbeServer = {
  url: string;
  tokenFile: string;
  stop(): Promise<void>;
};

export async function startProbeServer(options: ProbeServerOptions): Promise<ProbeServer> {
  if (RESERVED_PORTS.has(options.port)) {
    throw new Error(`Refusing port ${options.port}: it belongs to the production backend.`);
  }
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "ork-sse-route-probe-"));
  const token = randomBytes(24).toString("hex");
  const tokenFile = path.join(dataDir, "probe-token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const after = (ms: number, run: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  };
  const gateway: OrkestratorGateway = new OrkestratorGateway({
    backend: {
      invoke: async (command, args) => {
        if (command !== PROBE_START_COMMAND) return null;
        const { frames, intervalMs, idleMs } = args as ProbeSchedule;
        const tick = (seq: number) => {
          gateway.emit(PROBE_EVENT, { seq, sentAtMs: Date.now() });
          if (seq + 1 < frames) after(intervalMs, () => tick(seq + 1));
          else if (seq + 1 === frames) after(idleMs, () => tick(seq + 1));
        };
        tick(0);
        return { ticks: frames + 1 };
      },
    },
    dataDir,
    rendererRoot: dataDir,
    bindAddress: options.bind,
    port: options.port,
    compression: options.compression,
    keepaliveMs: options.keepaliveMs,
    allowNonTailscaleBind: true,
    env: { ORKESTRATOR_GATEWAY_TOKEN: token },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const info = await gateway.start();
  if (!info) throw new Error("The probe gateway did not start");
  return {
    url: info.url,
    tokenFile,
    stop: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await gateway.stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The client side.

export type ProbeMeasureOptions = ProbeSchedule & {
  url: string;
  token: string;
  label: string;
  acceptEncoding: string | null;
  http2: boolean;
  keepaliveEvents: boolean;
  /** Drop the stream after this many ticks and resume from its cursor. 0 never does. */
  reconnectAfter: number;
  headerTimeoutMs?: number;
  /** Optional separate SSE hop for protocol qualification. */
  eventOrigin?: string;
};

export type ProbeResult = ArrivalAnalysis & {
  schema: typeof PROBE_SCHEMA;
  label: string;
  http2: boolean;
  requestedEncoding: string | null;
  status: number;
  contentEncoding: string | null;
  vary: string | null;
  cacheControl: string | null;
  frames: number;
  intervalMs: number;
  idleMs: number;
  /** Keepalive comments and `gateway.keepalive` events seen across the run. */
  keepalives: number;
  reconnects: number;
  clientRawBytes: number;
  serverEncodedBytes: number;
  /**
   * Nothing on the route changed the body's bytes. `null` after a reconnect: the
   * gateway keeps writing until it notices the hang-up, so the counts cannot match.
   */
  bytesMatch: boolean | null;
  streamingActiveAfterClose: number;
  /** Every tick arrived once, in order and unheld, and the bytes were untouched. */
  incremental: boolean;
};

type RouteMetrics = {
  stream: { encodedBodyBytes: number };
  compression: { streamingActive: number };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function measureRoute(options: ProbeMeasureOptions): Promise<ProbeResult> {
  const origin = options.url.replace(/\/+$/, "");
  const authorization = { authorization: `Bearer ${options.token}` };
  const metrics = async (): Promise<RouteMetrics> => {
    const response = await fetch(`${origin}/__orkestrator/metrics`, {
      headers: authorization,
    });
    if (!response.ok) throw new Error(`Metrics request failed with ${response.status}`);
    return (await response.json()) as RouteMetrics;
  };
  const controller = new AbortController();
  const active = new Set<SseProbeStream>();
  try {
    const before = await metrics();

    const expectedTicks = options.frames + 1;
    const arrivals: TickArrival[] = [];
    let keepalives = 0;
    let clientRawBytes = 0;
    let reconnects = 0;
    let lastEventId: string | null = null;
    const search = options.keepaliveEvents ? "?keepaliveEvents=1" : "";
    const open = async (cursor: string | null) => {
      const stream = await openSseProbeStream(
        `${options.eventOrigin ?? origin}/__orkestrator/events${search}`,
        {
          http2: options.http2,
          headerTimeoutMs: options.headerTimeoutMs,
          signal: controller.signal,
          headers: {
            ...authorization,
            ...(options.acceptEncoding === null
              ? {}
              : { "accept-encoding": options.acceptEncoding }),
            ...(cursor === null ? {} : { "last-event-id": cursor }),
          },
        },
      );
      active.add(stream);
      if (stream.status !== 200) {
        stream.close();
        throw new Error(`The event stream answered ${stream.status}`);
      }
      return stream;
    };
    const readFrames = (stream: SseProbeStream, onTick: () => void) => {
      let parsed = 0;
      stream.onDecoded(() => {
        const arrivedAtMs = Date.now();
        const text = stream.text();
        let end = text.indexOf("\n\n", parsed);
        while (end !== -1) {
          const frame = text.slice(parsed, end);
          parsed = end + 2;
          end = text.indexOf("\n\n", parsed);
          if (frame.startsWith(": keepalive") || frame.includes("event: gateway.keepalive")) {
            keepalives += 1;
            continue;
          }
          if (!frame.includes(PROBE_EVENT)) continue;
          lastEventId = /^id: (.+)$/m.exec(frame)?.[1] ?? lastEventId;
          const tick = parseTick(frame);
          if (tick) arrivals.push({ ...tick, arrivedAtMs });
          onTick();
        }
      });
    };

    let stream = await open(null);
    const first = stream;
    const headers = first.headers;
    let reconnecting: Promise<void> | null = null;
    let reconnectError: unknown;
    const resume = async () => {
      stream = await open(lastEventId);
      readFrames(stream, () => {});
    };
    const reconnectIfDue = () => {
      if (options.reconnectAfter === 0 || reconnects > 0) return;
      if (arrivals.length < options.reconnectAfter) return;
      reconnects += 1;
      clientRawBytes += stream.raw().byteLength;
      stream.close();
      reconnecting = resume().catch((error: unknown) => {
        reconnectError = error;
      });
    };
    readFrames(first, reconnectIfDue);

    const started = await fetch(`${origin}/__orkestrator/invoke`, {
      method: "POST",
      headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({
        command: PROBE_START_COMMAND,
        args: {
          frames: options.frames,
          intervalMs: options.intervalMs,
          idleMs: options.idleMs,
        } satisfies ProbeSchedule,
      }),
    });
    if (!started.ok) throw new Error(`The probe gateway refused to start with ${started.status}`);

    const deadline =
      Date.now() + options.frames * options.intervalMs + options.idleMs + 10 * options.intervalMs;
    while (Date.now() < deadline && new Set(arrivals.map(({ seq }) => seq)).size < expectedTicks) {
      if (reconnectError) throw reconnectError;
      await sleep(Math.min(50, options.intervalMs));
    }
    await sleep(BYTE_COUNT_SETTLE_MS);
    await reconnecting;
    if (reconnectError) throw reconnectError;
    clientRawBytes += stream.raw().byteLength;
    const after = await metrics();
    stream.close();

    // The gateway notices the hang-up on its own schedule, and a route adds a hop.
    let closedMetrics = await metrics();
    const releaseDeadline = Date.now() + 2_000;
    while (
      closedMetrics.compression.streamingActive > before.compression.streamingActive &&
      Date.now() < releaseDeadline
    ) {
      await sleep(50);
      closedMetrics = await metrics();
    }

    const analysis = analyzeArrivals(arrivals, expectedTicks, options.intervalMs);
    const serverEncodedBytes = after.stream.encodedBodyBytes - before.stream.encodedBodyBytes;
    const bytesMatch = reconnects > 0 ? null : clientRawBytes === serverEncodedBytes;
    return {
      ...analysis,
      schema: PROBE_SCHEMA,
      label: options.label,
      http2: options.http2,
      requestedEncoding: options.acceptEncoding,
      status: first.status,
      contentEncoding: headerText(headers["content-encoding"]),
      vary: headerText(headers.vary),
      cacheControl: headerText(headers["cache-control"]),
      frames: options.frames,
      intervalMs: options.intervalMs,
      idleMs: options.idleMs,
      keepalives,
      reconnects,
      clientRawBytes,
      serverEncodedBytes,
      bytesMatch,
      streamingActiveAfterClose: closedMetrics.compression.streamingActive,
      incremental:
        analysis.missing === 0 &&
        analysis.duplicates === 0 &&
        analysis.outOfOrder === 0 &&
        analysis.heldTicks === 0 &&
        bytesMatch !== false,
    };
  } finally {
    controller.abort();
    for (const stream of active) stream.close();
  }
}

function headerText(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

function parseTick(frame: string): Pick<TickArrival, "seq" | "sentAtMs"> | null {
  const data = /^data: (.+)$/m.exec(frame)?.[1];
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as {
      payload?: { seq?: unknown; sentAtMs?: unknown };
    };
    const { seq, sentAtMs } = parsed.payload ?? {};
    return typeof seq === "number" && typeof sentAtMs === "number" ? { seq, sentAtMs } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Command line.

function flagReader(argv: readonly string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) throw new Error(`Unexpected argument: ${flag}`);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      switches.add(flag);
    } else {
      values.set(flag, next);
      index += 1;
    }
  }
  const integer = (flag: string, fallback: number, minimum = 0) => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minimum) {
      throw new Error(`${flag} must be an integer of at least ${minimum}`);
    }
    return parsed;
  };
  return { values, switches, integer };
}

export function parseServeOptions(argv: readonly string[]): ProbeServerOptions {
  const { values, integer } = flagReader(argv);
  const compression = values.get("--compression") ?? "on";
  if (compression !== "off" && compression !== "body" && compression !== "on") {
    throw new Error("--compression must be off, body or on");
  }
  const port = integer("--port", 0);
  if (RESERVED_PORTS.has(port)) {
    throw new Error(`Refusing port ${port}: it belongs to the production backend.`);
  }
  return {
    bind: values.get("--bind") ?? "127.0.0.1",
    port,
    compression,
    keepaliveMs: integer("--keepalive-ms", 25_000, 1),
  };
}

export type ParsedMeasureOptions = Omit<ProbeMeasureOptions, "token"> & {
  tokenFile: string;
  out: string | null;
};

export function parseMeasureOptions(argv: readonly string[]): ParsedMeasureOptions {
  const { values, switches, integer } = flagReader(argv);
  const url = values.get("--url");
  const tokenFile = values.get("--token-file");
  if (!url || !tokenFile) throw new Error("measure needs --url and --token-file");
  const acceptEncoding = values.get("--accept-encoding") ?? BROWSER_ACCEPT_ENCODING;
  return {
    url,
    tokenFile,
    label: values.get("--label") ?? "route",
    acceptEncoding: acceptEncoding === "none" ? null : acceptEncoding,
    http2: switches.has("--http2"),
    keepaliveEvents: !switches.has("--keepalive-comments"),
    frames: integer("--frames", 30, 1),
    intervalMs: integer("--interval-ms", 1_000, 1),
    idleMs: integer("--idle-ms", 60_000),
    reconnectAfter: integer("--reconnect-after", 0),
    out: values.get("--out") ?? null,
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const [mode, ...rest] = argv;
  if (mode === "serve") {
    const server = await startProbeServer(parseServeOptions(rest));
    process.stdout.write(
      `${JSON.stringify({ schema: PROBE_SCHEMA, url: server.url, tokenFile: server.tokenFile })}\n`,
    );
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.stop();
    return 0;
  }
  if (mode === "measure") {
    const { tokenFile, out, ...options } = parseMeasureOptions(rest);
    const token = (await readFile(tokenFile, "utf8")).trim();
    const result = await measureRoute({ ...options, token });
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (out) await writeFile(out, json);
    else process.stdout.write(json);
    return result.incremental ? 0 : 1;
  }
  throw new Error("Usage: sse-route-probe.ts serve|measure [flags]; see the header of this file.");
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  });
}

import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";


import { EventEmitter } from "node:events";


import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";


import { connect as netConnect } from "node:net";


import type { Duplex } from "node:stream";


import os from "node:os";


import path from "node:path";


import { randomBytes } from "node:crypto";


import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  createGunzip,
  gunzipSync,
  gzipSync,
} from "node:zlib";


import { afterEach, describe, expect, mock, test } from "bun:test";


import { WebSocket } from "ws";


import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
  TERMINAL_WEBSOCKET_CLOSE,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
  TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES,
  TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
  type TerminalWebSocketServerControlFrame,
} from "@orkestrator/protocol/terminal-websocket";


import {
  activeDynamicCompressionCount,
  AggregateByteBudget,
  allocateBufferedProxySource,
  appendVary,
  BoundedMetricMap,
  browserPreviewDecodeSnapshot,
  canAppendToProxySourceBuffer,
  canBufferBodyChunk,
  canStartDynamicCompression,
  canTransformProxyRepresentation,
  COMPRESSION_MIN_BYTES,
  compressBody,
  compressionModeForListener,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
  DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
  DynamicCompressionBufferBudget,
  dynamicProxyCompressionBufferSnapshot,
  type EventClientWriter,
  eventMatchesSubscription,
  GATEWAY_COMMAND_METRIC_MAP_LIMIT,
  GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES,
  GATEWAY_COMPRESSION_MODES,
  GatewayMetricsStore,
  canStartStaticFallbackCompression,
  compressStaticFileWithinLimits,
  isTailscaleAddress,
  isCompressibleContentType,
  isDynamicCompressionSizeEligible,
  loadOrCreateGatewayToken,
  MAX_BROWSER_PREVIEW_DECODED_TOTAL_BYTES,
  MAX_BUFFERED_BODY_CHUNKS,
  MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS,
  MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
  MAX_DYNAMIC_COMPRESSION_SOURCE_BYTES,
  MAX_DYNAMIC_PROXY_BUFFERED_SOURCE_BYTES,
  MAX_STATIC_FALLBACK_SOURCE_BYTES,
  normalizeAcceptEncoding,
  normalizeCacheControl,
  normalizeContentEncoding,
  normalizeContentType,
  normalizeGatewayEventMetricKey,
  normalizeHttpMethod,
  normalizeHttpVersion,
  normalizeMetricLabel,
  normalizeNextHopProtocol,
  negotiateEncoding,
  OrkestratorGateway,
  parseEventSubscriptionFilter,
  parseGatewayCompressionMode,
  parseStrictContentLengthHeader,
  prepareCompressedBody,
  readStaticFileWithinLimit,
  recoverBodyResponseError,
  releaseReservationOnResponseSettled,
  resolveGatewayCompressionMode,
  responseStatusCanHaveBody,
  rewriteBrowserPreviewBody,
  selectTailscaleBindAddress,
  settlePreparedBodyResponse,
  settleRewrittenProxyBodyResponse,
  shouldAbandonBufferedProxyBody,
  stripCodedContentHeaders,
  stripTransformedRepresentationHeaders,
  truncateUtf8,
} from "../../../apps/backend/src/gateway";


import {
  DEFAULT_GATEWAY_REPLAY_MAX_BYTES,
  GatewayEventReplay,
  parseGatewayCursor,
} from "../../../apps/backend/src/gateway-event-replay";


import { createCommandRegistry } from "../../../apps/backend/src/core/commands";


import { TerminalWebSocketGateway } from "../../../apps/backend/src/terminal-websocket-server";



const tempDirs: string[] = [];


const gateways: OrkestratorGateway[] = [];


const auxiliaryServers: Server[] = [];



async function requestUrl(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{
  status: number;
  body: string;
  rawBody: Buffer;
  headers: IncomingHttpHeaders;
  json: () => unknown;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = httpRequest({
      hostname: parsed.hostname,
      port: parsed.port,
      path: `${parsed.pathname}${parsed.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      response.on("aborted", () => reject(new Error("Response aborted")));
      response.on("error", reject);
      response.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        const body = rawBody.toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          body,
          rawBody,
          headers: response.headers,
          json: () => JSON.parse(body) as unknown,
        });
      });
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}



function decodeResponseBody(response: {
  headers: IncomingHttpHeaders;
  rawBody: Buffer;
  body: string;
}): string {
  const encoding = response.headers["content-encoding"];
  if (encoding === "br") return brotliDecompressSync(response.rawBody).toString("utf8");
  if (encoding === "gzip") return gunzipSync(response.rawBody).toString("utf8");
  return response.body;
}



type GatewayMetricsSnapshot = {
  routes: Record<string, {
    requests: number;
    requestBytes: number;
    responseBytes: number;
    statusCodes: Record<string, number>;
    encodings: Record<string, number>;
  }>;
  commands: Record<string, {
    count: number;
    requestBytes: number;
    responseBytes: number;
    failures: number;
  }>;
  events: Record<string, {
    frames: number;
    wireBytes: number;
    droppedFrames: number;
    droppedClients: number;
  }>;
  stream: {
    open: number;
    connecting: number;
    opened: number;
    closed: number;
    dropped: number;
    stalled: number;
    softDesyncs: number;
    keepalives: number;
  };
  compression: { configuredMode: string };
  recentRouteSamples: Array<{
    route: string;
    method: string;
    httpVersion: string;
    statusCode: number;
    requestBytes: number;
    responseBytes: number;
    contentEncoding: string | null;
    cacheControl: string | null;
    contentType: string | null;
    acceptEncoding: string | null;
  }>;
  recentClientBootReports: Array<{
    platform: string;
    navigationType: string;
    httpVersion: string | null;
    nextHopProtocol: string | null;
    resourceCount: number | null;
    loadEventMs: number | null;
  }>;
};



async function readGatewayMetrics(info: { url: string; token: string }): Promise<GatewayMetricsSnapshot> {
  const response = await requestUrl(`${info.url}__orkestrator/metrics`, {
    headers: { authorization: `Bearer ${info.token}` },
  });
  expect(response.status).toBe(200);
  return response.json() as GatewayMetricsSnapshot;
}



function createLogger() {
  return {
    debug: mock(() => undefined),
    error: mock(() => undefined),
    info: mock(() => undefined),
    warn: mock(() => undefined),
  };
}



async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}



async function createRendererRoot(dataDir: string, index = "<div id=\"root\"></div>"): Promise<string> {
  const rendererRoot = path.join(dataDir, "dist");
  await mkdir(rendererRoot);
  await writeFile(path.join(rendererRoot, "index.html"), index);
  return rendererRoot;
}



async function writeRendererAsset(
  rendererRoot: string,
  relativePath: string,
  contents: string | Buffer,
): Promise<string> {
  const filePath = path.join(rendererRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
  return filePath;
}



async function writeCompressedSibling(
  filePath: string,
  encoding: "br" | "gzip",
  body: string,
): Promise<string> {
  const buffer = Buffer.from(body, "utf8");
  const siblingPath = `${filePath}.${encoding === "br" ? "br" : "gz"}`;
  await writeFile(
    siblingPath,
    encoding === "br" ? brotliCompressSync(buffer) : gzipSync(buffer),
  );
  return siblingPath;
}



async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}



async function occupyContiguousPorts(count: number): Promise<{ start: number; servers: Server[] }> {
  for (let start = 42_000; start <= 62_000 - count; start += count) {
    const servers: Server[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const server = createServer((_request, response) => response.end("occupied"));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(start + offset, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        servers.push(server);
      }
      return { start, servers };
    } catch {
      await Promise.all(servers.map(closeServer));
    }
  }
  throw new Error(`Unable to reserve ${count} contiguous test ports`);
}



async function startGateway(options: Partial<ConstructorParameters<typeof OrkestratorGateway>[0]> = {}) {
  const dataDir = options.dataDir ?? await createTempDir("ork-gateway-");
  const rendererRoot = options.rendererRoot ?? await createRendererRoot(dataDir);
  const gateway = new OrkestratorGateway({
    backend: { invoke: mock(async () => null) },
    dataDir,
    rendererRoot,
    bindAddress: "127.0.0.1",
    port: 0,
    env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
    logger: createLogger(),
    allowNonTailscaleBind: true,
    ...options,
  });
  gateways.push(gateway);
  const info = await gateway.start();
  if (!info) throw new Error("Gateway did not start");
  return { gateway, info, dataDir, rendererRoot };
}



async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}



function eventClients(gateway: OrkestratorGateway): Map<ServerResponse, unknown> {
  return (gateway as unknown as { clients: Map<ServerResponse, unknown> }).clients;
}



type GatewayEventStream = {
  /** Everything this browser-side client has received so far. */
  received: () => string;
  /** The gateway-side response the real request path registered. */
  response: EventClientWriter;
  /** True once the gateway hung up on this client. */
  aborted: () => boolean;
  close: () => void;
};



/** Opens a real `/__orkestrator/events` stream and pairs it with its server response. */
async function openEventStream(
  gateway: OrkestratorGateway,
  info: { url: string; token: string },
  search = "",
  headers: Record<string, string> = {},
): Promise<GatewayEventStream> {
  const parsed = new URL(`${info.url}__orkestrator/events${search}`);
  const known = new Set(eventClients(gateway).keys());
  let received = "";
  let aborted = false;
  const request = httpRequest({
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    headers: { authorization: `Bearer ${info.token}`, ...headers },
  }, (response) => {
    response.on("data", (chunk) => {
      received += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    });
    response.on("aborted", () => { aborted = true; });
  });
  request.on("error", () => { aborted = true; });
  request.end();
  await waitUntil(() => received.includes(": connected"), "Event stream never connected");

  const response = [...eventClients(gateway).keys()].find((client) => !known.has(client));
  if (!response) throw new Error("Gateway did not register the event-stream client");
  return {
    received: () => received,
    response,
    aborted: () => aborted,
    close: () => request.destroy(),
  };
}



function eventFrames(body: string, event: string): string[] {
  return body
    .split(/\r?\n\r?\n/)
    .filter((block) => block.includes(`"event":"${event}"`))
    .map((block) => `${block}\n\n`);
}



function frameId(frame: string): string | null {
  return /^id: (.+)$/m.exec(frame)?.[1] ?? null;
}



async function openCompressedEventStream(
  gateway: OrkestratorGateway,
  info: { url: string; token: string },
  search = "",
): Promise<GatewayEventStream & { headers: () => IncomingHttpHeaders }> {
  const parsed = new URL(`${info.url}__orkestrator/events${search}`);
  const known = new Set(eventClients(gateway).keys());
  const chunks: Buffer[] = [];
  let responseHeaders: IncomingHttpHeaders = {};
  let aborted = false;
  const request = httpRequest({
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "gzip",
    },
  }, (response) => {
    responseHeaders = response.headers;
    response.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on("aborted", () => { aborted = true; });
  });
  request.on("error", () => { aborted = true; });
  request.end();

  const received = () => {
    const compressed = Buffer.concat(chunks);
    if (compressed.byteLength === 0) return "";
    try {
      return gunzipSync(compressed, {
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      }).toString("utf8");
    } catch {
      return "";
    }
  };
  await waitUntil(() => received().includes(": connected"), "Compressed event stream never connected");
  const writer = [...eventClients(gateway).keys()].find((client) => !known.has(client));
  if (!writer) throw new Error("Gateway did not register the compressed event-stream client");
  return {
    received,
    response: writer,
    headers: () => responseHeaders,
    aborted: () => aborted,
    close: () => request.destroy(),
  };
}



/**
 * Pins the buffered byte count the gateway sees for a live response.
 *
 * Every backpressure limit is expressed in terms of `writableLength`, and a
 * loopback socket drains far faster than a test can observe, so a genuinely
 * parked client is not reproducible here. Pinning the value puts a real
 * response into the state the limits exist for.
 */
function pinBufferedBytes(response: ServerResponse | EventClientWriter, bytes: number): void {
  Object.defineProperty(response, "writableLength", { value: bytes, configurable: true });
}



function releaseBufferedBytes(response: ServerResponse | EventClientWriter): void {
  Reflect.deleteProperty(response, "writableLength");
}



afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.stop().catch(() => undefined)));
  await Promise.all(auxiliaryServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});



type WebSocketInbox = {
  next(): Promise<{ data: Buffer; binary: boolean }>;
};



function websocketInbox(socket: WebSocket): WebSocketInbox {
  const queued: Array<{ data: Buffer; binary: boolean }> = [];
  const waiting: Array<(message: { data: Buffer; binary: boolean }) => void> = [];
  socket.on("message", (data, binary) => {
    const message = { data: Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer), binary };
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return {
    next: () => {
      const message = queued.shift();
      return message ? Promise.resolve(message) : new Promise((resolve) => waiting.push(resolve));
    },
  };
}



async function openTerminalSocket(
  info: { url: string; token: string },
  options: { authenticate?: boolean; headers?: Record<string, string> } = {},
): Promise<{ socket: WebSocket; inbox: WebSocketInbox }> {
  const socket = new WebSocket(
    `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`,
    TERMINAL_WEBSOCKET_SUBPROTOCOL,
    options.headers ? { headers: options.headers } : undefined,
  );
  const inbox = websocketInbox(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  if (options.authenticate !== false) {
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
    expect(await nextTerminalControl(inbox, "ready")).toMatchObject({ type: "ready", version: 1 });
  }
  return { socket, inbox };
}



async function nextTerminalControl(
  inbox: WebSocketInbox,
  type: TerminalWebSocketServerControlFrame["type"],
): Promise<TerminalWebSocketServerControlFrame> {
  while (true) {
    const message = await inbox.next();
    if (message.binary) continue;
    const frame = parseTerminalWebSocketServerControlFrame(message.data.toString("utf8"));
    if (frame.type === type) return frame;
  }
}

describe("remote gateway", () => {


  test("prefers explicit compression configuration over the environment", () => {
    expect(resolveGatewayCompressionMode("off", {
      ORKESTRATOR_GATEWAY_COMPRESSION: "on",
    })).toBe("off");
    expect(resolveGatewayCompressionMode(undefined, {
      ORKESTRATOR_GATEWAY_COMPRESSION: "body",
    })).toBe("body");
    expect(resolveGatewayCompressionMode(undefined, {})).toBe("body");
    expect(compressionModeForListener("on", "control")).toBe("off");
    expect(compressionModeForListener("on", "browser")).toBe("on");
  });



  test("bounds incrementally sized decode buffers with an aggregate byte budget", () => {
    const budget = new AggregateByteBudget(1024);
    expect(budget.tryAcquire(512)).toBe(true);
    expect(budget.tryAcquire(512)).toBe(true);
    expect(budget.snapshot()).toEqual({ activeBytes: 1024 });
    expect(budget.tryAcquire(1)).toBe(false);
    expect(budget.tryAcquire(0)).toBe(true);
    expect(budget.tryAcquire(-1)).toBe(false);
    expect(budget.tryAcquire(Number.NaN)).toBe(false);
    expect(budget.tryAcquire(1.5)).toBe(false);
    expect(budget.snapshot()).toEqual({ activeBytes: 1024 });

    budget.release(512);
    expect(budget.snapshot()).toEqual({ activeBytes: 512 });
    // Releases that cannot describe real bytes must not credit the budget.
    budget.release(0);
    budget.release(-1);
    budget.release(Number.NaN);
    expect(budget.snapshot()).toEqual({ activeBytes: 512 });
    // Over-releasing floors at zero rather than manufacturing capacity.
    budget.release(4096);
    expect(budget.snapshot()).toEqual({ activeBytes: 0 });
    expect(budget.tryAcquire(1024)).toBe(true);
  });



  test("parses gateway compression modes and rejects unknown values", () => {
    expect([...GATEWAY_COMPRESSION_MODES]).toEqual(["off", "body", "on"]);
    for (const mode of GATEWAY_COMPRESSION_MODES) {
      expect(parseGatewayCompressionMode(mode)).toBe(mode);
    }
    expect(parseGatewayCompressionMode(" body ")).toBe("body");
    expect(parseGatewayCompressionMode("BODY")).toBe("body");
    // An absent value leaves the caller's default in place; anything present but
    // unrecognized is a configuration error rather than a silent fallback.
    expect(parseGatewayCompressionMode(undefined)).toBeUndefined();
    for (const invalid of ["", "gzip", "true", "  "]) {
      expect(() => parseGatewayCompressionMode(invalid)).toThrow(
        "Expected one of off, body, on",
      );
    }
    expect(() => parseGatewayCompressionMode("gzip", "ORKESTRATOR_GATEWAY_COMPRESSION")).toThrow(
      "Invalid ORKESTRATOR_GATEWAY_COMPRESSION: gzip",
    );
  });



  test("falls back for non-beneficial and failed codecs and caps concurrent codec jobs", async () => {
    const source = Buffer.from("dynamic source ".repeat(256));
    const context = { mode: "body", acceptEncoding: "gzip" } as const;
    const nonBeneficial = await prepareCompressedBody(
      source,
      "text/plain",
      context,
      null,
      mock(async () => Buffer.from(source)),
    );
    expect(nonBeneficial.encoding).toBe("identity");
    expect(nonBeneficial.body).toEqual(source);

    const failed = await prepareCompressedBody(
      source,
      "text/plain",
      context,
      null,
      mock(async () => {
        throw new Error("codec failed");
      }),
    );
    expect(failed.encoding).toBe("identity");
    expect(failed.body).toEqual(source);

    const releases: Array<() => void> = [];
    const parkedCompressor = mock(async () => new Promise<Buffer>((resolve) => {
      releases.push(() => resolve(Buffer.from("compressed")));
    }));
    const parked = Array.from(
      { length: MAX_CONCURRENT_DYNAMIC_COMPRESSIONS },
      () => prepareCompressedBody(source, "text/plain", context, null, parkedCompressor),
    );
    await waitUntil(
      () => releases.length === MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
      "Dynamic codecs did not fill the admission pool",
    );
    const overflowCompressor = mock(async () => Buffer.from("should not run"));
    const overflow = await prepareCompressedBody(
      source,
      "text/plain",
      context,
      null,
      overflowCompressor,
    );
    expect(overflow.encoding).toBe("identity");
    expect(overflowCompressor).not.toHaveBeenCalled();
    for (const release of releases) release();
    expect((await Promise.all(parked)).every((result) => result.encoding === "gzip")).toBe(true);

    const retryCompressor = mock(async () => Buffer.from("compressed"));
    expect((await prepareCompressedBody(
      source,
      "text/plain",
      context,
      null,
      retryCompressor,
    )).encoding).toBe("gzip");
    expect(retryCompressor).toHaveBeenCalledTimes(1);
  });



  test("recovers an unexpected body preparation failure before or after headers", async () => {
    const storedHeaders = new Map<string, string | number>();
    let endedBody: Buffer | undefined;
    const identityResponse = {
      headersSent: false,
      destroyed: false,
      setHeader: (name: string, value: string | number) => storedHeaders.set(name, value),
      getHeader: (name: string) => storedHeaders.get(name),
      removeHeader: (name: string) => storedHeaders.delete(name),
      writeHead: mock(() => undefined),
      end: mock((body: Buffer) => {
        endedBody = body;
      }),
      destroy: mock(() => undefined),
    } as unknown as ServerResponse;
    const source = Buffer.from("identity fallback");
    settlePreparedBodyResponse(
      identityResponse,
      200,
      { "content-type": "text/plain" },
      source,
      Promise.reject(new Error("prepare failed")),
    );
    await waitUntil(() => endedBody !== undefined, "Rejected body preparation did not recover");
    expect(endedBody).toEqual(source);
    expect(storedHeaders.get("content-length")).toBe(source.byteLength);
    expect(storedHeaders.get("vary")).toBe("Accept-Encoding");
    expect(identityResponse.destroy).not.toHaveBeenCalled();

    const destroy = mock(() => undefined);
    const sentResponse = {
      headersSent: true,
      destroy,
    } as unknown as ServerResponse;
    recoverBodyResponseError(
      sentResponse,
      200,
      {},
      source,
      "prepare failed",
    );
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(destroy.mock.calls[0]?.[0]).toBeInstanceOf(Error);

    // A client that vanished while the codec was running must not be written to:
    // the prepared body is discarded rather than pushed at a dead socket.
    const destroyedWriteHead = mock(() => undefined);
    const destroyedEnd = mock(() => undefined);
    const destroyedResponse = {
      headersSent: false,
      destroyed: true,
      setHeader: mock(() => undefined),
      getHeader: mock(() => undefined),
      removeHeader: mock(() => undefined),
      writeHead: destroyedWriteHead,
      end: destroyedEnd,
      destroy: mock(() => undefined),
    } as unknown as ServerResponse;
    let settledPreparation = false;
    settlePreparedBodyResponse(
      destroyedResponse,
      200,
      { "content-type": "text/plain" },
      source,
      Promise.resolve({
        body: Buffer.from("compressed"),
        encoding: "gzip",
        variesByEncoding: true,
      }).finally(() => {
        settledPreparation = true;
      }),
    );
    await waitUntil(() => settledPreparation, "Body preparation never settled");
    // One extra turn so a stray write would have landed before we assert.
    await Promise.resolve();
    expect(destroyedWriteHead).not.toHaveBeenCalled();
    expect(destroyedEnd).not.toHaveBeenCalled();
    expect(destroyedResponse.destroy).not.toHaveBeenCalled();
  });



  test("keeps small dynamic bodies identity while allowing static compression on browser listeners", async () => {
    for (const compression of ["off", "body", "on"] as const) {
      const dataDir = await createTempDir(`ork-static-compression-${compression}-`);
      const rendererRoot = await createRendererRoot(
        dataDir,
        "<div id=\"root\">".concat("content ".repeat(256), "</div>"),
      );
      const { info } = await startGateway({
        dataDir,
        rendererRoot,
        compression,
        backend: { invoke: mock(async () => ({ ok: true })) },
      });
      const authorization = { authorization: `Bearer ${info.token}` };
      const acceptsEverything = { ...authorization, "accept-encoding": "gzip, deflate, br" };

      const responses = [
        await requestUrl(`${info.url}__orkestrator/status`, { headers: acceptsEverything }),
        await requestUrl(`${info.url}__orkestrator/invoke`, {
          method: "POST",
          headers: { ...acceptsEverything, "content-type": "application/json" },
          body: JSON.stringify({ command: "noop" }),
        }),
      ];

      for (const response of responses) {
        expect(response.status).toBeLessThan(400);
        expect(response.headers["content-encoding"]).toBeUndefined();
        expect(Number(response.headers["content-length"])).toBeLessThan(COMPRESSION_MIN_BYTES);
      }

      // `/metrics` is a diagnostic dump whose size grows with traffic and route
      // samples, so it is not a "small dynamic body" — it is eligible for
      // compression on exactly the same size rule as any other dynamic body.
      const metricsResponse = await requestUrl(
        `${info.url}__orkestrator/metrics`,
        { headers: acceptsEverything },
      );
      expect(metricsResponse.status).toBe(200);
      const metricsBytes = Buffer.byteLength(decodeResponseBody(metricsResponse));
      if (compression === "off" || metricsBytes < COMPRESSION_MIN_BYTES) {
        expect(metricsResponse.headers["content-encoding"]).toBeUndefined();
      } else {
        expect(["br", "gzip"]).toContain(metricsResponse.headers["content-encoding"]);
      }
      expect(JSON.parse(decodeResponseBody(metricsResponse)).replay).toBeDefined();

      const staticResponse = await requestUrl(info.url, { headers: acceptsEverything });
      expect(staticResponse.status).toBe(200);
      if (compression === "off") {
        expect(staticResponse.headers["content-encoding"]).toBeUndefined();
      } else {
        expect(["br", "gzip"]).toContain(staticResponse.headers["content-encoding"]);
        expect(decodeResponseBody(staticResponse)).toContain("root");
      }

      const metrics = await readGatewayMetrics(info);
      expect(metrics.routes.invoke?.encodings.identity).toBeGreaterThan(0);
      expect(metrics.routes.status?.encodings.identity).toBeGreaterThan(0);
      expect(metrics.compression.configuredMode).toBe(compression);
    }
  });



  test("applies the dynamic compression threshold at the exact serialized byte boundary", async () => {
    const emptyResponseBytes = Buffer.byteLength(JSON.stringify({ result: "" }));
    const payloads = new Map([
      ["below_threshold", "x".repeat(COMPRESSION_MIN_BYTES - 1 - emptyResponseBytes)],
      ["at_threshold", "x".repeat(COMPRESSION_MIN_BYTES - emptyResponseBytes)],
    ]);
    const { info } = await startGateway({
      compression: "body",
      backend: {
        invoke: mock(async (command: string) => payloads.get(command)),
      },
    });
    const invoke = (command: string) => requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
        "accept-encoding": "gzip",
      },
      body: JSON.stringify({ command, args: {} }),
    });

    const below = await invoke("below_threshold");
    expect(below.headers["content-encoding"]).toBeUndefined();
    expect(below.rawBody.byteLength).toBe(COMPRESSION_MIN_BYTES - 1);
    const exact = await invoke("at_threshold");
    expect(exact.headers["content-encoding"]).toBe("gzip");
    expect(Buffer.byteLength(decodeResponseBody(exact))).toBe(COMPRESSION_MIN_BYTES);
  });



  test("honors Accept-Encoding qualities, wildcards, and explicit exclusions", async () => {
    const dataDir = await createTempDir("ork-static-negotiation-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetPath = await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('identity');".repeat(256),
    );
    await writeCompressedSibling(assetPath, "br", "brotli sibling");
    await writeCompressedSibling(assetPath, "gzip", "gzip sibling");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    const cases = [
      { acceptEncoding: "br;q=0.5, gzip;q=1", expected: "gzip" },
      { acceptEncoding: "br;q=1, gzip;q=0.5", expected: "br" },
      { acceptEncoding: "*;q=1", expected: "br" },
      { acceptEncoding: "br;q=0, *;q=1", expected: "gzip" },
      { acceptEncoding: "br;q=invalid, gzip;q=1", expected: "gzip" },
      { acceptEncoding: "br;q=0, gzip;q=0, identity", expected: "identity" },
      { acceptEncoding: "br;q=0.4, gzip;q=0.5, identity;q=0.8", expected: "identity" },
      { acceptEncoding: "*;q=0, identity;q=1", expected: "identity" },
    ] as const;

    for (const { acceptEncoding, expected } of cases) {
      const response = await requestUrl(`${info.url}assets/app-12345678.js`, {
        headers: { ...authorization, "accept-encoding": acceptEncoding },
      });
      expect(response.status, acceptEncoding).toBe(200);
      expect(response.headers["content-encoding"] ?? "identity", acceptEncoding).toBe(expected);
    }

    for (const acceptEncoding of [
      "br;q=0, gzip;q=0, identity;q=0",
      "*;q=0",
    ]) {
      const response = await requestUrl(`${info.url}assets/app-12345678.js`, {
        headers: { ...authorization, "accept-encoding": acceptEncoding },
      });
      expect(response.status, acceptEncoding).toBe(406);
      expect(response.rawBody.byteLength, acceptEncoding).toBe(0);
      expect(response.headers.vary, acceptEncoding).toBe("Accept-Encoding");
    }
  });



  test("uses encoding-specific ETags and returns 304 for matching If-None-Match", async () => {
    const dataDir = await createTempDir("ork-static-etag-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetPath = await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('etag');",
    );
    await writeCompressedSibling(assetPath, "br", "brotli sibling");
    await writeCompressedSibling(assetPath, "gzip", "gzip sibling");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    const brotli = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "br" },
    });
    const gzip = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "gzip" },
    });

    expect(brotli.headers.etag).toBeTruthy();
    expect(gzip.headers.etag).toBeTruthy();
    expect(brotli.headers.etag).not.toBe(gzip.headers.etag);
    const brotliStrongEquivalent = String(brotli.headers.etag).replace(/^W\//, "");

    const notModified = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": String(brotli.headers.etag),
      },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.rawBody.byteLength).toBe(0);
    expect(notModified.headers.etag).toBe(brotli.headers.etag);

    const weakNotModified = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": `"unrelated", ${brotliStrongEquivalent}`,
      },
    });
    expect(weakNotModified.status).toBe(304);
    expect(weakNotModified.rawBody.byteLength).toBe(0);

    const weakHeadNotModified = await requestUrl(`${info.url}assets/app-12345678.js`, {
      method: "HEAD",
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": brotliStrongEquivalent,
      },
    });
    expect(weakHeadNotModified.status).toBe(304);
    expect(weakHeadNotModified.rawBody.byteLength).toBe(0);

    const wildcardNotModified = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": "*",
      },
    });
    expect(wildcardNotModified.status).toBe(304);
    expect(wildcardNotModified.rawBody.byteLength).toBe(0);

    const mismatch = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": String(gzip.headers.etag),
      },
    });
    expect(mismatch.status).toBe(200);

    const malformed = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        ...authorization,
        "accept-encoding": "br",
        "if-none-match": `W/not-quoted`,
      },
    });
    expect(malformed.status).toBe(200);
  });



  test("returns HEAD with GET headers and no body", async () => {
    const dataDir = await createTempDir("ork-static-head-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetPath = await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('head');".repeat(256),
    );
    await writeCompressedSibling(assetPath, "gzip", "gzip sibling");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "accept-encoding": "gzip",
    };
    const getResponse = await requestUrl(`${info.url}assets/app-12345678.js`, { headers });
    const headResponse = await requestUrl(`${info.url}assets/app-12345678.js`, {
      method: "HEAD",
      headers,
    });

    expect(headResponse.status).toBe(200);
    expect(headResponse.rawBody.byteLength).toBe(0);
    expect(headResponse.headers["content-encoding"]).toBe(getResponse.headers["content-encoding"]);
    expect(headResponse.headers["content-length"]).toBe(getResponse.headers["content-length"]);
    expect(headResponse.headers.etag).toBe(getResponse.headers.etag);
    expect(headResponse.headers["last-modified"]).toBe(getResponse.headers["last-modified"]);
  });



  test("negotiates HEAD without running on-the-fly compression when no sibling exists", async () => {
    const dataDir = await createTempDir("ork-static-head-fallback-");
    const rendererRoot = await createRendererRoot(dataDir);
    await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('head fallback');".repeat(256),
    );

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const response = await requestUrl(`${info.url}assets/app-12345678.js`, {
      method: "HEAD",
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "gzip, identity;q=0",
      },
    });

    expect(response.status).toBe(200);
    expect(response.rawBody.byteLength).toBe(0);
    expect(response.headers["content-encoding"]).toBe("gzip");
    // Identity is forbidden, so GET must answer with the coded form. Its
    // encoding is known without compressing; only its length is withheld.
    expect(response.headers["content-length"]).toBeUndefined();
    expect(response.headers.etag).toBeTruthy();

    const getResponse = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "gzip, identity;q=0",
      },
    });
    expect(getResponse.status).toBe(response.status);
    expect(getResponse.headers["content-encoding"]).toBe("gzip");
    expect(getResponse.headers.etag).toBe(String(response.headers.etag));
  });



  test("keeps serving identity to identity-refusing clients while the compression pool is saturated", async () => {
    const dataDir = await createTempDir("ork-static-declined-saturated-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetCount = MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS * 3;
    for (let index = 0; index < assetCount; index += 1) {
      await writeRendererAsset(
        rendererRoot,
        `assets/saturate-${String(index).padStart(8, "0")}.js`,
        `console.log('saturate-${index}');`.repeat(75_000),
      );
    }

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const responses = await Promise.all(
      Array.from({ length: assetCount }, (_, index) => (
        requestUrl(`${info.url}assets/saturate-${String(index).padStart(8, "0")}.js`, {
          headers: {
            authorization: `Bearer ${info.token}`,
            "accept-encoding": "br, gzip, identity;q=0",
          },
        })
      )),
    );

    // Admission is bounded, so some of these are certainly declined. None may
    // become a 406: the status must not depend on unrelated concurrent load.
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: assetCount }, () => 200),
    );
    for (const response of responses) {
      expect(decodeResponseBody(response)).toContain("saturate-");
    }
  });



  test("bounds concurrent on-the-fly compression admission without failing requests", async () => {
    expect(canStartStaticFallbackCompression(
      MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS - 1,
    )).toBe(true);
    expect(canStartStaticFallbackCompression(
      MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS,
    )).toBe(false);
    expect(canStartStaticFallbackCompression(
      MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS + 1,
    )).toBe(false);

    const dataDir = await createTempDir("ork-static-fallback-concurrency-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetCount = MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS + 1;
    for (let index = 0; index < assetCount; index += 1) {
      await writeRendererAsset(
        rendererRoot,
        `assets/concurrent-${String(index).padStart(8, "0")}.js`,
        `console.log('concurrent-${index}');`.repeat(75_000),
      );
    }

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const responses = await Promise.all(
      Array.from({ length: assetCount }, (_, index) => (
        requestUrl(`${info.url}assets/concurrent-${String(index).padStart(8, "0")}.js`, {
          headers: {
            authorization: `Bearer ${info.token}`,
            "accept-encoding": "br",
          },
        })
      )),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => (
      response.headers["content-encoding"] === "br"
      || response.headers["content-encoding"] === undefined
    ))).toBe(true);
  });



  test("rejects unsupported methods on static resources", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(info.url, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
      body: "not a static request",
    });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET, HEAD");
    expect(response.rawBody.byteLength).toBe(0);
  });



  test("tracks stream gauges without double-counting a handshake", () => {
    const metrics = new GatewayMetricsStore("off");
    const stream = () => metrics.snapshot().stream;
    expect(metrics.snapshot().compression.configuredMode).toBe("off");
    metrics.setConfiguredCompressionMode("on");
    expect(metrics.snapshot().compression.configuredMode).toBe("on");

    // Two concurrent handshakes are both in flight before either completes.
    metrics.recordStreamConnecting();
    metrics.recordStreamConnecting();
    expect(stream()).toMatchObject({ connecting: 2, open: 0, opened: 0 });

    metrics.recordStreamOpened();
    expect(stream()).toMatchObject({ connecting: 1, open: 1, opened: 1 });

    // Closing an open stream must not touch `connecting`: that handshake
    // already left the gauge, and decrementing again would silently undercount
    // the handshake still in flight.
    metrics.recordStreamClosed();
    expect(stream()).toMatchObject({ connecting: 1, open: 0, closed: 1 });

    // A handshake that never reaches `open` releases the gauge explicitly.
    metrics.recordStreamConnectFailed();
    expect(stream()).toMatchObject({ connecting: 0, open: 0, closed: 1 });

    // Gauges never go negative, however unbalanced the calls.
    metrics.recordStreamClosed();
    metrics.recordStreamConnectFailed();
    expect(stream()).toMatchObject({ connecting: 0, open: 0, closed: 2 });

    // Dropping a client counts the drop and nothing else; the socket close
    // handler is what releases `open`.
    metrics.recordStreamConnecting();
    metrics.recordStreamOpened();
    metrics.recordStreamDropped();
    expect(stream()).toMatchObject({ connecting: 0, open: 1, dropped: 1 });
    metrics.recordStreamClosed();
    expect(stream()).toMatchObject({ connecting: 0, open: 0, dropped: 1 });
  });



  test("sizes the command label budget to hold the whole backend registry", () => {
    const registry = createCommandRegistry();
    const names = [...registry.keys()];

    // Command labels are an allowlist: unregistered names become `__unknown__`,
    // so every label this map can ever hold comes from here. A budget below the
    // registry would fold real commands into `__overflow__` in invocation
    // order, making the per-command breakdown incomplete and run-dependent.
    expect(names.length).toBeGreaterThan(0);
    // One slot is reserved for `__overflow__`, plus `__unknown__`/`__invalid__`.
    expect(names.length).toBeLessThanOrEqual(GATEWAY_COMMAND_METRIC_MAP_LIMIT - 3);
    expect(names.reduce((total, name) => total + Buffer.byteLength(name), 0))
      .toBeLessThanOrEqual(GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES - 128);
    // Every registered name must survive normalization, or it would be filed
    // as `__invalid__` and vanish from the breakdown.
    const misnormalized = names.filter((name) => normalizeMetricLabel(name) !== name);
    expect(misnormalized).toEqual([]);
  });



  test("bounds a metric map by entry count and by total label bytes", () => {
    const byCount = new BoundedMetricMap<number>(8, 8 * 1024);
    for (let index = 0; index < 50; index += 1) {
      byCount.set(byCount.resolveKey(`event-${index}`), index);
    }
    expect(byCount.size).toBe(8);
    expect(byCount.get("__overflow__")).toBeDefined();
    expect(byCount.get("event-0")).toBe(0);

    // 30-byte labels against a 96-byte budget: the byte bound binds first.
    const byBytes = new BoundedMetricMap<number>(1_000, 96);
    for (let index = 0; index < 50; index += 1) {
      byBytes.set(byBytes.resolveKey(`label-${String(index).padStart(3, "0")}-xxxxxxxxxxxxxxxxxxxx`), index);
    }
    expect(byBytes.size).toBeLessThan(1_000);
    expect(byBytes.usedLabelBytes).toBeLessThanOrEqual(96);
    expect(byBytes.get("__overflow__")).toBeDefined();

    // A key already present is always returned, never rerouted to overflow.
    const saturated = new BoundedMetricMap<number>(2, 8 * 1024);
    saturated.set(saturated.resolveKey("first"), 1);
    expect(saturated.resolveKey("first")).toBe("first");
    expect(saturated.resolveKey("second")).toBe("__overflow__");

    // Oversized single labels overflow regardless of remaining budget.
    const roomy = new BoundedMetricMap<number>(1_000, 1_000_000);
    expect(roomy.resolveKey("x".repeat(97))).toBe("__overflow__");
    expect(roomy.resolveKey("x".repeat(96))).toBe("x".repeat(96));
  });



  test("normalizes request and response header labels to fixed cardinality", () => {
    expect(normalizeHttpMethod("get")).toBe("GET");
    expect(normalizeHttpMethod(" post ")).toBe("POST");
    for (const method of ["DELETE", "HEAD", "OPTIONS", "PATCH", "PUT"]) {
      expect(normalizeHttpMethod(method)).toBe(method);
    }
    expect(normalizeHttpMethod("PROPFIND")).toBe("OTHER");
    expect(normalizeHttpMethod("")).toBe("OTHER");

    expect(normalizeHttpVersion("1.1")).toBe("1.1");
    expect(normalizeHttpVersion(" 2.0 ")).toBe("2.0");
    expect(normalizeHttpVersion("3.0")).toBe("3.0");
    expect(normalizeHttpVersion("1.0")).toBe("1.0");
    expect(normalizeHttpVersion("0.9")).toBe("other");

    expect(normalizeContentEncoding(null)).toBe("identity");
    expect(normalizeContentEncoding("")).toBe("identity");
    expect(normalizeContentEncoding(" GZIP ")).toBe("gzip");
    expect(normalizeContentEncoding("br")).toBe("br");
    expect(normalizeContentEncoding("deflate")).toBe("deflate");
    expect(normalizeContentEncoding("zstd")).toBe("other");

    // `q=0` is a refusal, not support: recording it as support would be the
    // one error direction that wrongly enables compression for that client.
    expect(normalizeAcceptEncoding(null)).toBeNull();
    expect(normalizeAcceptEncoding("")).toBeNull();
    expect(normalizeAcceptEncoding("gzip, deflate, br")).toBe("br,deflate,gzip");
    expect(normalizeAcceptEncoding("GZIP;q=1.0, br;q=0.8")).toBe("br,gzip");
    expect(normalizeAcceptEncoding("gzip;q=0, identity")).toBe("identity");
    expect(normalizeAcceptEncoding("gzip;q=0.0")).toBeNull();
    expect(normalizeAcceptEncoding("*")).toBe("other");
    expect(normalizeAcceptEncoding("gzip, zstd")).toBe("gzip,other");
    // Duplicates collapse and ordering is stable regardless of input order.
    expect(normalizeAcceptEncoding("br, gzip, br")).toBe("br,gzip");
    expect(normalizeAcceptEncoding("gzip, br")).toBe(normalizeAcceptEncoding("br, gzip"));

    expect(normalizeCacheControl(null)).toBeNull();
    expect(normalizeCacheControl("")).toBeNull();
    expect(normalizeCacheControl("max-age=31536000, immutable")).toBe("immutable,max-age");
    expect(normalizeCacheControl("no-store")).toBe("no-store");
    expect(normalizeCacheControl("public, s-maxage=60")).toBe("public,s-maxage");
    expect(normalizeCacheControl("surrogate-key=abc123")).toBe("other");

    expect(normalizeContentType(null)).toBeNull();
    expect(normalizeContentType("   ")).toBeNull();
    expect(normalizeContentType("text/html; charset=utf-8")).toBe("text/html");
    expect(normalizeContentType("TEXT/CSS")).toBe("text/css");
    expect(normalizeContentType("text/event-stream")).toBe("text/event-stream");
    expect(normalizeContentType("application/json")).toBe("application/json");
    expect(normalizeContentType("image/avif")).toBe("image");
    expect(normalizeContentType("font/woff2")).toBe("font");
    expect(normalizeContentType("audio/mpeg")).toBe("audio");
    expect(normalizeContentType("video/mp4")).toBe("video");
    expect(normalizeContentType("application/x-tar")).toBe("other");

    // An unavailable protocol must stay distinguishable from an unrecognised
    // one; `WKWebView` with no navigation entry sends null, and a cross-origin
    // navigation without `Timing-Allow-Origin` sends "".
    expect(normalizeNextHopProtocol(null)).toBeNull();
    expect(normalizeNextHopProtocol(undefined)).toBeNull();
    expect(normalizeNextHopProtocol("")).toBeNull();
    expect(normalizeNextHopProtocol("   ")).toBeNull();
    expect(normalizeNextHopProtocol(42)).toBeNull();
    expect(normalizeNextHopProtocol("H2")).toBe("h2");
    expect(normalizeNextHopProtocol("http/1.1")).toBe("http/1.1");
    expect(normalizeNextHopProtocol("quic")).toBe("quic");
    expect(normalizeNextHopProtocol("spdy/3")).toBe("other");
  });



  test("truncates to a byte budget on UTF-8 boundaries without inventing characters", () => {
    expect(truncateUtf8("abc", 8)).toBe("abc");
    expect(truncateUtf8("abcdef", 3)).toBe("abc");
    // Multi-byte sequences are dropped whole rather than decoded to U+FFFD.
    expect(truncateUtf8("€uro", 2)).toBe("");
    expect(truncateUtf8("a€", 2)).toBe("a");
    expect(truncateUtf8("a€", 3)).toBe("a");
    expect(truncateUtf8("a€", 4)).toBe("a€");
    expect(truncateUtf8("💣x", 4)).toBe("💣");
    for (const maxBytes of [1, 2, 3]) {
      expect(truncateUtf8("💣x", maxBytes)).toBe("");
    }
    // A U+FFFD the caller actually sent must survive, which post-hoc stripping
    // of a trailing replacement character could not guarantee.
    expect(truncateUtf8("ab�zz", 5)).toBe("ab�");
    expect(truncateUtf8("�", 3)).toBe("�");
    // The result never exceeds the budget and is always valid UTF-8.
    for (const value of ["💣💣💣", "aé€💣", "��"]) {
      for (let maxBytes = 0; maxBytes <= Buffer.byteLength(value); maxBytes += 1) {
        const truncated = truncateUtf8(value, maxBytes);
        expect(Buffer.byteLength(truncated)).toBeLessThanOrEqual(maxBytes);
        expect(truncated).toBe(Buffer.from(truncated).toString("utf8"));
        expect(value.startsWith(truncated)).toBe(true);
      }
    }
  });



  test("bounds and normalizes route status, encoding, and retained header metrics", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(299, {
        "content-encoding": "private-experimental-encoding",
        "content-type": "text/plain; charset=utf-8",
        // A proxied origin can return any header at all, so the retained
        // cache-control label has to survive an unrecognised directive and a
        // value-carrying one without keeping either verbatim.
        "cache-control": "max-age=31536000, immutable, surrogate-key=private-value",
      });
      response.end("proxy-body");
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const acceptEncoding = "private-accept-value-".repeat(20);
    const response = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/metrics`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": acceptEncoding,
        },
      },
    );
    expect(response.status).toBe(299);
    expect(response.body).toBe("proxy-body");

    const metrics = await readGatewayMetrics(info);
    expect(metrics.routes["proxy-loopback"]).toMatchObject({
      requests: 1,
      responseBytes: Buffer.byteLength("proxy-body"),
      statusCodes: { "299": 1 },
      encodings: { other: 1 },
    });
    const sample = metrics.recentRouteSamples.find((candidate) => (
      candidate.route === "proxy-loopback"
    ));
    expect(sample).toMatchObject({
      method: "GET",
      httpVersion: "1.1",
      statusCode: 299,
      responseBytes: Buffer.byteLength("proxy-body"),
      contentEncoding: "other",
      // Parameters are stripped and unrecognised directives bucketed, so no
      // origin-supplied value is retained.
      cacheControl: "immutable,max-age,other",
      contentType: "text/plain",
    });
    expect(sample?.acceptEncoding).toBe("other");
    expect(JSON.stringify(sample)).not.toContain("private-value");
    expect(JSON.stringify(sample)).not.toContain("private-accept-value");
    expect(Object.keys(metrics.routes["proxy-loopback"]!.encodings)).toEqual(["other"]);
    expect(metrics.compression.configuredMode).toBe("body");
  });



  test("serializes invoke results once and keeps command metrics private and bounded", async () => {
    let resultSerializations = 0;
    let errorSerializations = 0;
    const secretLikeUnknown = "AValidLookingSecretToken1234567890";
    const backend = {
      invoke: mock(async (command: string) => {
        if (command === "serialize_once") {
          return {
            toJSON() {
              resultSerializations += 1;
              return { ok: true };
            },
          };
        }
        if (command === secretLikeUnknown) {
          throw new Error(`Unknown backend command: ${command}`);
        }
        if (command === "serialize_error_once") {
          throw {
            toString() {
              errorSerializations += 1;
              return "backend failed";
            },
          };
        }
        return null;
      }),
    };
    const { info } = await startGateway({ backend });
    const endpoint = `${info.url}__orkestrator/invoke`;
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };
    const invoke = (command: string) => requestUrl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ command }),
    });

    const success = await invoke("serialize_once");
    expect(success.status).toBe(200);
    expect(success.body).toBe('{"result":{"ok":true}}');
    expect(resultSerializations).toBe(1);

    const failure = await invoke("serialize_error_once");
    expect(failure.status).toBe(500);
    expect(failure.body).toBe('{"error":"backend failed"}');
    expect(errorSerializations).toBe(1);

    expect((await invoke(secretLikeUnknown)).status).toBe(500);
    expect((await invoke(`${"x".repeat(10_000)} secret`)).status).toBe(200);

    // Exercise both aggregate label-byte and map-count overflow. All of these
    // commands are accepted by the test backend, just as registered commands
    // are by production. 96-byte labels exhaust the 32 KiB byte budget well
    // before the 512-entry count budget, so this drives the byte bound.
    for (let index = 0; index < 400; index += 1) {
      const padded = `command_${String(index).padStart(3, "0")}_${"x".repeat(74)}`;
      expect((await invoke(padded)).status).toBe(200);
    }

    const metrics = await readGatewayMetrics(info);
    const keys = Object.keys(metrics.commands);
    expect(keys).toContain("__unknown__");
    expect(keys).toContain("__invalid__");
    expect(keys).toContain("__overflow__");
    expect(keys).not.toContain(secretLikeUnknown);
    expect(keys.every((key) => !key.includes("secret"))).toBe(true);
    expect(keys.length).toBeLessThanOrEqual(GATEWAY_COMMAND_METRIC_MAP_LIMIT);
    expect(keys.every((key) => Buffer.byteLength(key) <= 96)).toBe(true);
    expect(keys.reduce((total, key) => total + Buffer.byteLength(key), 0))
      .toBeLessThanOrEqual(GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES);

    const successBody = '{"result":{"ok":true}}';
    expect(metrics.commands.serialize_once).toMatchObject({
      count: 1,
      requestBytes: Buffer.byteLength(JSON.stringify({ command: "serialize_once" })),
      responseBytes: Buffer.byteLength(successBody),
      failures: 0,
    });
    expect(metrics.commands.serialize_error_once).toMatchObject({
      count: 1,
      responseBytes: Buffer.byteLength('{"error":"backend failed"}'),
      failures: 1,
    });
    expect(metrics.commands.__unknown__).toMatchObject({ count: 1, failures: 1 });
  });



  test("treats a loopback browser listener as remote for compression rollout while control stays identity", async () => {
    const { info } = await startGateway({
      bindAddress: "127.0.0.1",
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      compression: "on",
    });
    expect(info.browserUrl).toBeTruthy();

    await requestUrl(`${info.url}__orkestrator/status`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    await requestUrl(`${info.browserUrl!}__orkestrator/status`, {
      headers: { authorization: `Bearer ${info.token}` },
    });

    const metrics = await requestUrl(`${info.url}__orkestrator/metrics`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    const samples = ((metrics.json() as {
      recentRouteSamples: Array<{
        route: string;
        listenerKind: string;
        effectiveCompressionMode: string;
      }>;
    }).recentRouteSamples)
      .filter((sample) => sample.route === "status");

    expect(samples).toContainEqual(expect.objectContaining({
      listenerKind: "control",
      effectiveCompressionMode: "off",
    }));
    expect(samples).toContainEqual(expect.objectContaining({
      listenerKind: "browser",
      effectiveCompressionMode: "on",
    }));
  });



  test("serves static renderer files and blocks traversal outside the renderer root", async () => {
    const dataDir = await createTempDir("ork-gateway-static-");
    const rendererRoot = await createRendererRoot(dataDir, "<main>app</main>");
    await writeFile(path.join(rendererRoot, "asset.js"), "console.log('asset');");
    const { info } = await startGateway({ dataDir, rendererRoot });

    const index = await requestUrl(`${info.url}`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(index.status).toBe(200);
    expect(index.body).toBe("<main>app</main>");

    const asset = await requestUrl(`${info.url}asset.js`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");

    const spaFallback = await requestUrl(`${info.url}settings/repositories`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.body).toBe("<main>app</main>");

    const traversal = await requestUrl(`${info.url}%2e%2e%2fpackage.json`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    expect(traversal.status).toBe(403);
  });

});

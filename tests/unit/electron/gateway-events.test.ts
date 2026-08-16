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



describe("gateway terminal WebSocket", () => {
  test("rejects missing origins and unsupported protocol versions before upgrade", async () => {
    const terminalGateway = new TerminalWebSocketGateway({
      backend: { invoke: async () => undefined },
      tokenMatches: (request) => Boolean(request.headers.cookie),
      originAllowed: () => true,
      logger: createLogger(),
    });
    const rejectedStatus = (protocol: string, headers: IncomingHttpHeaders = {}) => {
      let response = "";
      const socket = {
        end: mock((chunk: string) => { response = chunk; }),
        destroy: mock(() => undefined),
      } as unknown as Duplex;
      terminalGateway.handleUpgrade({
        url: "/__orkestrator/terminal",
        headers: { "sec-websocket-protocol": protocol, ...headers },
      } as IncomingMessage, socket, Buffer.alloc(0));
      return Number.parseInt(response.split("\r\n", 1)[0]?.split(" ")[1] ?? "0", 10);
    };

    expect(rejectedStatus(TERMINAL_WEBSOCKET_SUBPROTOCOL, { cookie: "auth-cookie" })).toBe(403);
    const deniedOriginGateway = new TerminalWebSocketGateway({
      backend: { invoke: async () => undefined },
      tokenMatches: () => false,
      originAllowed: () => false,
      logger: createLogger(),
    });
    let deniedOriginResponse = "";
    const deniedOriginSocket = {
      end: mock((chunk: string) => { deniedOriginResponse = chunk; }),
      destroy: mock(() => undefined),
    } as unknown as Duplex;
    deniedOriginGateway.handleUpgrade({
      url: "/__orkestrator/terminal",
      headers: {
        origin: "https://attacker.invalid",
        "sec-websocket-protocol": TERMINAL_WEBSOCKET_SUBPROTOCOL,
      },
    } as IncomingMessage, deniedOriginSocket, Buffer.alloc(0));
    expect(deniedOriginResponse).toStartWith("HTTP/1.1 403");
    deniedOriginGateway.close();
    expect(rejectedStatus("orkestrator-terminal.v999")).toBe(426);
    let malformedResponse = "";
    const malformedSocket = {
      end: mock((chunk: string) => { malformedResponse = chunk; }),
      destroy: mock(() => undefined),
    } as unknown as Duplex;
    expect(() => terminalGateway.handleUpgrade({
      url: "//[",
      headers: {},
    } as IncomingMessage, malformedSocket, Buffer.alloc(0))).not.toThrow();
    expect(malformedResponse).toStartWith("HTTP/1.1 400");
    terminalGateway.close();
  });

  test("bounds unauthenticated sockets and accepts a same-origin auth cookie", async () => {
    const { gateway, info } = await startGateway();
    const terminalWebSocket = (gateway as unknown as {
      terminalWebSocket: { authTimeoutMs: number };
    }).terminalWebSocket;
    terminalWebSocket.authTimeoutMs = 15;

    const unauthenticated = await openTerminalSocket(info, { authenticate: false });
    const timedOut = new Promise<number>((resolve) => unauthenticated.socket.once("close", resolve));
    expect(await timedOut).toBe(TERMINAL_WEBSOCKET_CLOSE.authenticationRequired);

    const origin = new URL(info.url).origin;
    const cookieAuthenticated = await openTerminalSocket(info, {
      authenticate: false,
      headers: {
        Origin: origin,
        Cookie: `orkestrator_gateway_auth=${info.token}`,
      },
    });
    expect(await nextTerminalControl(cookieAuthenticated.inbox, "ready"))
      .toMatchObject({ type: "ready", version: 1 });
    cookieAuthenticated.socket.terminate();
  });

  test("rejects malformed, oversized, and wrong-direction frames with assigned close codes", async () => {
    const { info } = await startGateway();
    for (const [payload, expected] of [
      ["{", TERMINAL_WEBSOCKET_CLOSE.protocolError],
      ["x".repeat(TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES + 1), TERMINAL_WEBSOCKET_CLOSE.messageTooLarge],
    ] as const) {
      const { socket } = await openTerminalSocket(info);
      const closed = new Promise<number>((resolve) => socket.once("close", resolve));
      socket.send(payload);
      expect(await closed).toBe(expected);
    }

    const { socket } = await openTerminalSocket(info);
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 1,
      generation: 1,
      revision: 1,
      bytes: new Uint8Array(),
    }));
    expect(await closed).toBe(TERMINAL_WEBSOCKET_CLOSE.protocolError);

    const truncated = await openTerminalSocket(info);
    const truncatedClose = new Promise<number>((resolve) => truncated.socket.once("close", resolve));
    truncated.socket.send(new Uint8Array([TERMINAL_BINARY_FRAME_TYPE.input]));
    expect(await truncatedClose).toBe(TERMINAL_WEBSOCKET_CLOSE.protocolError);

    const unsupported = await openTerminalSocket(info, { authenticate: false });
    const unsupportedClose = new Promise<number>((resolve) => unsupported.socket.once("close", resolve));
    unsupported.socket.send(JSON.stringify({ type: "authenticate", version: 2, token: info.token }));
    expect(await unsupportedClose).toBe(TERMINAL_WEBSOCKET_CLOSE.unsupportedVersion);

    const repeated = await openTerminalSocket(info);
    const repeatedClose = new Promise<number>((resolve) => repeated.socket.once("close", resolve));
    repeated.socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
    expect(await repeatedClose).toBe(TERMINAL_WEBSOCKET_CLOSE.protocolError);
  });

  test("escalates repeated unknown channels and reports generation and oversized-output desync", async () => {
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_terminal_session") return { id: args.sessionId, running: true };
        if (command === "get_terminal_output_snapshot") return { output: "", generation: 1, revision: 0 };
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const generationSocket = await openTerminalSocket(info);
    generationSocket.socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "generation" }));
    const generationChannel = await nextTerminalControl(generationSocket.inbox, "subscribed");
    if (generationChannel.type !== "subscribed") throw new Error("Expected subscribed frame");
    gateway.emit("terminal-output-generation", { text: "new generation", generation: 2, revision: 1 });
    expect(await nextTerminalControl(generationSocket.inbox, "desync"))
      .toMatchObject({ reason: "generation-changed", generation: 2 });
    generationSocket.socket.terminate();

    const oversizedSocket = await openTerminalSocket(info);
    oversizedSocket.socket.send(JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "oversized" }));
    await nextTerminalControl(oversizedSocket.inbox, "subscribed");
    gateway.emit("terminal-output-oversized", {
      text: "x".repeat(TERMINAL_WEBSOCKET_MAX_BINARY_BYTES), generation: 1, revision: 1,
    });
    expect(await nextTerminalControl(oversizedSocket.inbox, "desync"))
      .toMatchObject({ reason: "slow-consumer" });
    oversizedSocket.socket.terminate();

    const unknownSocket = await openTerminalSocket(info);
    const unknownClose = new Promise<number>((resolve) => unknownSocket.socket.once("close", resolve));
    unknownSocket.socket.send(JSON.stringify({
      type: "resize", channelId: 99, operationId: 1, cols: 80, rows: 24,
    }));
    expect(await nextTerminalControl(unknownSocket.inbox, "operation-result"))
      .toMatchObject({ channelId: 99, operationId: 1, operation: "resize", ok: false });
    for (let operationId = 2; operationId <= 3; operationId += 1) {
      unknownSocket.socket.send(JSON.stringify({
        type: "resize", channelId: 99, operationId, cols: 80, rows: 24,
      }));
    }
    expect(await unknownClose).toBe(TERMINAL_WEBSOCKET_CLOSE.policyViolation);
  });

  test("reports current, duplicate, unavailable, failed, unsubscribe, and desync subscription paths", async () => {
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        const sessionId = String(args.sessionId);
        if (sessionId === "failed") throw new Error("backend failed");
        if (command === "get_terminal_session") return { id: sessionId, running: sessionId !== "missing" };
        if (command === "get_terminal_output_snapshot") {
          if (sessionId === "missing") return { output: "", generation: 0, revision: 0 };
          return { mode: "delta", output: "", deltas: [], generation: 3, revision: 4 };
        }
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    socket.send(JSON.stringify({
      type: "subscribe", requestId: 1, sessionId: "current", knownGeneration: 3, knownRevision: 4,
    }));
    const current = await nextTerminalControl(inbox, "subscribed");
    expect(current).toMatchObject({ requestId: 1, recovery: "current" });
    if (current.type !== "subscribed") throw new Error("Expected subscribed frame");

    socket.send(JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "current" }));
    expect(await nextTerminalControl(inbox, "error"))
      .toMatchObject({ code: "subscription-denied", requestId: 2 });
    socket.send(JSON.stringify({ type: "subscribe", requestId: 3, sessionId: "missing" }));
    expect(await nextTerminalControl(inbox, "error"))
      .toMatchObject({ code: "subscription-denied", requestId: 3 });
    socket.send(JSON.stringify({ type: "subscribe", requestId: 4, sessionId: "failed" }));
    expect(await nextTerminalControl(inbox, "error"))
      .toMatchObject({ code: "terminal-unavailable", requestId: 4 });

    gateway.emit("terminal-output-current", { text: "gap", generation: 3, revision: 6 });
    expect(await nextTerminalControl(inbox, "desync"))
      .toMatchObject({ channelId: current.channelId, reason: "revision-gap", revision: 6 });
    socket.send(JSON.stringify({ type: "unsubscribe", channelId: current.channelId }));
    expect(await nextTerminalControl(inbox, "unsubscribed"))
      .toMatchObject({ channelId: current.channelId });
    socket.send(JSON.stringify({
      type: "subscribe", requestId: 5, sessionId: "current", knownGeneration: 3, knownRevision: 4,
    }));
    expect(await nextTerminalControl(inbox, "subscribed"))
      .toMatchObject({ requestId: 5, sessionId: "current", recovery: "current" });
    socket.terminate();
  });

  test("announces reconciliation overflow only after the channel mapping", async () => {
    let releaseSnapshot!: () => void;
    const snapshotBlocked = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let snapshotStarted = false;
    const backend = {
      invoke: mock(async (command: string) => {
        if (command === "get_terminal_session") return { id: "race", running: true };
        if (command === "get_terminal_output_snapshot") {
          snapshotStarted = true;
          await snapshotBlocked;
          return { output: "", generation: 1, revision: 0 };
        }
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "race" }));
    await waitUntil(() => snapshotStarted, "snapshot did not start");
    for (let revision = 1; revision <= 40; revision += 1) {
      gateway.emit("terminal-output-race", {
        text: "x".repeat(16 * 1024), generation: 1, revision,
      });
    }
    releaseSnapshot();
    expect(await nextTerminalControl(inbox, "subscribed"))
      .toMatchObject({ requestId: 1, sessionId: "race" });
    expect(await nextTerminalControl(inbox, "desync"))
      .toMatchObject({ reason: "slow-consumer" });
    socket.terminate();
  });

  test("acknowledges rejected operations and bounds a blocked per-session queue", async () => {
    let releaseWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const backend = {
      invoke: mock(async (command: string) => {
        if (command === "get_terminal_session") return { id: "ops", running: true };
        if (command === "get_terminal_output_snapshot") return { output: "", generation: 1, revision: 0 };
        if (command === "terminal_resize") throw new Error("sensitive backend detail");
        if (command === "terminal_write") await blockedWrite;
        return undefined;
      }),
    };
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "ops" }));
    const subscribed = await nextTerminalControl(inbox, "subscribed");
    if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");

    socket.send(JSON.stringify({
      type: "resize", channelId: subscribed.channelId, operationId: 9, cols: 80, rows: 24,
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toEqual({
      type: "operation-result",
      channelId: subscribed.channelId,
      operationId: 9,
      operation: "resize",
      ok: false,
      message: "Terminal operation failed",
    });

    for (let revision = 1; revision <= 257; revision += 1) {
      socket.send(encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.input,
        channelId: subscribed.channelId,
        generation: 1,
        revision,
        bytes: new Uint8Array(),
      }));
    }
    let saturated: TerminalWebSocketServerControlFrame | undefined;
    while (!saturated) {
      const frame = await nextTerminalControl(inbox, "operation-result");
      if (frame.type === "operation-result" && frame.operationId === 257) saturated = frame;
    }
    expect(saturated).toMatchObject({ operation: "input", ok: false, message: "Terminal operation queue is full" });
    releaseWrite();
    socket.terminate();
  });

  test("bounds aggregate operation bytes across independently blocked sessions", async () => {
    let releaseWrites!: () => void;
    const blockedWrites = new Promise<void>((resolve) => { releaseWrites = resolve; });
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_terminal_session") return { id: args.sessionId, running: true };
        if (command === "get_terminal_output_snapshot") return { output: "", generation: 1, revision: 0 };
        if (command === "terminal_write") await blockedWrites;
        return undefined;
      }),
    };
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    const channels: number[] = [];
    for (let requestId = 1; requestId <= 33; requestId += 1) {
      socket.send(JSON.stringify({ type: "subscribe", requestId, sessionId: `aggregate-${requestId}` }));
      const subscribed = await nextTerminalControl(inbox, "subscribed");
      if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
      channels.push(subscribed.channelId);
    }
    const payload = new Uint8Array(
      TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
    );
    for (const channelId of channels) {
      socket.send(encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.input,
        channelId,
        generation: 1,
        revision: 1,
        bytes: payload,
      }));
    }
    let aggregateResult: TerminalWebSocketServerControlFrame | undefined;
    while (!aggregateResult) {
      const frame = await nextTerminalControl(inbox, "operation-result");
      if (frame.type === "operation-result" && frame.channelId === channels.at(-1)) {
        aggregateResult = frame;
      }
    }
    expect(aggregateResult).toMatchObject({
      operation: "input",
      operationId: 1,
      ok: false,
      message: "Terminal operation queue is full",
    });
    releaseWrites();
    socket.terminate();
  });

  test("closes active sockets on credential rotation and gateway shutdown", async () => {
    const { gateway, info } = await startGateway({ env: {} });
    const active = await openTerminalSocket(info);
    const revoked = new Promise<void>((resolve) => active.socket.once("close", () => resolve()));
    const replacement = "replacement-token-123456";
    await gateway.setToken(replacement);
    await revoked;

    const replacementSocket = await openTerminalSocket({ ...info, token: replacement });
    const stopped = new Promise<void>((resolve) => replacementSocket.socket.once("close", () => resolve()));
    await gateway.stop();
    await stopped;
  });

  test("authenticates direct sockets and rejects a bad first credential", async () => {
    const { info } = await startGateway();
    const socketUrl = `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`;
    const socket = new WebSocket(socketUrl, TERMINAL_WEBSOCKET_SUBPROTOCOL);
    const inbox = websocketInbox(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token: "wrong-token-value" }));
    const error = await nextTerminalControl(inbox, "error");
    expect(error).toMatchObject({ type: "error", code: "authentication-required", fatal: true });
    socket.terminate();
  });

  test("answers a stale generation or sequence per channel without closing the socket", async () => {
    const backend = {
      invoke: mock(async (command: string) => {
        if (command === "get_terminal_session") return { running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0, truncated: false };
        }
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);

    socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "stale" }));
    const stale = await nextTerminalControl(inbox, "subscribed");
    if (stale.type !== "subscribed") throw new Error("Expected subscribed frame");
    socket.send(JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "healthy" }));
    const healthy = await nextTerminalControl(inbox, "subscribed");
    if (healthy.type !== "subscribed") throw new Error("Expected subscribed frame");

    // A client legitimately adopts a newer generation from an authoritative
    // snapshot before this channel hears about the restart. Treating that as a
    // protocol violation would tear down every other terminal on the socket.
    socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: stale.channelId,
      generation: 2,
      revision: 1,
      bytes: new TextEncoder().encode("x"),
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({
      channelId: stale.channelId, operationId: 1, operation: "input", ok: false,
    });
    expect(await nextTerminalControl(inbox, "desync")).toMatchObject({
      channelId: stale.channelId, reason: "generation-changed", generation: 2,
    });

    // A non-increasing sequence is at worst a duplicate, not a violation.
    socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: healthy.channelId,
      generation: 1,
      revision: 5,
      bytes: new TextEncoder().encode("first"),
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({
      channelId: healthy.channelId, operationId: 5, ok: true,
    });
    socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: healthy.channelId,
      generation: 1,
      revision: 5,
      bytes: new TextEncoder().encode("replay"),
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({
      channelId: healthy.channelId, operationId: 5, ok: false,
    });

    // The untouched channel is still live on the still-open socket.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    gateway.emit("terminal-output-healthy", { text: "alive", generation: 1, revision: 1 });
    while (true) {
      const message = await inbox.next();
      if (!message.binary) continue;
      const frame = decodeTerminalBinaryFrame(message.data);
      expect(frame.channelId).toBe(healthy.channelId);
      expect(new TextDecoder().decode(frame.bytes)).toBe("alive");
      break;
    }
    socket.terminate();
  });

  test("refuses to acknowledge input a backend command could not deliver", async () => {
    const backend = {
      invoke: mock(async (command: string) => {
        if (command === "get_terminal_session") return { running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0, truncated: false };
        }
        // The shell exited between the snapshot and this write.
        if (command === "terminal_write" || command === "terminal_resize") {
          return { delivered: false };
        }
        return undefined;
      }),
    };
    const { info } = await startGateway({ backend });
    const { socket, inbox } = await openTerminalSocket(info);
    socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "gone" }));
    const subscribed = await nextTerminalControl(inbox, "subscribed");
    if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");

    socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: subscribed.channelId,
      generation: 1,
      revision: 1,
      bytes: new TextEncoder().encode("ls\r"),
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({
      operation: "input", ok: false, message: "Terminal session is not running",
    });

    socket.send(JSON.stringify({
      type: "resize", channelId: subscribed.channelId, operationId: 9, cols: 80, rows: 24,
    }));
    expect(await nextTerminalControl(inbox, "operation-result")).toMatchObject({
      operationId: 9, operation: "resize", ok: false, message: "Terminal session is not running",
    });
    socket.terminate();
  });

  test("does no per-event work when no terminal socket is attached", async () => {
    const terminalGateway = new TerminalWebSocketGateway({
      backend: { invoke: mock(async () => undefined) },
      tokenMatches: () => true,
      originAllowed: () => true,
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
    });
    let payloadRead = false;
    // Terminal output is the highest-volume event in the system and the
    // transport is opt-in, so the no-socket case must not decode the payload.
    terminalGateway.emit("terminal-output-idle", {
      generation: 1,
      revision: 1,
      get text() {
        payloadRead = true;
        return "expensive";
      },
    });
    expect(payloadRead).toBe(false);
    terminalGateway.close();
  });

  test("releases a socket that never answers the close handshake", async () => {
    const backend = { invoke: mock(async () => undefined) };
    const { info } = await startGateway({ backend });
    const target = new URL(info.url);

    // `ws` always answers a close frame, and pausing it is a no-op under Bun,
    // so a genuinely unresponsive peer needs a raw socket that performs the
    // handshake by hand and then simply never replies.
    const raw = netConnect({
      host: target.hostname,
      port: Number(target.port),
    });
    await new Promise<void>((resolve, reject) => {
      raw.once("connect", resolve);
      raw.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
    raw.write(
      `GET /__orkestrator/terminal HTTP/1.1\r\n`
      + `Host: ${target.host}\r\n`
      + `Upgrade: websocket\r\nConnection: Upgrade\r\n`
      + `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n`
      + `Sec-WebSocket-Version: 13\r\n`
      + `Sec-WebSocket-Protocol: ${TERMINAL_WEBSOCKET_SUBPROTOCOL}\r\n`
      // An origin-less upgrade that already carries a credential is refused, so
      // this has to look like the browser client it is standing in for.
      + `Origin: http://${target.host}\r\n`
      + `Authorization: Bearer ${info.token}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        if (!chunk.toString("latin1").includes("101")) return;
        raw.off("data", onData);
        resolve();
      };
      raw.on("data", onData);
      raw.once("error", reject);
    });

    // A malformed control frame makes the gateway close. The peer never
    // answers, so only the forced-termination backstop can release this.
    const payload = Buffer.from("not json", "utf8");
    const mask = randomBytes(4);
    const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
    raw.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.byteLength]), mask, masked]));

    await Promise.race([
      closed,
      new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("Socket was never force-released")), 3_000);
      }),
    ]);
    raw.destroy();
  });

  test("rejects an upgrade whose request the WebSocket server refuses", async () => {
    const warnings: string[] = [];
    const terminalGateway = new TerminalWebSocketGateway({
      backend: { invoke: mock(async () => undefined) },
      tokenMatches: () => true,
      originAllowed: () => true,
      logger: { debug: (message: string) => warnings.push(message), warn: () => {}, error: () => {} },
    });
    const written: string[] = [];
    let destroyed = false;
    const socket = {
      destroyed: false,
      end: (chunk: string) => written.push(chunk),
      destroy: () => { destroyed = true; },
      once: () => undefined,
      removeListener: () => undefined,
    } as unknown as Duplex;
    // `ws` throws on a request with no key rather than returning a status, and
    // that must not escape the listener's upgrade callback.
    const handled = terminalGateway.handleUpgrade({
      url: "/__orkestrator/terminal",
      headers: {
        origin: "http://localhost",
        "sec-websocket-protocol": TERMINAL_WEBSOCKET_SUBPROTOCOL,
      },
    } as unknown as IncomingMessage, socket, Buffer.alloc(0));

    expect(handled).toBe(true);
    // The listener's upgrade callback must not see this throw, and the socket
    // must not be left attached and idle.
    expect(warnings).toContain("[TerminalWebSocket] Upgrade rejected");
    expect(destroyed || written.some((chunk) => chunk.includes("400"))).toBe(true);
    terminalGateway.close();
  });

  test("multiplexes isolated terminal channels, raw input, resize, and retained replay", async () => {
    const terminalState = new Map([
      ["session-a", { generation: 1, revision: 0, deltas: [] as Array<{ revision: number; text: string }> }],
      ["session-b", { generation: 7, revision: 0, deltas: [] as Array<{ revision: number; text: string }> }],
    ]);
    const operations: Array<{ command: string; args: Record<string, unknown> }> = [];
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        operations.push({ command, args });
        const state = terminalState.get(String(args.sessionId));
        if (command === "get_terminal_session") return { id: args.sessionId, running: Boolean(state) };
        if (command === "get_terminal_output_snapshot") {
          if (!state) return { output: "", generation: 0, revision: 0, truncated: false };
          const knownGeneration = args.sinceGeneration;
          const knownRevision = args.sinceRevision;
          if (knownGeneration === state.generation && typeof knownRevision === "number") {
            const deltas = state.deltas.filter((entry) => entry.revision > knownRevision);
            return {
              mode: "delta",
              output: deltas.map((entry) => entry.text).join(""),
              deltas,
              generation: state.generation,
              revision: state.revision,
              truncated: false,
            };
          }
          return { output: "", generation: state.generation, revision: state.revision, truncated: false };
        }
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const connect = async () => {
      const socket = new WebSocket(
        `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`,
        TERMINAL_WEBSOCKET_SUBPROTOCOL,
      );
      const inbox = websocketInbox(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
      expect(await nextTerminalControl(inbox, "ready")).toMatchObject({ type: "ready", version: 1 });
      return { socket, inbox };
    };

    const first = await connect();
    first.socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "session-a" }));
    const subscribedA = await nextTerminalControl(first.inbox, "subscribed");
    expect(subscribedA).toMatchObject({ type: "subscribed", sessionId: "session-a", recovery: "snapshot-required" });
    if (subscribedA.type !== "subscribed") throw new Error("Expected subscribed frame");

    first.socket.send(JSON.stringify({ type: "subscribe", requestId: 2, sessionId: "session-b" }));
    const subscribedB = await nextTerminalControl(first.inbox, "subscribed");
    if (subscribedB.type !== "subscribed") throw new Error("Expected subscribed frame");

    const outputA = { text: "alpha", generation: 1, revision: 1 };
    const outputB = { text: "beta", generation: 7, revision: 1 };
    terminalState.get("session-a")!.revision = 1;
    terminalState.get("session-a")!.deltas.push({ revision: 1, text: "alpha" });
    terminalState.get("session-b")!.revision = 1;
    terminalState.get("session-b")!.deltas.push({ revision: 1, text: "beta" });
    gateway.emit("terminal-output-session-a", outputA);
    gateway.emit("terminal-output-session-b", outputB);
    const binaryFrames = [];
    while (binaryFrames.length < 2) {
      const message = await first.inbox.next();
      if (message.binary) binaryFrames.push(decodeTerminalBinaryFrame(message.data));
    }
    expect(binaryFrames.map((frame) => [frame.channelId, new TextDecoder().decode(frame.bytes)]).sort())
      .toEqual([
        [subscribedA.channelId, "alpha"],
        [subscribedB.channelId, "beta"],
      ].sort());

    first.socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: subscribedA.channelId,
      generation: 1,
      revision: 1,
      bytes: new TextEncoder().encode("pwd\r"),
    }));
    first.socket.send(JSON.stringify({
      type: "resize",
      channelId: subscribedA.channelId,
      operationId: 2,
      cols: 120,
      rows: 40,
    }));
    await waitUntil(
      () => operations.some((entry) => entry.command === "terminal_resize"),
      "terminal input and resize were not routed",
    );
    expect(operations).toContainEqual({ command: "terminal_write", args: { sessionId: "session-a", data: "pwd\r" } });
    expect(operations).toContainEqual({ command: "terminal_resize", args: { sessionId: "session-a", cols: 120, rows: 40 } });
    expect(await nextTerminalControl(first.inbox, "operation-result"))
      .toMatchObject({ operation: "input", operationId: 1, ok: true });
    expect(await nextTerminalControl(first.inbox, "operation-result"))
      .toMatchObject({ operation: "resize", operationId: 2, ok: true });

    first.socket.terminate();
    expect(operations.some((entry) => entry.command === "detach_terminal" || entry.command === "close_local_terminal_session")).toBe(false);

    const second = await connect();
    second.socket.send(JSON.stringify({
      type: "subscribe",
      requestId: 3,
      sessionId: "session-a",
      knownGeneration: 1,
      knownRevision: 0,
    }));
    expect(await nextTerminalControl(second.inbox, "subscribed")).toMatchObject({ recovery: "delta", baseRevision: 0, targetRevision: 1 });
    let replay;
    do {
      const message = await second.inbox.next();
      if (message.binary) replay = decodeTerminalBinaryFrame(message.data);
    } while (!replay);
    expect(new TextDecoder().decode(replay.bytes)).toBe("alpha");
    expect(replay.revision).toBe(1);

    second.socket.send(JSON.stringify({ type: "subscribe", requestId: 4, sessionId: "session-b" }));
    const secondSubscribedB = await nextTerminalControl(second.inbox, "subscribed");
    if (secondSubscribedB.type !== "subscribed") throw new Error("Expected subscribed frame");
    // Fill only A's application queue before its scheduled flush. Crossing the
    // per-channel soft limit must desync A without preventing B's next frame.
    for (let revision = 2; revision <= 40; revision += 1) {
      const text = "x".repeat(16 * 1024);
      terminalState.get("session-a")!.revision = revision;
      terminalState.get("session-a")!.deltas.push({ revision, text });
      gateway.emit("terminal-output-session-a", { text, generation: 1, revision });
    }
    terminalState.get("session-b")!.revision = 2;
    terminalState.get("session-b")!.deltas.push({ revision: 2, text: "still-fast" });
    gateway.emit("terminal-output-session-b", { text: "still-fast", generation: 7, revision: 2 });
    let sawSlowDesync = false;
    let sawFastOutput = false;
    while (!sawSlowDesync || !sawFastOutput) {
      const message = await second.inbox.next();
      if (message.binary) {
        const frame = decodeTerminalBinaryFrame(message.data);
        if (frame.channelId === secondSubscribedB.channelId && new TextDecoder().decode(frame.bytes) === "still-fast") {
          sawFastOutput = true;
        }
      } else {
        const frame = parseTerminalWebSocketServerControlFrame(message.data.toString("utf8"));
        if (frame.type === "desync" && frame.reason === "slow-consumer") sawSlowDesync = true;
      }
    }
    expect(sawSlowDesync).toBe(true);
    expect(sawFastOutput).toBe(true);
    second.socket.terminate();
  });

  test("preserves accepted input order across a socket reconnect", async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const writes: string[] = [];
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_terminal_session") return { id: args.sessionId, running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0, truncated: false };
        }
        if (command === "terminal_write") {
          writes.push(String(args.data));
          if (args.data === "first") await firstWriteBlocked;
        }
        return undefined;
      }),
    };
    const { info } = await startGateway({ backend });
    const connect = async (requestId: number) => {
      const socket = new WebSocket(
        `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`,
        TERMINAL_WEBSOCKET_SUBPROTOCOL,
      );
      const inbox = websocketInbox(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
      await nextTerminalControl(inbox, "ready");
      socket.send(JSON.stringify({ type: "subscribe", requestId, sessionId: "ordered-session" }));
      const subscribed = await nextTerminalControl(inbox, "subscribed");
      if (subscribed.type !== "subscribed") throw new Error("Expected subscribed frame");
      return { socket, channelId: subscribed.channelId };
    };

    const first = await connect(1);
    first.socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: first.channelId,
      generation: 1,
      revision: 1,
      bytes: new TextEncoder().encode("first"),
    }));
    await waitUntil(() => writes.length === 1, "first terminal write did not begin");
    first.socket.terminate();

    const second = await connect(2);
    second.socket.send(encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: second.channelId,
      generation: 1,
      revision: 1,
      bytes: new TextEncoder().encode("second"),
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writes).toEqual(["first"]);
    releaseFirstWrite();
    await waitUntil(() => writes.length === 2, "reconnected terminal write did not run");
    expect(writes).toEqual(["first", "second"]);
    second.socket.terminate();
  });

  test("disconnects a non-reading socket when its aggregate queue reaches the hard limit", async () => {
    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => {
        if (command === "get_terminal_session") return { id: args.sessionId, running: true };
        if (command === "get_terminal_output_snapshot") {
          return { output: "", generation: 1, revision: 0, truncated: false };
        }
        return undefined;
      }),
    };
    const { gateway, info } = await startGateway({ backend });
    const socket = new WebSocket(
      `${info.url.replace(/^http/, "ws")}__orkestrator/terminal`,
      TERMINAL_WEBSOCKET_SUBPROTOCOL,
    );
    const inbox = websocketInbox(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "authenticate", version: 1, token: info.token }));
    await nextTerminalControl(inbox, "ready");
    socket.send(JSON.stringify({ type: "subscribe", requestId: 1, sessionId: "flood" }));
    await nextTerminalControl(inbox, "subscribed");

    const close = new Promise<number>((resolve) => socket.once("close", resolve));
    // Model a non-reading transport whose kernel/write backlog has reached the
    // hard cap. The next frame must disconnect instead of growing the queue.
    const terminalWebSocket = (gateway as unknown as {
      terminalWebSocket: { sockets: Set<{ ws: WebSocket }> };
    }).terminalWebSocket;
    const serverState = [...terminalWebSocket.sockets][0];
    if (!serverState) throw new Error("Expected terminal WebSocket state");
    Object.defineProperty(serverState.ws, "bufferedAmount", {
      configurable: true,
      value: TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES,
    });
    gateway.emit("terminal-output-flood", { text: "x", generation: 1, revision: 1 });
    expect(await close).toBe(TERMINAL_WEBSOCKET_CLOSE.slowConsumer);
  });
});

describe("remote gateway", () => {



  test("negotiates shared compression primitives and excludes precompressed content", async () => {
    expect(negotiateEncoding("gzip, br")).toBe("br");
    expect(negotiateEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(negotiateEncoding("br;q=0, gzip;q=0, identity")).toBe("identity");
    expect(negotiateEncoding("gzip", ["gzip", "identity"])).toBe("gzip");
    expect(isCompressibleContentType("application/json; charset=utf-8")).toBe(true);
    expect(isCompressibleContentType("image/svg+xml")).toBe(true);
    expect(isCompressibleContentType("font/woff2")).toBe(false);
    expect(isCompressibleContentType("image/png")).toBe(false);
    expect(isCompressibleContentType("application/octet-stream")).toBe(false);
    expect(canStartDynamicCompression(MAX_CONCURRENT_DYNAMIC_COMPRESSIONS - 1)).toBe(true);
    expect(canStartDynamicCompression(MAX_CONCURRENT_DYNAMIC_COMPRESSIONS)).toBe(false);

    const source = Buffer.from("shared compression ".repeat(COMPRESSION_MIN_BYTES));
    expect((await compressBody(source, "br")).byteLength).toBeLessThan(source.byteLength);
    expect((await compressBody(source, "gzip")).byteLength).toBeLessThan(source.byteLength);
    expect((await compressBody("shared compression ".repeat(COMPRESSION_MIN_BYTES), "gzip")).byteLength)
      .toBeLessThan(source.byteLength);
  });



  test("compresses eligible invoke bodies above the threshold with Brotli then gzip", async () => {
    const payload = "dynamic invoke body ".repeat(256);
    const { info } = await startGateway({
      compression: "body",
      backend: { invoke: mock(async () => payload) },
    });
    const invoke = (acceptEncoding: string) => requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
        "accept-encoding": acceptEncoding,
      },
      body: JSON.stringify({ command: "large_response", args: {} }),
    });

    const brotli = await invoke("br, gzip");
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(brotli.headers.vary).toContain("Accept-Encoding");
    expect(JSON.parse(decodeResponseBody(brotli))).toEqual({ result: payload });

    const gzip = await invoke("gzip");
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(decodeResponseBody(gzip))).toEqual({ result: payload });

    const identity = await invoke("identity");
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.json()).toEqual({ result: payload });
  });



  test("prefers Brotli, then gzip, then identity for static sibling assets", async () => {
    const dataDir = await createTempDir("ork-static-siblings-");
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

    const brotli = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "br, gzip" },
    });
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(decodeResponseBody(brotli)).toBe("brotli sibling");

    const gzip = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "gzip" },
    });
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(gzip)).toBe("gzip sibling");

    const identity = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "br;q=0, gzip;q=0, identity" },
    });
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toBe("console.log('identity');".repeat(256));
  });



  test("rejects stale compressed siblings and falls back to fresh on-the-fly compression", async () => {
    const dataDir = await createTempDir("ork-static-stale-");
    const rendererRoot = await createRendererRoot(dataDir);
    const assetPath = await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('source body');".repeat(256),
    );
    const staleSibling = await writeCompressedSibling(assetPath, "br", "stale sibling");
    const sourceStat = await stat(assetPath);
    const staleDate = new Date(sourceStat.mtimeMs - 60_000);
    await utimes(staleSibling, staleDate, staleDate);

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const response = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "br",
      },
    });

    expect(response.headers["content-encoding"]).toBe("br");
    expect(decodeResponseBody(response)).toBe("console.log('source body');".repeat(256));
  });



  test("revalidates Last-Modified, serves immutable hashed assets, and keeps the SPA fallback no-cache", async () => {
    const dataDir = await createTempDir("ork-static-cache-");
    const rendererRoot = await createRendererRoot(dataDir, "<!doctype html><div id='root'>index</div>");
    await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('cache');",
    );

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "off" });
    const authorization = { authorization: `Bearer ${info.token}` };

    const assetResponse = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: authorization,
    });
    expect(assetResponse.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const spaResponse = await requestUrl(`${info.url}dashboard`, {
      headers: authorization,
    });
    expect(spaResponse.headers["cache-control"]).toBe("no-cache");
    expect(spaResponse.body).toContain("index");
    expect(spaResponse.headers["last-modified"]).toBeTruthy();

    const notModified = await requestUrl(`${info.url}dashboard`, {
      headers: {
        ...authorization,
        "if-modified-since": String(spaResponse.headers["last-modified"]),
      },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.rawBody.byteLength).toBe(0);
  });



  test("rejects traversal even when compressed sibling lookup is enabled", async () => {
    const dataDir = await createTempDir("ork-static-traversal-");
    const rendererRoot = await createRendererRoot(dataDir);
    await writeFile(path.join(dataDir, "secret.txt"), "do not serve");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const response = await requestUrl(`${info.url}%2e%2e%2fsecret.txt`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "br, gzip",
      },
    });

    expect(response.status).toBe(403);
  });



  test("compresses static assets on the fly when no precompressed siblings exist", async () => {
    const dataDir = await createTempDir("ork-static-fallback-");
    const rendererRoot = await createRendererRoot(dataDir);
    await writeRendererAsset(
      rendererRoot,
      "assets/app-12345678.js",
      "console.log('fallback');".repeat(200),
    );

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const response = await requestUrl(`${info.url}assets/app-12345678.js`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "br, gzip",
      },
    });

    expect(["br", "gzip"]).toContain(response.headers["content-encoding"]);
    expect(decodeResponseBody(response)).toContain("fallback");
  });



  test("bounds on-the-fly compression source bytes and serves oversized assets as identity", async () => {
    const dataDir = await createTempDir("ork-static-fallback-bound-");
    const rendererRoot = await createRendererRoot(dataDir);
    const source = Buffer.alloc(MAX_STATIC_FALLBACK_SOURCE_BYTES + 1, 0x61);
    await writeRendererAsset(rendererRoot, "assets/large-12345678.js", source);

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const response = await requestUrl(`${info.url}assets/large-12345678.js`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "br, gzip",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawBody.byteLength).toBe(source.byteLength);
  });



  test("classifies fallback compression outcomes as compressed, not-beneficial, or declined", async () => {
    const root = await createTempDir("ork-static-outcome-");
    const compressiblePath = path.join(root, "app.js");
    await writeFile(compressiblePath, "console.log('outcome');".repeat(256));
    const compressibleStat = await stat(compressiblePath);
    const incompressiblePath = path.join(root, "tiny.txt");
    await writeFile(incompressiblePath, "x");
    const incompressibleStat = await stat(incompressiblePath);

    expect(await compressStaticFileWithinLimits(
      compressiblePath,
      compressibleStat.mtimeMs,
      compressibleStat.size,
      ["br", "gzip"],
      false,
    )).toMatchObject({ status: "compressed", encoding: "br" });

    // No encoding the client accepts is a property of the request, not of this
    // server's budget, so it must not be reported as a decline.
    expect(await compressStaticFileWithinLimits(
      compressiblePath,
      compressibleStat.mtimeMs,
      compressibleStat.size,
      [],
      false,
    )).toEqual({ status: "not-beneficial" });

    expect(await compressStaticFileWithinLimits(
      incompressiblePath,
      incompressibleStat.mtimeMs,
      incompressibleStat.size,
      ["br", "gzip"],
      false,
    )).toEqual({ status: "not-beneficial" });

    // Over the source cap, and a read that cannot be satisfied, are both
    // server-side declines rather than statements about the representation.
    expect(await compressStaticFileWithinLimits(
      compressiblePath,
      compressibleStat.mtimeMs,
      MAX_STATIC_FALLBACK_SOURCE_BYTES + 1,
      ["br"],
      false,
    )).toEqual({ status: "declined" });

    expect(await compressStaticFileWithinLimits(
      path.join(root, "missing.js"),
      compressibleStat.mtimeMs,
      compressibleStat.size,
      ["br"],
      true,
    )).toEqual({ status: "declined" });

    // A forbidden identity forces a coded form even when it is larger.
    const forced = await compressStaticFileWithinLimits(
      incompressiblePath,
      incompressibleStat.mtimeMs,
      incompressibleStat.size,
      ["gzip"],
      true,
    );
    expect(forced).toMatchObject({ status: "compressed", encoding: "gzip" });
  });



  test("does not crash the gateway when a validated asset becomes unreadable mid-response", async () => {
    if (process.getuid?.() === 0) return;
    const dataDir = await createTempDir("ork-static-stream-error-");
    const rendererRoot = await createRendererRoot(dataDir);
    // A .png is not compressible, so this reaches the streaming path directly
    // rather than being buffered by the on-the-fly fallback.
    const assetPath = await writeRendererAsset(
      rendererRoot,
      "assets/broken-12345678.png",
      Buffer.alloc(4096, 0x7f),
    );
    await writeRendererAsset(rendererRoot, "assets/intact-12345678.png", Buffer.alloc(64, 0x01));

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    // stat() still succeeds (it only needs the directory), so the handler
    // commits 200 headers and only then discovers it cannot read the body.
    await chmod(assetPath, 0o000);
    const outcome = await requestUrl(`${info.url}assets/broken-12345678.png`, {
      headers: authorization,
    }).catch((error: unknown) => error);
    // Whether the client surfaces this as a transport error or as a truncated
    // read is its own business. What must never happen is a complete-looking
    // 4096-byte payload the client would cache as the immutable asset.
    if (!(outcome instanceof Error)) {
      expect(outcome.rawBody.byteLength).toBeLessThan(4096);
    }

    // The unreadable read must not have taken the process or the listener with
    // it: an unhandled stream 'error' event would have crashed the gateway.
    const intact = await requestUrl(`${info.url}assets/intact-12345678.png`, {
      headers: authorization,
    });
    expect(intact.status).toBe(200);
    expect(intact.rawBody.byteLength).toBe(64);
    await chmod(assetPath, 0o600);
  });



  test("serves precompressed build-script file types with aligned MIME types", async () => {
    const dataDir = await createTempDir("ork-static-mime-compression-");
    const rendererRoot = await createRendererRoot(dataDir);
    const cases = [
      { extension: "mjs", contentType: "text/javascript; charset=utf-8" },
      { extension: "map", contentType: "application/json; charset=utf-8" },
      { extension: "txt", contentType: "text/plain; charset=utf-8" },
      { extension: "xml", contentType: "application/xml; charset=utf-8" },
    ] as const;
    for (const { extension } of cases) {
      await writeRendererAsset(
        rendererRoot,
        `assets/file-12345678.${extension}`,
        `content-${extension}-`.repeat(256),
      );
    }

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    for (const { extension, contentType } of cases) {
      const response = await requestUrl(`${info.url}assets/file-12345678.${extension}`, {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "br",
        },
      });
      expect(response.status, extension).toBe(200);
      expect(response.headers["content-type"], extension).toBe(contentType);
      expect(response.headers["content-encoding"], extension).toBe("br");
      expect(decodeResponseBody(response), extension).toContain(`content-${extension}`);
    }
  });



  test("sync-flushes compressed SSE immediately and cleans up its compressor", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const stream = await openCompressedEventStream(gateway, info);

    expect(stream.headers()["content-encoding"]).toBe("gzip");
    expect(stream.headers().vary).toContain("Accept-Encoding");
    expect(stream.headers()["cache-control"]).toBe("no-store, no-transform");
    expect(stream.received()).toContain(": compression-priming");
    expect(stream.received()).toContain(": connected");

    gateway.emit("environment-changed", { id: "environment-a" });
    await waitUntil(
      () => stream.received().includes("environment-changed"),
      "Compressed application frame was buffered",
    );

    const writer = stream.response as unknown as {
      compressor: { destroyed: boolean };
    };
    expect(writer.compressor.destroyed).toBe(false);
    stream.response.destroy();
    stream.close();
    await waitUntil(
      () => eventClients(gateway).size === 0,
      "Compressed event writer was not unregistered",
    );
    expect(writer.compressor.destroyed).toBe(true);
  });



  test("destroys a compressed SSE response and clears pending bytes on codec failure", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const stream = await openCompressedEventStream(gateway, info);
    const writer = stream.response as unknown as {
      compressor: {
        destroyed: boolean;
        destroy(error: Error): void;
      };
      writableLength: number;
    };

    writer.compressor.destroy(new Error("codec failed"));
    await waitUntil(
      () => eventClients(gateway).size === 0,
      "Failed compressed writer was not unregistered",
    );
    expect(writer.compressor.destroyed).toBe(true);
    expect(writer.writableLength).toBe(0);
    await waitUntil(
      () => stream.aborted(),
      "Failed compressed response was not aborted",
    );
    stream.close();
  });



  test("keeps SSE identity in off and body modes", async () => {
    for (const compression of ["off", "body"] as const) {
      const { gateway, info } = await startGateway({ compression });
      const stream = await openEventStream(gateway, info);
      expect(stream.received()).toContain(": connected");
      expect((stream.response as unknown as { response?: unknown }).response).toBeDefined();
      stream.close();
    }
  });



  test("preserves compressed SSE soft-limit recovery and keepalives", async () => {
    const { gateway, info } = await startGateway({
      compression: "on",
      keepaliveMs: 5,
    });
    const event = "terminal-output-tmux:env:tab:one";
    const pane = randomBytes(256).toString("base64");
    const stream = await openCompressedEventStream(
      gateway,
      info,
      `?excludeEvents=terminal-output-&includeEvents=${event}`,
    );
    await waitUntil(
      () => stream.received().includes(": keepalive"),
      "Compressed stream never received a keepalive",
    );

    pinBufferedBytes(stream.response, 2 * 1024 * 1024);
    gateway.emit(event, { text: pane, full: true });
    expect(stream.received()).not.toContain(pane);
    releaseBufferedBytes(stream.response);
    gateway.emit(event, {
      text: randomBytes(256).toString("base64"),
      full: false,
    });
    await waitUntil(
      () => stream.received().includes(pane),
      "Compressed stream did not recover its retained tmux repaint",
    );
    expect(stream.received()).not.toContain("\"desynced\":true");
    stream.close();
  });



  test("drops a real non-reading incompressible compressed stream at the hard limit", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const endpoint = new URL(`${info.url}__orkestrator/events`);
    const request = httpRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: endpoint.pathname,
      headers: {
        authorization: `Bearer ${info.token}`,
        "accept-encoding": "gzip",
      },
    }, (response) => response.pause());
    request.on("error", () => undefined);
    request.end();
    await waitUntil(
      () => eventClients(gateway).size === 1,
      "Non-reading compressed stream was not registered",
    );
    const writer = [...eventClients(gateway).keys()][0] as unknown as {
      compressor: { destroyed: boolean };
    };

    for (let index = 0; index < 160 && eventClients(gateway).size > 0; index += 1) {
      gateway.emit("authoritative-random", randomBytes(64 * 1024).toString("base64"));
    }

    expect(eventClients(gateway).size).toBe(0);
    expect(writer.compressor.destroyed).toBe(true);
    request.destroy();
  });



  test("applies event filters before writing to connected clients", async () => {
    const dataDir = await createTempDir("ork-gateway-filter-");
    const rendererRoot = await createRendererRoot(dataDir);
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
    });
    const writes: string[] = [];
    const client = {
      writableLength: 0,
      write: mock((message: string) => {
        writes.push(message);
        return true;
      }),
      destroy: mock(() => undefined),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, unknown> }
    ).clients;
    clients.set(client, {
      prefixes: null,
      includedPrefixes: ["terminal-output-one"],
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
    });

    gateway.emit("terminal-output-two", { bytesBase64: "dHdv" });
    gateway.emit("menu-zoom", "in");
    gateway.emit("terminal-output-one", { bytesBase64: "b25l" });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"event":"terminal-output-one"');
  });



  test("counts one event frame per delivery, and none when nobody receives it", async () => {
    const { gateway, info } = await startGateway();

    // No clients at all: nothing was put on the wire, so nothing is recorded
    // and the label is not even materialized.
    gateway.emit("environment-renamed", { id: "env" });
    let metrics = await readGatewayMetrics(info);
    expect(metrics.events["environment-renamed"]).toBeUndefined();

    const first = await openEventStream(gateway, info);
    const second = await openEventStream(gateway, info);
    const payload = { id: "env" };

    // Two healthy subscribers: the frame really is written twice, so both the
    // count and the byte total scale with deliveries rather than with emits.
    gateway.emit("environment-renamed", payload);
    await waitUntil(
      () => first.received().includes("environment-renamed")
        && second.received().includes("environment-renamed"),
      "Both streams should have received the frame",
    );
    metrics = await readGatewayMetrics(info);
    const receivedBytes = [
      ...eventFrames(first.received(), "environment-renamed"),
      ...eventFrames(second.received(), "environment-renamed"),
    ].reduce((total, frame) => total + Buffer.byteLength(frame), 0);
    // Derived independently of what the clients received, so a metric fed the
    // same wrong number that was written cannot pass. Replay frames carry an
    // `id:` line, which the byte count has to include.
    const replay = (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay;
    const expectedFrameBytes = Buffer.byteLength(
      `id: ${replay.generation}:${replay.latestRevision}\n`
      + `data: ${JSON.stringify({ event: "environment-renamed", payload })}\n\n`,
    );
    expect(receivedBytes).toBe(expectedFrameBytes * 2);
    expect(metrics.events["environment-renamed"]).toEqual({
      frames: 2,
      wireBytes: expectedFrameBytes * 2,
      droppedFrames: 0,
      droppedClients: 0,
    });

    // A subscriber that filters the event out is not a delivery.
    const filtered = await openEventStream(gateway, info, "?events=menu-");
    gateway.emit("environment-renamed", payload);
    await waitUntil(
      () => (first.received().match(/environment-renamed/g) ?? []).length === 2,
      "The subscribed stream should have received the second frame",
    );
    metrics = await readGatewayMetrics(info);
    const allDeliveryBytes = [
      ...eventFrames(first.received(), "environment-renamed"),
      ...eventFrames(second.received(), "environment-renamed"),
    ].reduce((total, frame) => total + Buffer.byteLength(frame), 0);
    expect(metrics.events["environment-renamed"]).toMatchObject({
      frames: 4,
      wireBytes: allDeliveryBytes,
    });
    expect(filtered.received()).not.toContain("environment-renamed");

    first.close();
    second.close();
    filtered.close();
  });



  test("attributes keepalive drops to a reserved label and counts keepalives", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 5 });
    const lagging = await openEventStream(gateway, info);
    const healthy = await openEventStream(gateway, info);

    await waitUntil(
      () => healthy.received().includes(": keepalive"),
      "Healthy stream never received a keepalive",
    );

    pinBufferedBytes(lagging.response, 8 * 1024 * 1024 + 1);
    await waitUntil(() => lagging.aborted(), "Lagging stream was never dropped by the keepalive");

    const metrics = await readGatewayMetrics(info);
    expect(metrics.stream.keepalives).toBeGreaterThan(0);
    expect(metrics.stream.dropped).toBe(1);
    // A keepalive is not an event, so the drop must not land in a bucket that
    // a real event named `events` would share.
    expect(metrics.events.events).toBeUndefined();
    expect(metrics.events.__keepalive__).toMatchObject({ droppedClients: 1, frames: 0 });

    releaseBufferedBytes(lagging.response);
    healthy.close();
  });



  test("counts a desync recovery frame and keeps the connecting gauge released", async () => {
    const { gateway, info } = await startGateway();
    const client = await openEventStream(gateway, info);
    const payload = { bytesBase64: "eA==" };

    // Force a soft-limit drop so the session is marked desynced, then release
    // the buffer so the recovery notice is actually written.
    pinBufferedBytes(client.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-session-a", payload);

    let metrics = await readGatewayMetrics(info);
    expect(metrics.events["terminal-output"]).toMatchObject({ droppedFrames: 1, frames: 0 });

    releaseBufferedBytes(client.response);
    gateway.emit("terminal-output-session-a", payload);
    await waitUntil(
      () => client.received().includes("desynced"),
      "Recovery notice was never flushed",
    );

    metrics = await readGatewayMetrics(info);
    // The recovery notice and the frame that followed it are both real writes.
    expect(metrics.events["terminal-output"]!.frames).toBeGreaterThanOrEqual(1);
    expect(metrics.events["terminal-output"]!.wireBytes).toBeGreaterThan(0);
    // Every handshake reached `open`, so nothing is left parked in `connecting`.
    expect(metrics.stream.connecting).toBe(0);
    expect(metrics.stream.opened).toBe(1);
    expect(metrics.stream.open).toBe(1);

    client.close();
  });



  test("drops projected soft-limit terminal frames and flushes a desync notice on drain", async () => {
    const dataDir = await createTempDir("ork-gateway-soft-limit-");
    const rendererRoot = await createRendererRoot(dataDir);
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
    });
    const writes: string[] = [];
    const client = {
      writableLength: 1024 * 1024 - 20,
      write: mock((message: string) => {
        writes.push(message);
        return false;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);

    gateway.emit("terminal-output-session-a", {
      bytesBase64: "eA==",
      sequence: 1,
    });
    expect(writes).toEqual([]);
    expect(state.desyncedSessions).toEqual(new Set(["session-a"]));

    // Node emits "drain" only after writableLength returns below the
    // high-water mark. Invoke the same private callback target to pin that the
    // pending session becomes an authoritative recovery notice.
    client.writableLength = 0;
    const flushed = (
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state);
    expect(flushed).toBe(true);
    expect(state.desyncedSessions.size).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"desynced":true');
  });



  test("disconnects instead of retaining one oversized authoritative frame", async () => {
    const dataDir = await createTempDir("ork-gateway-oversized-frame-");
    const rendererRoot = await createRendererRoot(dataDir);
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
    });
    const client = {
      writableLength: 0,
      write: mock(() => true),
      destroy: mock(() => undefined),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, unknown> }
    ).clients;
    clients.set(client, {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
    });

    gateway.emit("authoritative-snapshot", "x".repeat(8 * 1024 * 1024));
    expect(client.write).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(clients.has(client)).toBe(false);
  });



  test("keeps a scoped subscription restricted to its own prefixes", () => {
    expect(eventMatchesSubscription("menu-zoom", ["menu-", "environment-"])).toBe(true);
    expect(eventMatchesSubscription("terminal-output-one", ["menu-"])).toBe(false);
    // An explicit include still wins over a base scope that omits the event, and
    // an exclude still removes one the base scope would otherwise carry.
    expect(eventMatchesSubscription(
      "terminal-output-one",
      ["menu-"],
      ["terminal-output-one"],
    )).toBe(true);
    expect(eventMatchesSubscription("menu-zoom", ["menu-"], null, ["menu-"])).toBe(false);
  });



  test("rejects non-GET event-stream requests", async () => {
    const { info } = await startGateway();

    const response = await requestUrl(`${info.url}__orkestrator/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${info.token}` },
    });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe("GET");
  });



  test("advances scoped replay cursors across omitted global revisions", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info, "?events=menu-");
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Scoped cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial scoped stream did not close");

    gateway.emit("environment-renamed", { id: "omitted" });
    const omittedCursor = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;
    gateway.emit("menu-zoom", "in");

    const replayed = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(
      () => replayed.received().includes('"event":"menu-zoom"'),
      "Scoped replay did not deliver its matching event",
    );
    const cursorFrames = eventFrames(replayed.received(), "gateway.cursor");
    expect(cursorFrames).toHaveLength(1);
    expect(frameId(cursorFrames[0]!)).toBe(omittedCursor);
    expect(replayed.received()).not.toContain("environment-renamed");
    expect(eventFrames(replayed.received(), "menu-zoom")).toHaveLength(1);
    replayed.close();
  });



  test("terminal-only streams ignore gateway replay cursors and control frames", async () => {
    const { gateway, info } = await startGateway();
    const terminal = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one&since=not-a-cursor",
      { "Last-Event-ID": "also-not-a-cursor" },
    );
    const replay = (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay;
    const revisionBefore = replay.latestRevision;
    gateway.emit("terminal-output-one", { bytesBase64: "b25l" });
    await waitUntil(
      () => terminal.received().includes("terminal-output-one"),
      "Terminal-only stream did not receive output",
    );
    expect(terminal.received()).not.toContain("gateway.connected");
    expect(terminal.received()).not.toContain("gateway.reconcile-required");
    expect(terminal.received()).not.toContain("gateway.cursor");
    // Terminal bytes must not consume an authoritative revision, or a browser
    // watching one terminal would burn the ring every other client depends on.
    expect(replay.latestRevision).toBe(revisionBefore);
    expect(replay.getStats().retainedFrames).toBe(0);
    // The frame carries no `id:`, so an EventSource here never adopts a cursor.
    expect(eventFrames(terminal.received(), "terminal-output-one")[0]).not.toContain("id:");
    terminal.close();
  });



  test("replays a retained authoritative gap and echoes the client cursor", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const connected = eventFrames(initial.received(), "gateway.connected")[0];
    if (!connected) throw new Error("Initial stream did not receive a connected frame");
    const cursor = frameId(connected);
    if (!cursor) throw new Error("Connected frame did not carry a cursor");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "one" });
    gateway.emit("environment-setup-complete", { id: "two" });

    const replayed = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(
      () => replayed.received().includes("environment-setup-complete"),
      "Retained gap was not replayed",
    );
    const replayConnected = eventFrames(replayed.received(), "gateway.connected")[0];
    expect(frameId(replayConnected!)).toBe(cursor);
    // The count is part of the contract: a client uses it to tell a replayed
    // resume apart from a silent one before any frame arrives.
    expect(replayConnected).toContain('"status":"replayed"');
    expect(replayConnected).toContain('"replayed":2');
    expect(replayed.received()).not.toContain("gateway.reconcile-required");
    expect(eventFrames(replayed.received(), "environment-renamed")).toHaveLength(1);
    expect(eventFrames(replayed.received(), "environment-setup-complete")).toHaveLength(1);
    replayed.close();
  });



  test("accepts Last-Event-ID and reconciles invalid or prior-generation cursors", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");
    gateway.emit("environment-renamed", { id: "header" });

    const viaHeader = await openEventStream(gateway, info, "", {
      "Last-Event-ID": cursor,
    });
    await waitUntil(
      () => viaHeader.received().includes('"id":"header"'),
      "Last-Event-ID gap was not replayed",
    );
    expect(viaHeader.received()).not.toContain("gateway.reconcile-required");
    viaHeader.response.destroy();
    viaHeader.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Header stream did not close");

    const invalid = await openEventStream(gateway, info, "?since=not-a-cursor");
    const invalidConnected = eventFrames(invalid.received(), "gateway.connected")[0];
    expect(invalidConnected).toBeDefined();
    expect(frameId(invalidConnected!)).toBeNull();
    expect(eventFrames(invalid.received(), "gateway.reconcile-required")).toHaveLength(1);
    expect(invalid.received()).toContain('"reason":"invalid-cursor"');
    invalid.response.destroy();
    invalid.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Invalid stream did not close");

    const prior = await openEventStream(
      gateway,
      info,
      `?since=${"a".repeat(32)}%3A0`,
    );
    expect(eventFrames(prior.received(), "gateway.reconcile-required")).toHaveLength(1);
    expect(prior.received()).toContain('"reason":"prior-generation"');
    prior.close();
  });



  test("prefers a newer Last-Event-ID over a stale explicit since cursor", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const initialCursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!initialCursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "already-delivered" });
    const newerCursor = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;
    gateway.emit("environment-setup-complete", { id: "still-missing" });

    const resumed = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(initialCursor)}`,
      { "Last-Event-ID": newerCursor },
    );
    await waitUntil(
      () => resumed.received().includes('"id":"still-missing"'),
      "Newer header cursor did not resume the remaining gap",
    );
    expect(frameId(eventFrames(resumed.received(), "gateway.connected")[0]!)).toBe(newerCursor);
    expect(resumed.received()).not.toContain('"id":"already-delivered"');
    expect(eventFrames(resumed.received(), "environment-setup-complete")).toHaveLength(1);
    resumed.close();
  });



  test("prefers the header even when it trails the explicit since cursor", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const staleCursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!staleCursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "between" });
    const newerCursor = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;

    // The browser owns Last-Event-ID and always advances it, so a header behind
    // the query means the query is the untrustworthy one. Preferring the header
    // re-delivers rather than skips, which the revision-gap check absorbs.
    const resumed = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(newerCursor)}`,
      { "Last-Event-ID": staleCursor },
    );
    await waitUntil(
      () => resumed.received().includes('"id":"between"'),
      "Stale header did not re-deliver the intervening frame",
    );
    expect(frameId(eventFrames(resumed.received(), "gateway.connected")[0]!)).toBe(staleCursor);
    expect(resumed.received()).toContain('"status":"replayed"');
    expect(eventFrames(resumed.received(), "gateway.reconcile-required")).toHaveLength(0);
    resumed.close();
  });



  test("treats a blank cursor in either position as absent rather than malformed", async () => {
    const { gateway, info } = await startGateway();

    // A client that unconditionally appends `since=` has no cursor, not a bad
    // one, and must not be forced through reconciliation on its first connect.
    for (const [query, headers] of [
      ["?since=", undefined],
      ["?since=%20%20", undefined],
      ["", { "Last-Event-ID": "   " }],
      ["?since=", { "Last-Event-ID": "\t" }],
    ] as const) {
      const stream = await openEventStream(gateway, info, query, headers);
      const connected = eventFrames(stream.received(), "gateway.connected")[0];
      expect(connected).toBeDefined();
      expect(stream.received()).toContain('"status":"fresh"');
      expect(stream.received()).toContain('"replayed":0');
      expect(eventFrames(stream.received(), "gateway.reconcile-required")).toHaveLength(0);
      // Fresh still anchors at the latest revision, unlike the invalid path.
      expect(frameId(connected!)).toBe(
        (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay.latestCursor,
      );
      stream.response.destroy();
      stream.close();
      await waitUntil(() => eventClients(gateway).size === 0, "Blank-cursor stream did not close");
    }
  });



  test("a whitespace-only header falls back to the explicit since cursor", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "missed" });

    const resumed = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
      { "Last-Event-ID": "  " },
    );
    await waitUntil(
      () => resumed.received().includes('"id":"missed"'),
      "Blank header did not fall back to the query cursor",
    );
    expect(resumed.received()).toContain('"status":"replayed"');
    resumed.close();
  });



  test("keeps replay for a stream whose includes are not all terminal output", async () => {
    const { gateway, info } = await startGateway();
    // `includeEvents` mixes a terminal session with an authoritative prefix, so
    // this is not a terminal-only stream and must stay in the cursor sequence.
    const mixed = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one,environment-",
    );

    const connected = eventFrames(mixed.received(), "gateway.connected")[0];
    expect(connected).toBeDefined();
    expect(mixed.received()).toContain('"status":"fresh"');

    gateway.emit("environment-renamed", { id: "authoritative" });
    await waitUntil(
      () => mixed.received().includes('"id":"authoritative"'),
      "Mixed stream did not receive its authoritative event",
    );
    expect(frameId(eventFrames(mixed.received(), "environment-renamed")[0]!)).not.toBeNull();
    mixed.close();
  });



  test("reports the full reconciliation payload, not just its reason", async () => {
    const { gateway, info } = await startGateway({
      eventReplay: { frameCapacity: 1, idleRetentionMs: 60_000 },
    });
    const initial = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "one" });
    gateway.emit("environment-renamed", { id: "two" });

    const expired = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
    );
    const frame = eventFrames(expired.received(), "gateway.reconcile-required")[0];
    expect(frame).toBeDefined();
    const payload = JSON.parse(frame!.slice(frame!.indexOf("data: ") + 6)) as {
      payload: Record<string, unknown>;
    };
    const replay = (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay;
    expect(payload.payload).toEqual({
      reason: "cursor-expired",
      requestedCursor: cursor,
      requestedRevision: 0,
      oldestAvailableRevision: 2,
      latestRevision: 2,
      generation: replay.generation,
    });
    expired.close();
  });



  test("reports replay handshake outcomes and ring occupancy on /metrics", async () => {
    const { gateway, info } = await startGateway({
      eventReplay: { frameCapacity: 1, idleRetentionMs: 60_000 },
    });
    const fresh = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(fresh.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    fresh.response.destroy();
    fresh.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Fresh stream did not close");

    const caughtUp = await openEventStream(gateway, info, `?since=${encodeURIComponent(cursor)}`);
    caughtUp.response.destroy();
    caughtUp.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Caught-up stream did not close");

    gateway.emit("environment-renamed", { id: "one" });
    const afterOne = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;
    const replayed = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
    );
    replayed.response.destroy();
    replayed.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Replayed stream did not close");

    // Capacity 1, so this second event evicts the first and the original cursor
    // can no longer be served.
    gateway.emit("environment-renamed", { id: "two" });
    const expired = await openEventStream(gateway, info, `?since=${encodeURIComponent(cursor)}`);
    const invalid = await openEventStream(gateway, info, "?since=not-a-cursor");

    const metrics = await readGatewayMetrics(info) as unknown as {
      replay: {
        fresh: number;
        caughtUp: number;
        replayed: number;
        replayedFrames: number;
        reconciled: number;
        reasons: Record<string, number>;
        ring: { retainedFrames: number; droppedFrames: number; latestRevision: number };
      };
    };
    expect(metrics.replay).toMatchObject({
      fresh: 1,
      caughtUp: 1,
      replayed: 1,
      replayedFrames: 1,
      reconciled: 2,
    });
    expect(metrics.replay.reasons["cursor-expired"]).toBe(1);
    expect(metrics.replay.reasons["invalid-cursor"]).toBe(1);
    expect(metrics.replay.reasons["prior-generation"]).toBe(0);
    // Eviction is otherwise invisible: a ring dropping every gap looks exactly
    // like one that never needed to retain anything.
    expect(metrics.replay.ring).toMatchObject({
      retainedFrames: 1,
      droppedFrames: 1,
      latestRevision: 2,
    });
    expect(afterOne).toBe(`${(
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.generation}:1`);
    expired.close();
    invalid.close();
  });



  test("stops retaining replay payloads once the gateway stops", async () => {
    const { gateway } = await startGateway({ eventReplay: { idleRetentionMs: 60_000 } });
    const replay = (gateway as unknown as { eventReplay: GatewayEventReplay }).eventReplay;
    gateway.emit("environment-renamed", { id: "one" });
    expect(replay.getStats().retainedFrames).toBe(1);

    await gateway.stop();

    // Revisions survive so a returning client is told to reconcile rather than
    // being handed a window that silently restarted at zero.
    expect(replay.getStats()).toMatchObject({ retainedFrames: 0, retainedBytes: 0 });
    expect(replay.latestRevision).toBe(1);
    expect(replay.since(0).complete).toBe(false);
  });



  test("reports caught-up and future same-generation cursors explicitly", async () => {
    const { gateway, info } = await startGateway();
    const initial = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    const caughtUp = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
    );
    expect(caughtUp.received()).toContain('"status":"caught-up"');
    expect(eventFrames(caughtUp.received(), "gateway.reconcile-required")).toHaveLength(0);
    caughtUp.response.destroy();
    caughtUp.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Caught-up stream did not close");

    const separator = cursor.lastIndexOf(":");
    const futureCursor = `${cursor.slice(0, separator)}:${Number(cursor.slice(separator + 1)) + 1}`;
    const future = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(futureCursor)}`,
    );
    expect(frameId(eventFrames(future.received(), "gateway.connected")[0]!)).toBe(futureCursor);
    expect(future.received()).toContain('"status":"reconcile"');
    // A cursor the gateway never issued is not a retention overrun. Reporting it
    // as `cursor-expired` would hide a corrupt client behind routine eviction.
    expect(future.received()).toContain('"reason":"cursor-ahead"');
    expect(future.received()).not.toContain('"reason":"cursor-expired"');
    expect(future.received()).toContain(`"requestedCursor":"${futureCursor}"`);
    expect(frameId(eventFrames(future.received(), "gateway.reconcile-required")[0]!)).toBe(cursor);
    future.close();
  });



  test("advances a scoped cursor past omitted revisions on the keepalive tick", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 20 });
    const scoped = await openEventStream(gateway, info, "?events=menu-");
    const cursor = frameId(eventFrames(scoped.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Scoped cursor missing");

    // None of these match `menu-`, so without the keepalive flush the client's
    // cursor would stay pinned at `cursor` while the ring moved past it.
    for (let index = 0; index < 5; index += 1) {
      gateway.emit("environment-renamed", { id: `omitted-${index}` });
    }
    const latest = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;

    await waitUntil(
      () => eventFrames(scoped.received(), "gateway.cursor").length > 0,
      "Scoped stream never advanced its omitted cursor",
    );
    const cursorFrames = eventFrames(scoped.received(), "gateway.cursor");
    // Coalesced: one frame for the whole omitted run, not one per event.
    expect(cursorFrames).toHaveLength(1);
    expect(frameId(cursorFrames[0]!)).toBe(latest);
    expect(scoped.received()).not.toContain("environment-renamed");

    // A quiet interval must not re-emit the cursor it already delivered.
    const before = eventFrames(scoped.received(), "gateway.cursor").length;
    await waitUntil(
      () => scoped.received().split(": keepalive").length > 2,
      "Keepalive did not tick again",
    );
    expect(eventFrames(scoped.received(), "gateway.cursor")).toHaveLength(before);

    // The advanced cursor is a real resume point, not just a number.
    scoped.response.destroy();
    scoped.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Scoped stream did not close");
    gateway.emit("menu-zoom", "in");
    const resumed = await openEventStream(
      gateway,
      info,
      `?events=menu-&since=${encodeURIComponent(latest)}`,
    );
    expect(resumed.received()).toContain('"status":"replayed"');
    expect(eventFrames(resumed.received(), "gateway.reconcile-required")).toHaveLength(0);
    resumed.close();
  });



  test("a matching frame supersedes an omitted cursor instead of rewinding it", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 20 });
    const scoped = await openEventStream(gateway, info, "?events=menu-");

    gateway.emit("environment-renamed", { id: "omitted" });
    gateway.emit("menu-zoom", "in");
    const latest = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay.latestCursor;
    await waitUntil(
      () => scoped.received().includes('"event":"menu-zoom"'),
      "Scoped stream never received its matching event",
    );
    await waitUntil(
      () => scoped.received().split(": keepalive").length > 2,
      "Keepalive did not tick",
    );

    // The matching frame already carries a newer id, so no cursor frame is owed
    // and the client must not be rewound to the older omitted revision.
    expect(eventFrames(scoped.received(), "gateway.cursor")).toHaveLength(0);
    expect(frameId(eventFrames(scoped.received(), "menu-zoom")[0]!)).toBe(latest);
    scoped.close();
  });



  test("terminal-only streams never receive an omitted cursor frame", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 20 });
    const terminal = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );

    gateway.emit("environment-renamed", { id: "omitted" });
    await waitUntil(
      () => terminal.received().split(": keepalive").length > 2,
      "Keepalive did not tick",
    );

    expect(terminal.received()).not.toContain("gateway.cursor");
    expect(terminal.received()).not.toContain("environment-renamed");
    terminal.close();
  });



  test("reconciles instead of destroying a client mid-replay when the window will not fit", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
      eventReplay: { idleRetentionMs: 60_000 },
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    const cursor = replay.latestCursor;
    const frame = replay.append("environment-renamed", { id: "x".repeat(4096) });

    const writes: string[] = [];
    // Enough room for the small control frames but one byte short of the replay
    // window. Replay is one synchronous flush and `writableLength` cannot fall
    // during it, so writing it would trip the hard limit partway through and
    // destroy the client with no explanation — and the reconnect would do the
    // same thing again.
    const client = {
      writableLength: 8 * 1024 * 1024 - frame.encodedBytes + 1,
      write: mock((message: string) => {
        writes.push(message);
        return true;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
      handshake: { events: [], bytes: 0 },
      tracksReplayCursor: true,
      sentRevision: 0,
      omittedRevision: null,
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof state,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(client, state, parseGatewayCursor(cursor));

    const received = writes.join("");
    expect(received).toContain('"status":"reconcile"');
    expect(received).toContain('"reason":"replay-too-large"');
    expect(eventFrames(received, "environment-renamed")).toHaveLength(0);
    // Reconciled, not dropped: the client is still subscribed and usable.
    expect(client.destroy).not.toHaveBeenCalled();
    expect(clients.has(client)).toBe(true);
    replay.releaseRetained();
  });



  test("the default replay window leaves headroom below the per-client hard buffer", () => {
    const replay = new GatewayEventReplay("generation");
    try {
      // Replay is one synchronous flush and `writableLength` cannot fall during
      // it, so a window sized at the hard limit has no room to land.
      expect(replay.getStats().maxBytes).toBe(DEFAULT_GATEWAY_REPLAY_MAX_BYTES);
      expect(DEFAULT_GATEWAY_REPLAY_MAX_BYTES * 4).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      replay.releaseRetained();
    }
  });



  test("emits one reconciliation path when the requested gap has expired", async () => {
    const { gateway, info } = await startGateway({
      eventReplay: {
        frameCapacity: 2,
        maxBytes: 1024 * 1024,
        idleRetentionMs: 60_000,
      },
    });
    const initial = await openEventStream(gateway, info);
    const cursor = frameId(eventFrames(initial.received(), "gateway.connected")[0]!);
    if (!cursor) throw new Error("Initial cursor missing");
    initial.response.destroy();
    initial.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Initial stream did not close");

    gateway.emit("environment-renamed", { id: "one" });
    gateway.emit("environment-renamed", { id: "two" });
    gateway.emit("environment-renamed", { id: "three" });

    const expired = await openEventStream(
      gateway,
      info,
      `?since=${encodeURIComponent(cursor)}`,
    );
    await waitUntil(
      () => expired.received().includes("gateway.reconcile-required"),
      "Expired cursor did not reconcile",
    );
    expect(eventFrames(expired.received(), "gateway.reconcile-required")).toHaveLength(1);
    expect(expired.received()).toContain('"reason":"cursor-expired"');
    expect(expired.received()).not.toContain('"id":"one"');
    expect(expired.received()).not.toContain('"id":"two"');
    expect(expired.received()).not.toContain('"id":"three"');
    expired.close();
  });



  test("bounds replay by frame count and encoded bytes and expires idle payloads", async () => {
    const countBound = new GatewayEventReplay("generation", {
      frameCapacity: 2,
      maxBytes: 1024 * 1024,
      idleRetentionMs: 60_000,
    });
    countBound.append("one", 1);
    countBound.append("two", 2);
    countBound.append("three", 3);
    expect(countBound.getStats()).toMatchObject({
      retainedFrames: 2,
      oldestRevision: 2,
      latestRevision: 3,
    });
    expect(countBound.since(0).complete).toBe(false);

    const byteBound = new GatewayEventReplay("generation", {
      frameCapacity: 100,
      maxBytes: 180,
      idleRetentionMs: 60_000,
    });
    for (let index = 0; index < 10; index += 1) {
      byteBound.append(`event-${index}`, "x".repeat(40));
    }
    expect(byteBound.getStats().retainedBytes).toBeLessThanOrEqual(180);
    expect(byteBound.getStats().retainedFrames).toBeLessThan(10);

    const idle = new GatewayEventReplay("generation", {
      idleRetentionMs: 5,
    });
    idle.append("one", 1);
    await waitUntil(
      () => idle.getStats().retainedFrames === 0,
      "Idle replay payload was not released",
    );
    expect(idle.getStats().latestRevision).toBe(1);
    expect(idle.since(0).complete).toBe(false);

    countBound.releaseRetained();
    byteBound.releaseRetained();
  });



  test("buffers events emitted during replay and keeps terminal output out of the ring", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    gateway.emit("environment-renamed", { id: "base" });
    const cursor = replay.latestCursor;
    gateway.emit("environment-renamed", { id: "before" });
    const originalSince = replay.since.bind(replay);
    replay.since = ((revision: number) => {
      // This is the exact subscribe-before-calculation gap: the client is
      // already in `clients`, while the retained range is being determined.
      gateway.emit("environment-renamed", { id: "during" });
      return originalSince(revision);
    }) as typeof replay.since;
    const writes: string[] = [];
    const client = {
      writableLength: 0,
      write: mock((message: string) => {
        writes.push(message);
        return true;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
      handshake: { events: [], bytes: 0 },
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof state,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(client, state, parseGatewayCursor(cursor));

    const body = writes.join("");
    expect(body.indexOf('"id":"before"')).toBeLessThan(body.indexOf('"id":"during"'));
    expect(body.match(/"id":"before"/g)).toHaveLength(1);
    expect(body.match(/"id":"during"/g)).toHaveLength(1);
    const latestBeforeTerminal = replay.latestRevision;
    gateway.emit("terminal-output-session", { text: "bytes" });
    expect(replay.latestRevision).toBe(latestBeforeTerminal);
    replay.releaseRetained();
  });



  test("does not advance an invalid cursor before reconciliation is delivered", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    gateway.emit("environment-renamed", { id: "missed" });
    const writes: string[] = [];
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
      handshake: { events: [], bytes: 0 },
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    const client = {
      writableLength: 0,
      write: mock((message: string) => {
        writes.push(message);
        if (message.includes('"event":"gateway.connected"')) clients.delete(client);
        return true;
      }),
      destroy: mock(() => undefined),
    };
    clients.set(client, state);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof state,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(client, state, parseGatewayCursor("not-a-cursor"));

    const connected = eventFrames(writes.join(""), "gateway.connected")[0];
    expect(connected).toBeDefined();
    expect(frameId(connected!)).toBeNull();
    expect(eventFrames(writes.join(""), "gateway.reconcile-required")).toHaveLength(0);

    const retryWrites: string[] = [];
    const retryState = {
      ...state,
      handshake: { events: [], bytes: 0 },
    };
    const retryClient = {
      writableLength: 0,
      write: mock((message: string) => {
        retryWrites.push(message);
        return true;
      }),
      destroy: mock(() => undefined),
    };
    clients.set(retryClient, retryState);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof retryState,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(retryClient, retryState, parseGatewayCursor("not-a-cursor"));
    expect(eventFrames(retryWrites.join(""), "gateway.reconcile-required")).toHaveLength(1);
    replay.releaseRetained();
  });



  test("buffers terminal output emitted during an authoritative replay handshake", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    const cursor = replay.latestCursor;
    const writes: string[] = [];
    const client = {
      writableLength: 0,
      write: mock((message: string) => {
        writes.push(message);
        if (message.includes('"event":"gateway.connected"')) {
          gateway.emit("terminal-output-session", { bytesBase64: "dGVybWluYWw=" });
        }
        return true;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: null,
      desyncedSessions: new Set<string>(),
      handshake: { events: [], bytes: 0 },
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof state,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(client, state, parseGatewayCursor(cursor));

    expect(eventFrames(writes.join(""), "terminal-output-session")).toHaveLength(1);
    expect(replay.latestRevision).toBe(0);
    expect(state.handshake).toBeNull();
    replay.releaseRetained();
  });



  test("enforces the replay-handshake byte limit at its exact boundary", () => {
    const run = (byteAdjustment: number) => {
      const gateway = new OrkestratorGateway({
        backend: { invoke: mock(async () => null) },
        dataDir: "/tmp",
        rendererRoot: "/tmp",
        logger: createLogger(),
      });
      const replay = (
        gateway as unknown as { eventReplay: GatewayEventReplay }
      ).eventReplay;
      const event = "environment-renamed";
      const payload = { id: "one" };
      const message = `id: ${replay.generation}:1\ndata: ${JSON.stringify({ event, payload })}\n\n`;
      (
        gateway as unknown as { replayHandshakeMaxBytes: number }
      ).replayHandshakeMaxBytes = Buffer.byteLength(message) + byteAdjustment;
      const writes: string[] = [];
      const client = {
        writableLength: 0,
        write: mock((value: string) => {
          writes.push(value);
          if (value.includes('"event":"gateway.connected"')) gateway.emit(event, payload);
          return true;
        }),
        destroy: mock(() => undefined),
      };
      const state = {
        prefixes: null,
        includedPrefixes: null,
        excludedPrefixes: ["terminal-output-"],
        desyncedSessions: new Set<string>(),
        handshake: { events: [], bytes: 0 },
      };
      const clients = (
        gateway as unknown as { clients: Map<object, typeof state> }
      ).clients;
      clients.set(client, state);
      (
        gateway as unknown as {
          initializeEventReplay(
            client: object,
            state: typeof state,
            cursor: ReturnType<typeof parseGatewayCursor>,
          ): void;
        }
      ).initializeEventReplay(client, state, parseGatewayCursor(`${replay.generation}:0`));
      replay.releaseRetained();
      return { client, clients, writes };
    };

    const exact = run(0);
    expect(exact.client.destroy).not.toHaveBeenCalled();
    expect(eventFrames(exact.writes.join(""), "environment-renamed")).toHaveLength(1);
    expect(exact.clients.has(exact.client)).toBe(true);

    const overflow = run(-1);
    expect(overflow.client.destroy).toHaveBeenCalledTimes(1);
    expect(eventFrames(overflow.writes.join(""), "environment-renamed")).toHaveLength(0);
    expect(overflow.clients.has(overflow.client)).toBe(false);
  });



  test("enforces the replay-handshake frame count at its exact boundary", () => {
    const run = (capacity: number) => {
      const gateway = new OrkestratorGateway({
        backend: { invoke: mock(async () => null) },
        dataDir: "/tmp",
        rendererRoot: "/tmp",
        logger: createLogger(),
        eventReplay: { handshakeFrameCapacity: capacity },
      });
      const replay = (
        gateway as unknown as { eventReplay: GatewayEventReplay }
      ).eventReplay;
      const writes: string[] = [];
      const client = {
        writableLength: 0,
        write: mock((value: string) => {
          writes.push(value);
          // Exactly two events land while the handshake is buffering.
          if (value.includes('"event":"gateway.connected"')) {
            gateway.emit("environment-renamed", { id: "one" });
            gateway.emit("environment-renamed", { id: "two" });
          }
          return true;
        }),
        destroy: mock(() => undefined),
      };
      const state = {
        prefixes: null,
        includedPrefixes: null,
        excludedPrefixes: ["terminal-output-"],
        desyncedSessions: new Set<string>(),
        handshake: { events: [], bytes: 0 },
        tracksReplayCursor: true,
        sentRevision: 0,
        omittedRevision: null,
      };
      const clients = (
        gateway as unknown as { clients: Map<object, typeof state> }
      ).clients;
      clients.set(client, state);
      (
        gateway as unknown as {
          initializeEventReplay(
            client: object,
            state: typeof state,
            cursor: ReturnType<typeof parseGatewayCursor>,
          ): void;
        }
      ).initializeEventReplay(client, state, parseGatewayCursor(`${replay.generation}:0`));
      replay.releaseRetained();
      return { client, clients, writes };
    };

    const exact = run(2);
    expect(exact.client.destroy).not.toHaveBeenCalled();
    expect(eventFrames(exact.writes.join(""), "environment-renamed")).toHaveLength(2);
    expect(exact.clients.has(exact.client)).toBe(true);

    const overflow = run(1);
    expect(overflow.client.destroy).toHaveBeenCalledTimes(1);
    expect(overflow.clients.has(overflow.client)).toBe(false);
  });



  test("releases the connecting gauge and unregisters a client that throws mid-handshake", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
    });
    const clients = (gateway as unknown as { clients: Map<object, unknown> }).clients;
    const destroy = mock(() => undefined);
    const response = {
      writableLength: 0,
      writeHead: mock(() => undefined),
      write: mock(() => {
        throw new Error("socket vanished");
      }),
      destroy,
      on: mock(() => undefined),
      once: mock(() => undefined),
    } as unknown as ServerResponse;
    const request = {
      method: "GET",
      headers: {},
      once: mock(() => undefined),
    } as unknown as IncomingMessage;

    // The client is registered before the handshake writes, so a throw here
    // would otherwise leave it in the map with no `close` handler ever wired up
    // and the `connecting` gauge incremented for the life of the process.
    expect(() => (
      gateway as unknown as {
        handleEvents(request: IncomingMessage, response: ServerResponse, url: URL): void;
      }
    ).handleEvents(
      request,
      response,
      new URL("http://127.0.0.1/__orkestrator/events"),
    )).toThrow("socket vanished");

    expect(clients.size).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
    const stream = gateway.metrics.snapshot().stream as Record<string, number>;
    expect(stream.connecting).toBe(0);
    expect(stream.open).toBe(0);
    expect(stream.opened).toBe(0);
  });



  test("applies and clamps the replay-handshake bounds", () => {
    const build = (eventReplay?: { handshakeFrameCapacity?: number; handshakeMaxBytes?: number }) =>
      new OrkestratorGateway({
        backend: { invoke: mock(async () => null) },
        dataDir: "/tmp",
        rendererRoot: "/tmp",
        logger: createLogger(),
        ...(eventReplay ? { eventReplay } : {}),
      }) as unknown as { replayHandshakeFrameCapacity: number; replayHandshakeMaxBytes: number };

    expect(build()).toMatchObject({
      replayHandshakeFrameCapacity: DEFAULT_GATEWAY_REPLAY_HANDSHAKE_FRAME_CAPACITY,
      replayHandshakeMaxBytes: DEFAULT_GATEWAY_REPLAY_HANDSHAKE_MAX_BYTES,
    });
    // A capacity of zero would buffer nothing and drop every handshake; a
    // negative byte bound would do the same. Both clamp to a usable floor.
    expect(build({ handshakeFrameCapacity: -5, handshakeMaxBytes: -5 })).toMatchObject({
      replayHandshakeFrameCapacity: 1,
      replayHandshakeMaxBytes: 0,
    });
  });



  test("disconnects replay and filtered control frames at the hard buffer limit", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    const frame = replay.append("environment-renamed", { id: "one" });
    const clients = (
      gateway as unknown as { clients: Map<object, unknown> }
    ).clients;

    for (const prefixes of [null, ["menu-"]] as const) {
      const client = {
        writableLength: 8 * 1024 * 1024,
        write: mock(() => true),
        destroy: mock(() => undefined),
      };
      const state = {
        prefixes,
        includedPrefixes: null,
        excludedPrefixes: null,
        desyncedSessions: new Set<string>(),
        handshake: null,
      };
      clients.set(client, state);
      const written = (
        gateway as unknown as {
          writeReplayFrame(
            client: object,
            state: typeof state,
            frame: typeof frame,
          ): boolean;
        }
      ).writeReplayFrame(client, state, frame);
      expect(written).toBe(false);
      expect(client.write).not.toHaveBeenCalled();
      expect(client.destroy).toHaveBeenCalledTimes(1);
      expect(clients.has(client)).toBe(false);
    }
    replay.releaseRetained();
  });



  test("disconnects instead of growing the replay-handshake buffer without bound", () => {
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: "/tmp",
      rendererRoot: "/tmp",
      logger: createLogger(),
      eventReplay: {
        handshakeFrameCapacity: 1,
        handshakeMaxBytes: 1024 * 1024,
      },
    });
    const replay = (
      gateway as unknown as { eventReplay: GatewayEventReplay }
    ).eventReplay;
    const cursor = replay.latestCursor;
    const client = {
      writableLength: 0,
      write: mock((message: string) => {
        if (message.includes('"event":"gateway.connected"')) {
          gateway.emit("environment-renamed", { id: "one" });
          gateway.emit("environment-renamed", { id: "two" });
        }
        return true;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: null,
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
      handshake: { events: [], bytes: 0 },
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);
    (
      gateway as unknown as {
        initializeEventReplay(
          client: object,
          state: typeof state,
          cursor: ReturnType<typeof parseGatewayCursor>,
        ): void;
      }
    ).initializeEventReplay(client, state, parseGatewayCursor(cursor));

    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(clients.has(client)).toBe(false);
    expect(state.handshake.events).toHaveLength(1);
    replay.releaseRetained();
  });



  test("flushes a desync notice to a quiet stream once its socket drains", async () => {
    const { gateway, info } = await startGateway();
    const stream = await openEventStream(gateway, info);

    pinBufferedBytes(stream.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-session-a", { bytesBase64: "eA==" });
    // Nothing was written, so nothing can be in flight: no further event is
    // coming to carry the notice, which is exactly what "drain" has to cover.
    expect(stream.received()).not.toContain("terminal-output-session-a");

    releaseBufferedBytes(stream.response);
    // "drain" only follows a refused write, so refuse one for real rather than
    // synthesizing the event the gateway listens for.
    const refused = stream.response.write(`: ${"filler".repeat(700_000)}\n\n`);
    expect(refused).toBe(false);

    await waitUntil(
      () => stream.received().includes("\"desynced\":true"),
      "Drained stream never learned it was desynced",
    );
    expect(stream.received()).toContain("terminal-output-session-a");

    stream.close();
  });



  test("sends a plain desync notice when a tmux session drops on a broad stream", async () => {
    const { gateway, info } = await startGateway();
    const stream = await openEventStream(gateway, info);
    const pane = Buffer.from("latest pane").toString("base64");

    pinBufferedBytes(stream.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-tmux:env:tab:one", { bytesBase64: pane });
    releaseBufferedBytes(stream.response);
    gateway.emit("environment-changed", { id: "env" });

    await waitUntil(
      () => stream.received().includes("environment-changed"),
      "Recovered stream never resumed authoritative events",
    );
    // A broad stream is not the one terminal subscribed to this pane, so it must
    // not accumulate repaints it never asked for.
    expect(stream.received()).toContain("\"desynced\":true");
    expect(stream.received()).not.toContain(pane);

    stream.close();
  });



  test("disconnects a parked stream when even its desync notice would overflow", async () => {
    const { gateway, info } = await startGateway();
    const stream = await openEventStream(gateway, info);

    pinBufferedBytes(stream.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-session-a", { bytesBase64: "eA==" });
    // Still at the hard limit when the socket drains: the notice itself no
    // longer fits, and a client that cannot even be told it desynced is beyond
    // recovering in place.
    pinBufferedBytes(stream.response, 8 * 1024 * 1024);
    stream.response.write(": nudge\n\n");

    await waitUntil(() => stream.aborted(), "Hopeless stream was never disconnected");
    expect(eventClients(gateway).size).toBe(0);
    expect(stream.received()).not.toContain("\"desynced\":true");
  });



  test("drops a parked stream instead of writing keepalives past the hard limit", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 5 });
    const stream = await openEventStream(gateway, info);
    await waitUntil(
      () => stream.received().includes(": keepalive"),
      "Stream never received a keepalive",
    );

    pinBufferedBytes(stream.response, 8 * 1024 * 1024 + 1);

    await waitUntil(
      () => stream.aborted(),
      "Keepalives kept writing to a stream already past the hard limit",
    );
    expect(eventClients(gateway).size).toBe(0);
  });



  test("rewrites browser-preview asset paths into their isolated proxy namespace", () => {
    const prefix = "/__orkestrator/browser/loopback/3000";
    const target = new URL("http://127.0.0.1:3000/");

    expect(rewriteBrowserPreviewBody(
      [
        '<script type="module" src="/src/main.tsx"></script>',
        "<link rel='stylesheet' href='/src/style.css'>",
        "<img src=/assets/logo.png alt=logo>",
        "<style>body { background: url(/assets/grid.png) }</style>",
      ].join("\n"),
      prefix,
      target,
      "html",
    )).toBe([
      `<script type="module" src="${prefix}/src/main.tsx"></script>`,
      `<link rel='stylesheet' href='${prefix}/src/style.css'>`,
      `<img src=${prefix}/assets/logo.png alt=logo>`,
      `<style>body { background: url(${prefix}/assets/grid.png) }</style>`,
    ].join("\n"));

    expect(rewriteBrowserPreviewBody(
      [
        "import '/src/style.css'",
        'import { app } from "/src/app.ts"',
        "const page = await import('/src/page.ts')",
        "const worker = new URL('/src/worker.ts', import.meta.url)",
        "fetch('http://localhost:3000/api/status')",
      ].join("\n"),
      prefix,
      target,
      "js",
    )).toBe([
      `import '${prefix}/src/style.css'`,
      `import { app } from "${prefix}/src/app.ts"`,
      `const page = await import('${prefix}/src/page.ts')`,
      `const worker = new URL('${prefix}/src/worker.ts', import.meta.url)`,
      `fetch('${prefix}/api/status')`,
    ].join("\n"));

    expect(rewriteBrowserPreviewBody(
      '@import "/theme.css";\nbody { background: url(\'/assets/grid.png\') }',
      prefix,
      target,
      "css",
    )).toBe(`@import "${prefix}/theme.css";\nbody { background: url('${prefix}/assets/grid.png') }`);
  });



  test("detects Tailscale addresses and prefers IPv4 bind candidates", () => {
    expect(isTailscaleAddress("100.64.0.1")).toBe(true);
    expect(isTailscaleAddress("100.127.255.254")).toBe(true);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false);
    expect(isTailscaleAddress("192.168.1.20")).toBe(false);
    expect(isTailscaleAddress("fd7a:115c:a1e0:abcd::1")).toBe(true);

    expect(selectTailscaleBindAddress({
      en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }],
      utun5: [
        { address: "fd7a:115c:a1e0:abcd::1", family: "IPv6", internal: false, netmask: "ffff:ffff:ffff:ffff::", cidr: null, mac: "00:00:00:00:00:00", scopeid: 0 },
        { address: "100.88.12.3", family: "IPv4", internal: false, netmask: "255.192.0.0", cidr: null, mac: "00:00:00:00:00:00" },
      ],
    })).toBe("100.88.12.3");
  });



  test("delivers backend events to authenticated event streams", async () => {
    const { gateway, info } = await startGateway({ keepaliveMs: 5 });

    const eventBody = await new Promise<string>((resolve, reject) => {
      const parsed = new URL(`${info.url}__orkestrator/events`);
      const request = httpRequest({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        headers: { authorization: `Bearer ${info.token}` },
      }, (response) => {
        let body = "";
        let emitted = false;
        response.on("data", (chunk) => {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (!emitted && body.includes(": connected") && body.includes(": keepalive")) {
            emitted = true;
            gateway.emit("menu-zoom", "in");
          }
          if (body.includes(": keepalive") && body.includes("\"event\":\"menu-zoom\"")) {
            response.destroy();
            resolve(body);
          }
        });
      });
      request.on("error", reject);
      request.end();
    });

    expect(eventBody).toContain(": connected");
    expect(eventBody).toContain(": keepalive");
    expect(eventBody).toContain("menu-zoom");
  });



  test("forces proxy upstream identity and compresses bounded response bodies once", async () => {
    const body = JSON.stringify({ value: "proxy response ".repeat(512) });
    const upstreamEncodings: Array<string | undefined> = [];
    const target = createServer((request, response) => {
      upstreamEncodings.push(request.headers["accept-encoding"]);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        etag: "\"identity-etag\"",
        "content-md5": "identity-md5",
        "content-digest": "sha-256=:identity:",
        "repr-digest": "sha-256=:identity:",
        digest: "sha-256=identity",
        "accept-ranges": "bytes",
      });
      response.end(body);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway({ compression: "body" });
    const result = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/body`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "br, gzip",
        },
      },
    );
    expect(upstreamEncodings).toEqual(["identity"]);
    expect(result.headers["content-encoding"]).toBe("br");
    expect(result.headers.vary).toContain("Accept-Encoding");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["content-md5"]).toBeUndefined();
    expect(result.headers["content-digest"]).toBeUndefined();
    expect(result.headers["repr-digest"]).toBeUndefined();
    expect(result.headers.digest).toBeUndefined();
    expect(result.headers["accept-ranges"]).toBeUndefined();
    expect(decodeResponseBody(result)).toBe(body);
    const metrics = await readGatewayMetrics(info);
    expect(metrics.routes["proxy-loopback"]?.encodings.br).toBe(1);
    const sample = metrics.recentRouteSamples.find(
      (candidate) => candidate.route === "proxy-loopback",
    );
    expect(sample?.contentEncoding).toBe("br");
    expect(sample?.responseBytes).toBe(result.rawBody.byteLength);
  });



  test("sync-flushes proxied SSE before the upstream stream ends", async () => {
    const target = createServer((request, response) => {
      expect(request.headers["accept-encoding"]).toBe("identity");
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
      });
      response.write("data: first\n\n");
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");
    const { info } = await startGateway({ compression: "on" });
    const endpoint = new URL(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/events`,
    );

    let downstream: ReturnType<typeof httpRequest> | null = null;
    const firstFrame = new Promise<string>((resolve, reject) => {
      downstream = httpRequest({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: endpoint.pathname,
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "gzip",
        },
      }, (response) => {
        expect(response.headers["content-encoding"]).toBe("gzip");
        const decoder = createGunzip({
          finishFlush: zlibConstants.Z_SYNC_FLUSH,
        });
        response.pipe(decoder);
        decoder.once("data", (chunk) => resolve(chunk.toString("utf8")));
        decoder.once("error", reject);
      });
      downstream.once("error", reject);
      downstream.end();
    });

    await expect(Promise.race([
      firstFrame,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("Proxied SSE frame was buffered")),
        1_000,
      )),
    ])).resolves.toContain("data: first");
    downstream?.destroy();
  });



  test("serves browser previews with rewritten root assets and iframe-safe headers", async () => {
    const target = createServer((request, response) => {
      if (request.url === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'",
          "x-frame-options": "DENY",
        });
        response.end('<script type="module" src="/src/main.js"></script>');
        return;
      }
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end('import "/src/dependency.js";');
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const prefix = `/__orkestrator/browser/loopback/${targetAddress.port}`;
    const headers = { authorization: `Bearer ${info.token}`, origin: "null" };

    const page = await requestUrl(`${info.url}${prefix}/`, { headers });
    expect(page.status).toBe(200);
    expect(page.body).toBe(`<script type="module" src="${prefix}/src/main.js"></script>`);
    expect(page.headers["x-frame-options"]).toBeUndefined();
    expect(page.headers["content-security-policy"]).toBeUndefined();
    expect(page.headers["access-control-allow-origin"]).toBe("null");
    expect(page.headers["access-control-allow-credentials"]).toBe("true");

    const script = await requestUrl(`${info.url}${prefix}/src/main.js`, { headers });
    expect(script.body).toBe(`import "${prefix}/src/dependency.js";`);
  });



  test("recompresses bounded browser-preview text after rewriting", async () => {
    const source = `<script src="/asset.js"></script>${" preview text".repeat(512)}`;
    const upstreamEncodings: Array<string | undefined> = [];
    const target = createServer((request, response) => {
      upstreamEncodings.push(request.headers["accept-encoding"]);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(source),
        etag: "\"upstream-identity\"",
        "content-md5": "identity-md5",
        "content-digest": "sha-256=:identity:",
        "repr-digest": "sha-256=:identity:",
        digest: "sha-256=identity",
        "accept-ranges": "bytes",
      });
      response.end(source);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway({ compression: "body" });
    const prefix = `/__orkestrator/browser/loopback/${address.port}`;
    const result = await requestUrl(`${info.url}${prefix}/`, {
      headers: {
        authorization: `Bearer ${info.token}`,
        origin: "null",
        "accept-encoding": "br, gzip",
      },
    });
    expect(upstreamEncodings).toEqual(["identity"]);
    expect(result.headers["content-encoding"]).toBe("br");
    expect(result.headers.etag).toBeUndefined();
    expect(result.headers["content-md5"]).toBeUndefined();
    expect(result.headers["content-digest"]).toBeUndefined();
    expect(result.headers["repr-digest"]).toBeUndefined();
    expect(result.headers.digest).toBeUndefined();
    expect(result.headers["accept-ranges"]).toBeUndefined();
    expect(result.headers.vary?.toLowerCase()).toContain("origin");
    expect(result.headers.vary?.toLowerCase()).toContain("accept-encoding");
    expect(decodeResponseBody(result)).toBe(
      `<script src="${prefix}/asset.js"></script>${" preview text".repeat(512)}`,
    );
  });



  test("decodes compressed preview text before rewriting it", async () => {
    const compressed = gzipSync('<script src="/asset.js"></script>');
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      response.end(compressed);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const prefix = `/__orkestrator/browser/loopback/${targetAddress.port}`;
    const result = await requestUrl(`${info.url}${prefix}/`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe(`<script src="${prefix}/asset.js"></script>`);
    expect(result.headers["content-encoding"]).toBeUndefined();
  });



  test("rejects compressed preview text that expands beyond the rewrite limit", async () => {
    const compressed = gzipSync(Buffer.alloc((8 * 1024 * 1024) + 1, 97));
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      response.end(compressed);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/large.css`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain("exceeded 8388608 decoded bytes");
  });



  test("passes non-UTF-8 preview documents through without rewriting", async () => {
    const body = '<script src="/asset.js"></script>';
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=iso-8859-1",
        "content-length": Buffer.byteLength(body),
      });
      response.end(body);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(200);
    expect(result.body).toBe(body);
  });

});

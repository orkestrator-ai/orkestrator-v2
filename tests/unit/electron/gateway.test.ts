import { chmod, mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
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
import {
  appendVary,
  BoundedMetricMap,
  canStartDynamicCompression,
  COMPRESSION_MIN_BYTES,
  compressBody,
  compressionModeForListener,
  type EventClientWriter,
  eventMatchesSubscription,
  GATEWAY_COMMAND_METRIC_MAP_LIMIT,
  GATEWAY_COMMAND_METRIC_TOTAL_LABEL_BYTES,
  GatewayMetricsStore,
  canStartStaticFallbackCompression,
  compressStaticFileWithinLimits,
  isTailscaleAddress,
  isCompressibleContentType,
  loadOrCreateGatewayToken,
  MAX_CONCURRENT_STATIC_FALLBACK_COMPRESSIONS,
  MAX_CONCURRENT_DYNAMIC_COMPRESSIONS,
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
  readStaticFileWithinLimit,
  resolveGatewayCompressionMode,
  rewriteBrowserPreviewBody,
  selectTailscaleBindAddress,
  truncateUtf8,
} from "../../../apps/backend/src/gateway";
import { createCommandRegistry } from "../../../apps/backend/src/core/commands";

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
): Promise<GatewayEventStream> {
  const parsed = new URL(`${info.url}__orkestrator/events${search}`);
  const known = new Set(eventClients(gateway).keys());
  let received = "";
  let aborted = false;
  const request = httpRequest({
    hostname: parsed.hostname,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    headers: { authorization: `Bearer ${info.token}` },
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
        await requestUrl(`${info.url}__orkestrator/metrics`, { headers: acceptsEverything }),
        await requestUrl(`${info.url}__orkestrator/invoke`, {
          method: "POST",
          headers: { ...acceptsEverything, "content-type": "application/json" },
          body: JSON.stringify({ command: "noop" }),
        }),
      ];

      for (const response of responses) {
        expect(response.status).toBeLessThan(400);
        expect(response.headers["content-encoding"]).toBeUndefined();
      }

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

  test("keeps the control listener identity and merges Origin with Accept-Encoding remotely", async () => {
    const dataDir = await createTempDir("ork-dynamic-control-");
    const rendererRoot = await createRendererRoot(dataDir);
    const payload = "private state ".repeat(512);
    const { gateway, info } = await startGateway({
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      compression: "body",
      allowedOrigins: ["https://client.example"],
      backend: { invoke: mock(async () => payload) },
    });
    expect(info.browserUrl).toBeDefined();
    const invoke = (baseUrl: string, origin?: string) => requestUrl(
      `${baseUrl}__orkestrator/invoke`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.token}`,
          "content-type": "application/json",
          "accept-encoding": "gzip",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ command: "large_response", args: {} }),
      },
    );

    const control = await invoke(info.url);
    expect(control.headers["content-encoding"]).toBeUndefined();
    expect(control.headers.vary).toBeUndefined();

    const browser = await invoke(info.browserUrl!, "https://client.example");
    expect(browser.headers["content-encoding"]).toBe("gzip");
    expect(browser.headers.vary?.toLowerCase().split(/,\s*/).sort()).toEqual([
      "accept-encoding",
      "origin",
    ]);
    expect(browser.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(decodeResponseBody(browser))).toEqual({ result: payload });
    expect(eventClients(gateway).size).toBe(0);
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

  test("merges Vary values without clobbering Origin", () => {
    expect(appendVary("Origin", "Accept-Encoding")).toBe("Origin, Accept-Encoding");
    expect(appendVary("origin, accept-encoding", "Accept-Encoding")).toBe("origin, accept-encoding");
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

  test("uses gzip-only fallback and leaves non-beneficial content as identity", async () => {
    const dataDir = await createTempDir("ork-static-fallback-selection-");
    const rendererRoot = await createRendererRoot(dataDir);
    await writeRendererAsset(
      rendererRoot,
      "assets/compressible-12345678.js",
      "console.log('gzip fallback');".repeat(200),
    );
    await writeRendererAsset(rendererRoot, "assets/tiny-12345678.txt", "x");

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    const gzip = await requestUrl(`${info.url}assets/compressible-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "gzip" },
    });
    expect(gzip.status).toBe(200);
    expect(gzip.headers["content-encoding"]).toBe("gzip");
    expect(decodeResponseBody(gzip)).toContain("gzip fallback");

    const identity = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: { ...authorization, "accept-encoding": "br, gzip" },
    });
    expect(identity.status).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();
    expect(identity.body).toBe("x");

    // Identity is acceptable here, so the identity metadata HEAD reports is
    // already accurate and nothing is withheld: the response stays usable for
    // revalidation and for discovering the resource size.
    const tinyHead = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      method: "HEAD",
      headers: { ...authorization, "accept-encoding": "br, gzip" },
    });
    expect(tinyHead.status).toBe(200);
    expect(tinyHead.headers["content-encoding"]).toBeUndefined();
    expect(tinyHead.headers["content-length"]).toBe("1");
    expect(tinyHead.headers.etag).toBe(String(identity.headers.etag));
    expect(tinyHead.rawBody.byteLength).toBe(0);

    const tinyHeadRevalidated = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip",
        "if-none-match": String(tinyHead.headers.etag),
      },
    });
    expect(tinyHeadRevalidated.status).toBe(304);
    expect(tinyHeadRevalidated.rawBody.byteLength).toBe(0);

    const wildcardHead = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      method: "HEAD",
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip",
        "if-none-match": "*",
      },
    });
    expect(wildcardHead.status).toBe(304);
    expect(wildcardHead.rawBody.byteLength).toBe(0);

    const unacceptable = await requestUrl(`${info.url}assets/tiny-12345678.txt`, {
      headers: {
        ...authorization,
        "accept-encoding": "br, gzip, identity;q=0",
      },
    });
    expect(unacceptable.status).toBe(200);
    expect(["br", "gzip"]).toContain(unacceptable.headers["content-encoding"]);
    expect(decodeResponseBody(unacceptable)).toBe("x");
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

  test("serves identity when a coded form was acceptable but the server declined it", async () => {
    const dataDir = await createTempDir("ork-static-declined-");
    const rendererRoot = await createRendererRoot(dataDir);
    const source = Buffer.alloc(MAX_STATIC_FALLBACK_SOURCE_BYTES + 1, 0x61);
    await writeRendererAsset(rendererRoot, "assets/large-12345678.js", source);

    const { info } = await startGateway({ dataDir, rendererRoot, compression: "body" });
    const authorization = { authorization: `Bearer ${info.token}` };
    // The client refused identity and br/gzip were both acceptable, so a 406
    // would be a lie: the asset is representable, this server just will not
    // spend 8MB+ of CPU and memory doing it.
    const response = await requestUrl(`${info.url}assets/large-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "br, gzip, identity;q=0" },
    });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.rawBody.byteLength).toBe(source.byteLength);

    const head = await requestUrl(`${info.url}assets/large-12345678.js`, {
      method: "HEAD",
      headers: { ...authorization, "accept-encoding": "br, gzip, identity;q=0" },
    });
    expect(head.status).toBe(response.status);
    expect(head.headers["content-encoding"]).toBeUndefined();
    expect(head.headers["content-length"]).toBe(String(source.byteLength));

    // Only a request that accepts *nothing* is a real 406.
    const unrepresentable = await requestUrl(`${info.url}assets/large-12345678.js`, {
      headers: { ...authorization, "accept-encoding": "identity;q=0" },
    });
    expect(unrepresentable.status).toBe(406);
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

  test("reads fallback sources through a stat-verified bounded file handle", async () => {
    const root = await createTempDir("ork-static-bounded-read-");
    const filePath = path.join(root, "asset.js");
    await writeFile(filePath, "small source");
    const originalStat = await stat(filePath);

    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toEqual(Buffer.from("small source"));

    await writeFile(filePath, Buffer.alloc(1024 * 1024, 0x61));
    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toBeNull();
    expect(
      await readStaticFileWithinLimit(
        filePath,
        originalStat.mtimeMs,
        MAX_STATIC_FALLBACK_SOURCE_BYTES + 1,
      ),
    ).toBeNull();
    expect(
      await readStaticFileWithinLimit(
        path.join(root, "missing.js"),
        originalStat.mtimeMs,
        originalStat.size,
      ),
    ).toBeNull();
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

  test("collapses per-entity event names and rejects unusable labels", () => {
    expect(normalizeGatewayEventMetricKey("terminal-output-session-1")).toBe("terminal-output");
    expect(normalizeGatewayEventMetricKey("terminal-output-tmux:env:tab")).toBe("terminal-output-tmux");
    // One label per container would otherwise evict genuine event names.
    expect(normalizeGatewayEventMetricKey("claude-state-abc123")).toBe("claude-state");
    expect(normalizeGatewayEventMetricKey("claude-state-def456")).toBe("claude-state");
    expect(normalizeGatewayEventMetricKey("environment-renamed")).toBe("environment-renamed");
    expect(normalizeGatewayEventMetricKey("container-log")).toBe("container-log");

    expect(normalizeMetricLabel("get_environments")).toBe("get_environments");
    expect(normalizeMetricLabel("  spaced  ")).toBe("spaced");
    expect(normalizeMetricLabel("ok.name:v1-2")).toBe("ok.name:v1-2");
    expect(normalizeMetricLabel("9leading")).toBe("__invalid__");
    expect(normalizeMetricLabel("has space")).toBe("__invalid__");
    expect(normalizeMetricLabel("")).toBe("__invalid__");
    expect(normalizeMetricLabel("x".repeat(97))).toBe("__invalid__");
    // `__proto__` must not survive into a label that later becomes an object key.
    expect(normalizeMetricLabel("__proto__")).toBe("__invalid__");
    // Reserved buckets pass through even though they fail the label pattern.
    for (const reserved of ["__overflow__", "__invalid__", "__unknown__", "__keepalive__"]) {
      expect(normalizeMetricLabel(reserved)).toBe(reserved);
    }
  });

  test("authenticates metrics routes and validates, sanitizes, and evicts client reports", async () => {
    const { info } = await startGateway();
    const metricsUrl = `${info.url}__orkestrator/metrics`;
    const clientMetricsUrl = `${info.url}__orkestrator/client-metrics`;
    const authorization = { authorization: `Bearer ${info.token}` };

    expect((await requestUrl(metricsUrl)).status).toBe(401);
    const wrongMetricsMethod = await requestUrl(metricsUrl, {
      method: "POST",
      headers: authorization,
    });
    expect(wrongMetricsMethod.status).toBe(405);
    expect(wrongMetricsMethod.headers.allow).toBe("GET");

    expect((await requestUrl(clientMetricsUrl, { method: "POST" })).status).toBe(401);
    const wrongClientMethod = await requestUrl(clientMetricsUrl, { headers: authorization });
    expect(wrongClientMethod.status).toBe(405);
    expect(wrongClientMethod.headers.allow).toBe("POST");

    const headers = {
      ...authorization,
      "content-type": "application/json",
    };
    const malformed = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json()).toEqual({ error: "Malformed JSON request body" });

    const nonObject = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: "[]",
    });
    expect(nonObject.status).toBe(400);
    expect(nonObject.json()).toEqual({ error: "Expected JSON object body" });

    const oversized = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(64 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json()).toEqual({ error: "Request body is too large" });

    const sanitized = await requestUrl(clientMetricsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        platform: "not-a-platform",
        navigationType: "not-navigation",
        nextHopProtocol: "💣".repeat(100),
        resourceCount: -1,
        loadEventMs: 700_000,
      }),
    });
    expect(sanitized.status).toBe(202);
    const sanitizedMetrics = await readGatewayMetrics(info);
    expect(sanitizedMetrics.recentClientBootReports.at(-1)).toMatchObject({
      platform: "unknown",
      navigationType: "unknown",
      nextHopProtocol: "other",
      resourceCount: null,
      loadEventMs: null,
    });

    for (let resourceCount = 0; resourceCount < 40; resourceCount += 1) {
      const response = await requestUrl(clientMetricsUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          platform: "desktop-browser",
          navigationType: "navigate",
          nextHopProtocol: resourceCount === 39 ? "AValidLookingSecretToken" : "h2",
          resourceCount,
        }),
      });
      expect(response.status).toBe(202);
    }

    const metrics = await readGatewayMetrics(info);
    expect(metrics.recentRouteSamples).toHaveLength(32);
    expect(metrics.recentClientBootReports).toHaveLength(32);
    expect(metrics.recentClientBootReports[0]?.resourceCount).toBe(8);
    expect(metrics.recentClientBootReports.at(-1)?.resourceCount).toBe(39);
    expect(metrics.recentClientBootReports[0]?.nextHopProtocol).toBe("h2");
    expect(metrics.recentClientBootReports.at(-1)?.nextHopProtocol).toBe("other");
    expect(metrics.recentClientBootReports.every((report) => (
      report.platform === "desktop-browser"
      && report.navigationType === "navigate"
    ))).toBe(true);
    expect(metrics.routes["client-metrics"]).toMatchObject({
      requests: 46,
      statusCodes: {
        "202": 41,
        "400": 2,
        "405": 1,
        "413": 1,
      },
    });
    expect(metrics.routes["client-metrics"]!.requestBytes).toBeGreaterThan(0);
    expect(metrics.routes["client-metrics"]!.responseBytes).toBeGreaterThan(0);
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

  test("never retains a rejected command name, including when the registry is not consulted", async () => {
    const secretLikeName = "AValidLookingSecretToken1234567890";
    // Mirrors OrkestratorBackend: shutdown is refused before the registry
    // lookup, so the error text says nothing about whether the name is known.
    let shuttingDown = false;
    const backend = {
      invoke: mock(async (command: string) => {
        if (shuttingDown) throw new Error("Backend is shutting down");
        if (command !== "registered_command") {
          throw new Error(`Unknown backend command: ${command}`);
        }
        return { ok: true };
      }),
      hasCommand: (command: string) => command === "registered_command",
    };
    const { info } = await startGateway({ backend });
    const invoke = (command: string) => requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command }),
    });

    expect((await invoke(secretLikeName)).status).toBe(500);
    shuttingDown = true;
    expect((await invoke(`${secretLikeName}Shutdown`)).status).toBe(500);
    expect((await invoke("registered_command")).status).toBe(500);

    const metrics = await readGatewayMetrics(info);
    const keys = Object.keys(metrics.commands);
    expect(keys.some((key) => key.includes("SecretToken"))).toBe(false);
    expect(metrics.commands.__unknown__).toMatchObject({ count: 2, failures: 2 });
    // A registered command keeps its own bucket even when it fails.
    expect(metrics.commands.registered_command).toMatchObject({ count: 1, failures: 1 });
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

  test("filters terminal prefixes while restoring explicitly subscribed sessions", () => {
    expect(parseEventSubscriptionFilter(" terminal-output-one, menu- ")).toEqual([
      "terminal-output-one",
      "menu-",
    ]);
    expect(eventMatchesSubscription(
      "menu-zoom",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(false);
    expect(eventMatchesSubscription(
      "terminal-output-one",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(true);
    expect(eventMatchesSubscription(
      "terminal-output-two",
      null,
      ["terminal-output-one"],
      ["terminal-output-"],
    )).toBe(false);
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
    gateway.emit(event, { bytesBase64: pane });
    expect(stream.received()).not.toContain(pane);
    releaseBufferedBytes(stream.response);
    gateway.emit(event, { bytesBase64: randomBytes(256).toString("base64") });
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
    const frameBytes = Buffer.byteLength(
      `data: ${JSON.stringify({ event: "environment-renamed", payload })}\n\n`,
    );

    // Two healthy subscribers: the frame really is written twice, so both the
    // count and the byte total scale with deliveries rather than with emits.
    gateway.emit("environment-renamed", payload);
    await waitUntil(
      () => first.received().includes("environment-renamed")
        && second.received().includes("environment-renamed"),
      "Both streams should have received the frame",
    );
    metrics = await readGatewayMetrics(info);
    expect(metrics.events["environment-renamed"]).toEqual({
      frames: 2,
      wireBytes: frameBytes * 2,
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
    expect(metrics.events["environment-renamed"]).toMatchObject({
      frames: 4,
      wireBytes: frameBytes * 4,
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

  test("counts actual event writes, bounds labels, and closes each stream exactly once", async () => {
    const { gateway, info } = await startGateway();
    const lagging = await openEventStream(gateway, info);
    const healthy = await openEventStream(gateway, info);
    const payload = { bytesBase64: "eA==" };
    const terminalMessage = `data: ${JSON.stringify({
      event: "terminal-output-session-a",
      payload,
    })}\n\n`;

    pinBufferedBytes(lagging.response, 2 * 1024 * 1024);
    gateway.emit("terminal-output-session-a", payload);
    await waitUntil(
      () => healthy.received().includes("terminal-output-session-a"),
      "Healthy stream never received the terminal frame",
    );

    pinBufferedBytes(lagging.response, 8 * 1024 * 1024 + 1);
    gateway.emit("environment-changed", { id: "env" });
    await waitUntil(() => lagging.aborted(), "Lagging stream was never dropped");
    await waitUntil(
      () => healthy.received().includes("environment-changed"),
      "Healthy stream never received the authoritative event",
    );

    let metrics = await readGatewayMetrics(info);
    expect(metrics.stream).toMatchObject({
      open: 1,
      connecting: 0,
      opened: 2,
      closed: 1,
      dropped: 1,
      stalled: 1,
      softDesyncs: 1,
    });
    expect(metrics.events["terminal-output"]).toEqual({
      frames: 1,
      wireBytes: Buffer.byteLength(terminalMessage),
      droppedFrames: 1,
      droppedClients: 0,
    });
    expect(metrics.events["environment-changed"]).toMatchObject({
      frames: 1,
      droppedClients: 1,
    });

    // Terminal identifiers collapse to fixed categories, and arbitrary labels
    // can consume neither unbounded bytes nor unbounded map entries.
    gateway.emit("terminal-output-tmux:env:tab:one", payload);
    gateway.emit(`${"x".repeat(1_000)} secret`, null);
    for (let index = 0; index < 150; index += 1) {
      gateway.emit(`event-${index}`, index);
    }
    await waitUntil(
      () => healthy.received().includes('"event":"event-149"'),
      "Event cardinality frames did not reach the healthy stream",
    );

    metrics = await readGatewayMetrics(info);
    const eventKeys = Object.keys(metrics.events);
    expect(eventKeys).toContain("terminal-output-tmux");
    expect(eventKeys).toContain("__invalid__");
    expect(eventKeys).toContain("__overflow__");
    expect(eventKeys.every((key) => !key.includes("secret"))).toBe(true);
    expect(eventKeys).toHaveLength(128);
    expect(eventKeys.every((key) => Buffer.byteLength(key) <= 96)).toBe(true);
    expect(eventKeys.reduce((total, key) => total + Buffer.byteLength(key), 0)).toBeLessThanOrEqual(8 * 1024);

    healthy.response.destroy();
    healthy.close();
    await waitUntil(
      () => eventClients(gateway).size === 0,
      "Healthy stream did not close",
    );
    metrics = await readGatewayMetrics(info);
    expect(metrics.stream).toMatchObject({
      open: 0,
      opened: 2,
      closed: 2,
      dropped: 1,
    });
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

  test("retains only the latest refused tmux repaint and flushes it on drain", async () => {
    const dataDir = await createTempDir("ork-gateway-tmux-soft-limit-");
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
      writableLength: 1024 * 1024,
      write: mock((message: string) => {
        writes.push(message);
        return false;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: ["terminal-output-tmux:env:tab:one"],
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);

    gateway.emit("terminal-output-tmux:env:tab:one", {
      bytesBase64: Buffer.from("old pane").toString("base64"),
    });
    gateway.emit("terminal-output-tmux:env:tab:one", {
      bytesBase64: Buffer.from("latest pane").toString("base64"),
    });
    gateway.emit("environment-changed", { id: "env" });
    expect(writes).toEqual([]);

    client.writableLength = 0;
    const flushed = (
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state);

    expect(flushed).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(Buffer.from("latest pane").toString("base64"));
    expect(writes[0]).not.toContain(Buffer.from("old pane").toString("base64"));
    expect(writes[0]).not.toContain('"desynced":true');
    expect(state.desyncedSessions.size).toBe(0);
  });

  test("retains one latest repaint per session for a multiplexed terminal stream", async () => {
    // A same-origin browser now multiplexes every mounted terminal onto one
    // filtered stream, so a lagging client can owe recovery frames for several
    // tmux sessions at once. Retention is per session, not per socket.
    const dataDir = await createTempDir("ork-gateway-tmux-multiplexed-");
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
      writableLength: 1024 * 1024,
      write: mock((message: string) => {
        writes.push(message);
        return false;
      }),
      destroy: mock(() => undefined),
    };
    const state = {
      prefixes: null,
      includedPrefixes: [
        "terminal-output-tmux:env:tab:one",
        "terminal-output-tmux:env:tab:two",
      ],
      excludedPrefixes: ["terminal-output-"],
      desyncedSessions: new Set<string>(),
    };
    const clients = (
      gateway as unknown as { clients: Map<object, typeof state> }
    ).clients;
    clients.set(client, state);

    gateway.emit("terminal-output-tmux:env:tab:one", {
      bytesBase64: Buffer.from("one old").toString("base64"),
    });
    gateway.emit("terminal-output-tmux:env:tab:two", {
      bytesBase64: Buffer.from("two old").toString("base64"),
    });
    gateway.emit("terminal-output-tmux:env:tab:one", {
      bytesBase64: Buffer.from("one latest").toString("base64"),
    });
    gateway.emit("terminal-output-tmux:env:tab:two", {
      bytesBase64: Buffer.from("two latest").toString("base64"),
    });
    expect(writes).toEqual([]);
    expect(state.desyncedSessions).toEqual(
      new Set(["tmux:env:tab:one", "tmux:env:tab:two"]),
    );

    client.writableLength = 0;
    const flushed = (
      gateway as unknown as {
        flushDesyncNotices(client: object, state: typeof state): boolean;
      }
    ).flushDesyncNotices(client, state);

    expect(flushed).toBe(true);
    // One recovery frame per session, each the newest full-pane repaint — not a
    // single frame for whichever session lagged last.
    expect(writes).toHaveLength(2);
    const combined = writes.join("");
    expect(combined).toContain(Buffer.from("one latest").toString("base64"));
    expect(combined).toContain(Buffer.from("two latest").toString("base64"));
    expect(combined).not.toContain(Buffer.from("one old").toString("base64"));
    expect(combined).not.toContain(Buffer.from("two old").toString("base64"));
    expect(combined).not.toContain('"desynced":true');
    expect(state.desyncedSessions.size).toBe(0);
  });

  test("disconnects before a current frame would exceed the hard buffer limit", async () => {
    const dataDir = await createTempDir("ork-gateway-hard-limit-");
    const rendererRoot = await createRendererRoot(dataDir);
    const logger = createLogger();
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    const client = {
      writableLength: 8 * 1024 * 1024 - 10,
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

    gateway.emit("environment-changed", { id: "environment-a" });
    expect(client.write).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledTimes(1);
    expect(clients.has(client)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
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

  test("subscribes a connecting stream from its own query string", async () => {
    const { gateway, info } = await startGateway();
    const scoped = await openEventStream(gateway, info, "?events=menu-");
    const terminal = await openEventStream(
      gateway,
      info,
      "?excludeEvents=terminal-output-&includeEvents=terminal-output-one",
    );

    gateway.emit("terminal-output-two", { bytesBase64: "dHdv" });
    gateway.emit("environment-changed", { id: "env" });
    gateway.emit("terminal-output-one", { bytesBase64: "b25l" });
    gateway.emit("menu-zoom", "in");

    // Each stream is ordered, so waiting for the last permitted event proves the
    // earlier ones were filtered rather than merely still in flight.
    await waitUntil(
      () => scoped.received().includes("menu-zoom"),
      "Scoped stream never received its subscribed event",
    );
    await waitUntil(
      () => terminal.received().includes("terminal-output-one"),
      "Terminal stream never received its restored session",
    );

    expect(scoped.received()).not.toContain("environment-changed");
    expect(scoped.received()).not.toContain("terminal-output-");
    expect(terminal.received()).not.toContain("terminal-output-two");
    expect(terminal.received()).not.toContain("menu-zoom");

    scoped.close();
    terminal.close();
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

  test("leaves application string literals and already-proxied paths untouched", () => {
    const prefix = "/__orkestrator/browser/loopback/3000";
    const target = new URL("http://127.0.0.1:3000/");
    const source = [
      'const parts = location.pathname.split("/");',
      'const key = ["users", id].join("/");',
      'createBrowserRouter([{ path: "/", element: root }]);',
      'if (route.startsWith("/admin")) {}',
      "const icon = '/assets/icon.svg';",
      `const proxied = "${prefix}";`,
      `import "${prefix}/src/dep.js";`,
    ].join("\n");

    expect(rewriteBrowserPreviewBody(source, prefix, target, "js")).toBe(source);
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

  test("persists a generated auth token and honors an explicit environment token", async () => {
    const dataDir = await createTempDir("ork-gateway-auth-");
    const generated = await loadOrCreateGatewayToken(dataDir, {});
    expect(generated.token.length).toBeGreaterThanOrEqual(16);
    expect((await stat(generated.authFile)).mode & 0o777).toBe(0o600);

    const loaded = await loadOrCreateGatewayToken(dataDir, {});
    expect(loaded.token).toBe(generated.token);

    const explicit = await loadOrCreateGatewayToken(dataDir, {
      ORKESTRATOR_GATEWAY_TOKEN: "explicit-token-value",
    });
    expect(explicit.token).toBe("explicit-token-value");
    expect(explicit).toMatchObject({ editable: false, source: "environment" });

    await expect(loadOrCreateGatewayToken(dataDir, {
      ORKESTRATOR_GATEWAY_TOKEN: "short",
    })).rejects.toThrow("Invalid ORKESTRATOR_GATEWAY_TOKEN");

    await writeFile(generated.authFile, JSON.stringify({ token: "invalid" }));
    const repaired = await loadOrCreateGatewayToken(dataDir, {});
    expect(repaired.token).not.toBe("invalid");
    expect(JSON.parse(await readFile(generated.authFile, "utf8"))).toEqual({ token: repaired.token });
  });

  test("honors startup guardrails for disabled, missing, invalid, and non-Tailscale binds", async () => {
    const dataDir = await createTempDir("ork-gateway-guard-");
    const rendererRoot = await createRendererRoot(dataDir);
    const logger = createLogger();

    const disabled = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      env: { ORKESTRATOR_GATEWAY_DISABLED: "1" },
      logger,
    });
    expect(await disabled.start()).toBeNull();

    const noTailscale = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      interfaces: { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }] },
      env: {},
      logger,
    });
    expect(await noTailscale.start()).toBeNull();

    const loopbackFallback = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      fallbackBindAddress: "127.0.0.1",
      port: 0,
      interfaces: { en0: [{ address: "192.168.1.20", family: "IPv4", internal: false, netmask: "255.255.255.0", cidr: null, mac: "00:00:00:00:00:00" }] },
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    gateways.push(loopbackFallback);
    await expect(loopbackFallback.start()).resolves.toMatchObject({ bindAddress: "127.0.0.1" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("falling back to 127.0.0.1"));

    const nonTailscaleFallback = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      fallbackBindAddress: "0.0.0.0",
      interfaces: {},
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    await expect(nonTailscaleFallback.start()).rejects.toThrow("Refusing to bind gateway to non-Tailscale address");

    const nonTailscaleBind = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger,
    });
    await expect(nonTailscaleBind.start()).rejects.toThrow("Refusing to bind gateway to non-Tailscale address");

    const invalidPort = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "100.88.12.3",
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456", ORKESTRATOR_GATEWAY_PORT: "nope" },
      logger,
    });
    await expect(invalidPort.start()).rejects.toThrow("Invalid gateway port");
  });

  test("keeps a loopback control listener separate from the browser listener", async () => {
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });

    expect(info.browserUrl).toBeTruthy();
    expect(info.url).not.toBe(info.browserUrl);
    const headers = { authorization: `Bearer ${info.token}` };
    const controlResponse = await requestUrl(info.url, { headers });
    const browserResponse = await requestUrl(info.browserUrl!, { headers });
    expect(controlResponse.status).toBe(200);
    expect(browserResponse.status).toBe(200);
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

  test("allows only the authenticated control listener to manage Electron web access", async () => {
    const getStatus = mock(() => ({ enabled: false, running: false, url: null, error: null }));
    const setEnabled = mock(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: enabled ? "https://workstation.example.ts.net/" : null,
      error: null,
    }));
    const resetServe = mock(async () => ({
      enabled: true,
      running: true,
      url: "https://workstation.example.ts.net/",
      error: null,
    }));
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: { getStatus, setEnabled, resetServe },
    });
    const path = "__orkestrator/web-client-access";
    const headers = { authorization: `Bearer ${info.token}` };

    const initial = await requestUrl(`${info.url}${path}`, { headers });
    expect(initial.status).toBe(200);
    expect(initial.json()).toMatchObject({ enabled: false, running: false });

    const enabled = await requestUrl(`${info.url}${path}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, running: true });
    expect(setEnabled).toHaveBeenCalledWith(true);

    const reset = await requestUrl(`${info.url}${path}`, { method: "DELETE", headers });
    expect(reset.status).toBe(200);
    expect(reset.json()).toMatchObject({ running: true });
    expect(resetServe).toHaveBeenCalledTimes(1);

    const browserAttempt = await requestUrl(`${info.browserUrl}${path}`, { headers });
    expect(browserAttempt.status).toBe(404);
    const unauthenticated = await requestUrl(`${info.url}${path}`);
    expect(unauthenticated.status).toBe(401);
  });

  test("validates web access methods and request bodies", async () => {
    const setEnabled = mock(async (enabled: boolean) => ({
      enabled,
      running: enabled,
      url: null,
      error: null,
    }));
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: {
        getStatus: () => ({ enabled: false, running: false, url: null, error: null }),
        setEnabled,
        resetServe: async () => ({ enabled: true, running: true, url: null, error: null }),
      },
    });
    const endpoint = `${info.url}__orkestrator/web-client-access`;
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };

    const wrongMethod = await requestUrl(endpoint, { method: "POST", headers });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, PUT, DELETE");

    for (const body of ["{", "[]", "{}", JSON.stringify({ enabled: "yes" })]) {
      const response = await requestUrl(endpoint, { method: "PUT", headers, body });
      expect(response.status).toBe(400);
    }

    const oversized = await requestUrl(endpoint, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, padding: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    expect(setEnabled).not.toHaveBeenCalled();
  });

  test("surfaces web access controller failures without affecting other control requests", async () => {
    const { info } = await startGateway({
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
      webClientControl: {
        getStatus: () => ({ enabled: true, running: false, url: null, error: null }),
        setEnabled: async () => { throw new Error("lifecycle unavailable"); },
        resetServe: async () => { throw new Error("reset unavailable"); },
      },
    });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };
    const failed = await requestUrl(`${info.url}__orkestrator/web-client-access`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true }),
    });
    expect(failed.status).toBe(500);
    expect(failed.json()).toEqual({ error: "lifecycle unavailable" });

    const resetFailed = await requestUrl(`${info.url}__orkestrator/web-client-access`, {
      method: "DELETE",
      headers,
    });
    expect(resetFailed.status).toBe(500);
    expect(resetFailed.json()).toEqual({ error: "reset unavailable" });

    const status = await requestUrl(`${info.url}__orkestrator/status`, { headers });
    expect(status.status).toBe(200);
  });

  test("keeps desktop control available and selects another browser port when the preferred port is occupied", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    auxiliaryServers.push(occupied);
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const occupiedAddress = occupied.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") throw new Error("Expected TCP address");

    const { info } = await startGateway({
      port: occupiedAddress.port,
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });

    expect(info.browserUrl).toBeTruthy();
    expect(info.browserError).toBeUndefined();
    expect(new URL(info.browserUrl!).port).not.toBe(String(occupiedAddress.port));
    const headers = { authorization: `Bearer ${info.token}` };
    const response = await requestUrl(info.url, {
      headers,
    });
    const browserResponse = await requestUrl(info.browserUrl!, {
      headers,
    });
    expect(response.status).toBe(200);
    expect(browserResponse.status).toBe(200);
  });

  test("uses an ephemeral browser port after every nearby fallback port is occupied", async () => {
    const occupied = await occupyContiguousPorts(21);
    auxiliaryServers.push(...occupied.servers);
    const logger = createLogger();

    const { info } = await startGateway({ port: occupied.start, logger });
    const selectedPort = Number(new URL(info.browserUrl!).port);

    expect(selectedPort < occupied.start || selectedPort > occupied.start + 20).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nearby ports were in use"));
  });

  test("falls back to an ephemeral port when port 65535 is occupied", async () => {
    const occupied = createServer((_request, response) => response.end("occupied"));
    try {
      await new Promise<void>((resolve, reject) => {
        occupied.once("error", reject);
        occupied.listen(65_535, "127.0.0.1", () => {
          occupied.off("error", reject);
          resolve();
        });
      });
      auxiliaryServers.push(occupied);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }

    const { info } = await startGateway({ port: 65_535 });

    expect(new URL(info.browserUrl!).port).not.toBe("65535");
  });

  test("rejects a non-loopback control listener", async () => {
    await expect(startGateway({ controlBindAddress: "0.0.0.0" })).rejects.toThrow(
      "Control listener must use a loopback address",
    );
  });

  test("requires authentication before invoking backend commands", async () => {
    const dataDir = await createTempDir("ork-gateway-server-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), "<div id=\"root\"></div>");

    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => ({ command, args })),
    };
    const gateway = new OrkestratorGateway({
      backend,
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();
    expect(info).not.toBeNull();

    const unauthenticated = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "get_projects" }),
    });
    expect(unauthenticated.status).toBe(401);

    const authenticated = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "get_projects", args: { projectId: "project-1" } }),
    });
    expect(authenticated.status).toBe(200);
    expect(authenticated.json()).toEqual({
      result: { command: "get_projects", args: { projectId: "project-1" } },
    });
    expect(backend.invoke).toHaveBeenCalledWith("get_projects", { projectId: "project-1" });

    const badCommand = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: 123 }),
    });
    expect(badCommand.status).toBe(400);

    // A body the caller can correct is a 4xx. Before, both of these escaped to
    // the generic server catch and reported 500, which reads as a backend fault.
    const malformedJson = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.json()).toEqual({ error: "Malformed JSON request body" });

    backend.invoke.mockImplementationOnce(async () => {
      throw new Error("backend failed");
    });
    const backendError = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info!.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ command: "explode" }),
    });
    expect(backendError.status).toBe(500);
    expect(backendError.json()).toEqual({ error: "backend failed" });
  });

  test("accepts command bodies far larger than the shared JSON limit and rejects oversized ones with 413", async () => {
    const dataDir = await createTempDir("ork-gateway-invoke-size-");
    await createRendererRoot(dataDir);

    const backend = {
      invoke: mock(async (command: string, args: Record<string, unknown>) => ({
        command,
        snapshotLength: (args.snapshot as string | undefined)?.length ?? 0,
      })),
    };
    const gateway = new OrkestratorGateway({
      backend,
      dataDir,
      rendererRoot: path.join(dataDir, "dist"),
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: createLogger(),
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();
    expect(info).not.toBeNull();

    const headers = {
      authorization: `Bearer ${info!.token}`,
      "content-type": "application/json",
    };

    /*
     * Durable snapshots — agent handoffs above all — routinely exceed the 1 MiB
     * body limit the other JSON routes use. This route has to clear the 32 MB
     * storage limit or those limits are unreachable and a legitimate save fails
     * as a transport error.
     */
    const largeSnapshot = "x".repeat(4 * 1024 * 1024);
    const accepted = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "save_agent_handoff",
        args: { snapshot: largeSnapshot },
      }),
    });
    expect(accepted.status).toBe(200);
    expect(accepted.json()).toEqual({
      result: { command: "save_agent_handoff", snapshotLength: largeSnapshot.length },
    });

    const oversized = await requestUrl(`${info!.url}__orkestrator/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        command: "save_agent_handoff",
        args: { snapshot: "x".repeat(49 * 1024 * 1024) },
      }),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.json()).toEqual({ error: "Request body is too large" });
    expect(backend.invoke).toHaveBeenCalledTimes(1);
  });

  test("allows configured public client origins without proxying browser traffic", async () => {
    const { info } = await startGateway({
      allowedOrigins: [
        "https://orkestrator.dev",
        "https://www.orkestrator.dev",
        "https://*.vercel.app",
      ],
    });
    const endpoint = `${info.url}__orkestrator/status`;

    const preflight = await requestUrl(endpoint, {
      method: "OPTIONS",
      headers: {
        origin: "https://orkestrator.dev",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://orkestrator.dev");
    expect(preflight.headers["access-control-allow-private-network"]).toBe("true");
    // Remote renderers authenticate bridge calls with these headers, so a
    // preflight that omits one blocks every request to that bridge from the
    // browser.
    expect(preflight.headers["access-control-allow-headers"]).toBe(
      "Authorization, Content-Type, X-Orkestrator-Codex-Token, X-Orkestrator-Claude-Token, X-Orkestrator-OpenCode-Token",
    );

    const connected = await requestUrl(endpoint, {
      headers: {
        origin: "https://www.orkestrator.dev",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(connected.status).toBe(200);
    expect(connected.json()).toEqual({ ok: true });
    expect(connected.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const preview = await requestUrl(endpoint, {
      headers: {
        origin: "https://orkestrator-git-main-team.vercel.app",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(preview.status).toBe(200);

    const rejected = await requestUrl(endpoint, {
      headers: {
        origin: "https://untrusted.example",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.json()).toEqual({ error: "Origin not allowed" });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();

    const unauthenticated = await requestUrl(endpoint, {
      headers: { origin: "https://www.orkestrator.dev" },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const wrongMethod = await requestUrl(endpoint, {
      method: "POST",
      headers: {
        origin: "https://www.orkestrator.dev",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers["access-control-allow-origin"]).toBe("https://www.orkestrator.dev");

    const sameHost = await requestUrl(endpoint, {
      headers: {
        origin: new URL(info.url).origin,
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(sameHost.status).toBe(200);

    const malformed = await requestUrl(endpoint, {
      headers: {
        origin: "not an origin",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(malformed.status).toBe(403);
  });

  test("supports allow-all and trailing-slash origin rules", async () => {
    const wildcard = await startGateway({ allowedOrigins: ["*"] });
    const anyOrigin = await requestUrl(`${wildcard.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://anything.example",
        authorization: `Bearer ${wildcard.info.token}`,
      },
    });
    expect(anyOrigin.status).toBe(200);
    expect(anyOrigin.headers["access-control-allow-origin"]).toBe("https://anything.example");

    const trailing = await startGateway({ allowedOrigins: ["https://trailing.example/"] });
    const normalized = await requestUrl(`${trailing.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://trailing.example",
        authorization: `Bearer ${trailing.info.token}`,
      },
    });
    expect(normalized.status).toBe(200);

    const rejected = await requestUrl(`${trailing.info.url}__orkestrator/status`, {
      headers: {
        origin: "https://other.example",
        authorization: `Bearer ${trailing.info.token}`,
      },
    });
    expect(rejected.status).toBe(403);
  });

  test("reads CORS origins from the environment and honors wildcard ports", async () => {
    const { info } = await startGateway({
      env: {
        ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456",
        ORKESTRATOR_GATEWAY_ALLOWED_ORIGINS: "https://*.preview.example:8443",
      },
    });
    const endpoint = `${info.url}__orkestrator/status`;

    const allowed = await requestUrl(endpoint, {
      headers: {
        origin: "https://branch.preview.example:8443",
        authorization: `Bearer ${info.token}`,
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://branch.preview.example:8443");

    for (const origin of [
      "https://preview.example:8443",
      "https://branch.preview.example:9443",
      "http://branch.preview.example:8443",
    ]) {
      const rejected = await requestUrl(endpoint, {
        headers: { origin, authorization: `Bearer ${info.token}` },
      });
      expect(rejected.status).toBe(403);
    }
  });

  test("sets and clears the auth cookie through login and logout", async () => {
    const { info } = await startGateway();

    const loginPage = await requestUrl(`${info.url}__orkestrator/login`, {
      headers: { accept: "text/html" },
    });
    expect(loginPage.status).toBe(200);
    expect(loginPage.body).toContain("Orkestrator Gateway");

    const rejected = await requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=wrong-token",
    });
    expect(rejected.status).toBe(401);
    expect(rejected.body).toContain("Invalid gateway token");

    const accepted = await requestUrl(`${info.url}__orkestrator/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(info.token)}`,
    });
    expect(accepted.status).toBe(303);
    expect(accepted.headers["set-cookie"]?.[0]).toContain("orkestrator_gateway_auth=");

    const logout = await requestUrl(`${info.url}__orkestrator/logout`, {
      headers: { cookie: `orkestrator_gateway_auth=${info.token}` },
    });
    expect(logout.status).toBe(303);
    expect(logout.headers["set-cookie"]?.[0]).toContain("Max-Age=0");
  });

  test("returns and rotates the persisted token for an authenticated client", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    const oldCookie = `orkestrator_gateway_auth=${info.token}`;

    const current = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(current.status).toBe(200);
    expect(current.json()).toEqual({ token: info.token, editable: true, source: "file" });

    const replacement = "replacement-token-123456";
    const updated = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        cookie: oldCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: replacement }),
    });
    expect(updated.status).toBe(200);
    expect(updated.json()).toEqual({ token: replacement, editable: true, source: "file" });
    expect(updated.headers["set-cookie"]?.[0]).toContain(`orkestrator_gateway_auth=${replacement}`);

    const rejectedOldToken = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(rejectedOldToken.status).toBe(401);

    const acceptedNewToken = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: `orkestrator_gateway_auth=${replacement}` },
    });
    expect(acceptedNewToken.status).toBe(200);
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe(replacement);
  });

  test("rejects invalid token boundaries before changing the active credential", async () => {
    const { info } = await startGateway({ env: {} });
    const oldCookie = `orkestrator_gateway_auth=${info.token}`;
    const invalidTokens = [
      "short",
      "a".repeat(1025),
      "\ud800".repeat(16),
      "😀".repeat(512),
    ];

    for (const token of invalidTokens) {
      const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
        method: "PUT",
        headers: { cookie: oldCookie, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      expect(response.status).toBe(400);
    }

    const stillAuthenticated = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      headers: { cookie: oldCookie },
    });
    expect(stillAuthenticated.status).toBe(200);
    expect(stillAuthenticated.json()).toMatchObject({ token: info.token });
  });

  test("normalizes valid token whitespace before persistence and cookie issuance", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        cookie: `orkestrator_gateway_auth=${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "  replacement-token-123456  " }),
    });

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({ token: "replacement-token-123456" });
    expect(response.headers["set-cookie"]?.[0]).toContain("replacement-token-123456");
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe("replacement-token-123456");
  });

  test("returns client errors for malformed, non-object, oversized, and incomplete settings bodies", async () => {
    const { info } = await startGateway({ env: {} });
    const headers = {
      authorization: `Bearer ${info.token}`,
      "content-type": "application/json",
    };

    const malformed = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{",
    });
    expect(malformed.status).toBe(400);

    const nonObject = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "[]",
    });
    expect(nonObject.status).toBe(400);

    const incomplete = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: "{}",
    });
    expect(incomplete.status).toBe(400);

    const oversized = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ token: "x".repeat(2 * 1024 * 1024) }),
    });
    expect(oversized.status).toBe(413);

    const wrongMethod = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "POST",
      headers,
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, PUT");
  });

  test("serializes concurrent rotations and leaves disk and memory on the last queued token", async () => {
    const { gateway, dataDir } = await startGateway({ env: {} });
    const firstToken = `first-${"a".repeat(64)}`;
    const secondToken = `second-${"b".repeat(900)}`;

    await Promise.all([
      gateway.setToken(firstToken),
      gateway.setToken(secondToken),
    ]);

    expect(await gateway.getTokenSettings()).toMatchObject({ token: secondToken });
    expect((await loadOrCreateGatewayToken(dataDir, {})).token).toBe(secondToken);
  });

  test("surfaces persistence failures without reporting a successful rotation", async () => {
    const root = await createTempDir("ork-gateway-write-failure-");
    const fileInsteadOfDirectory = path.join(root, "not-a-directory");
    await writeFile(fileInsteadOfDirectory, "blocked");
    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir: path.join(fileInsteadOfDirectory, "child"),
      rendererRoot: root,
      env: {},
      logger: createLogger(),
    });

    await expect(gateway.setToken("replacement-token-123456")).rejects.toThrow();
  });

  test("returns 500 for persistence failures and keeps the previous active token", async () => {
    const { info, dataDir } = await startGateway({ env: {} });
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, "not a directory");
    const oldAuthorization = { authorization: `Bearer ${info.token}` };

    const rotation = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: { ...oldAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ token: "replacement-token-123456" }),
    });
    expect(rotation.status).toBe(500);
    expect(rotation.json()).toEqual({ error: "Unable to persist gateway token" });

    const oldTokenStillWorks = await requestUrl(`${info.url}__orkestrator/invoke`, {
      method: "POST",
      headers: { ...oldAuthorization, "content-type": "application/json" },
      body: JSON.stringify({ command: "get_projects" }),
    });
    expect(oldTokenStillWorks.status).toBe(200);
  });

  test("rejects edits when the token is managed by the environment", async () => {
    const { info } = await startGateway();
    const response = await requestUrl(`${info.url}__orkestrator/gateway-settings`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${info.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: "replacement-token-123456" }),
    });

    expect(response.status).toBe(400);
    expect(response.json()).toEqual({
      error: "Gateway token is managed by ORKESTRATOR_GATEWAY_TOKEN and cannot be changed here",
    });
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
        response.on("data", (chunk) => {
          body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (body.includes(": keepalive") && body.includes("\"event\":\"menu-zoom\"")) {
            response.destroy();
            resolve(body);
          }
        });
      });
      request.on("error", reject);
      request.end();

      setTimeout(() => {
        gateway.emit("menu-zoom", "in");
      }, 10);
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
    expect(decodeResponseBody(result)).toBe(body);
  });

  test("does not double encode an already encoded proxy response", async () => {
    const body = Buffer.from("already encoded ".repeat(512));
    const encoded = gzipSync(body);
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": encoded.byteLength,
      });
      response.end(encoded);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const address = target.address();
    if (!address || typeof address !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway({ compression: "on" });
    const result = await requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${address.port}/encoded`,
      {
        headers: {
          authorization: `Bearer ${info.token}`,
          "accept-encoding": "br, gzip",
        },
      },
    );
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(result.rawBody)).toEqual(body);
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

  test("terminates the downstream response when an upstream proxy aborts after headers", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("partial");
      setTimeout(() => response.socket?.destroy(), 10);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    await expect(requestUrl(
      `${info.url}__orkestrator/proxy/loopback/${targetAddress.port}/aborted`,
      { headers: { authorization: `Bearer ${info.token}` } },
    )).rejects.toThrow("Response aborted");
  });

  test("proxies authenticated loopback POSTs without leaking gateway credentials or browser origin", async () => {
    const targetRequests: Array<{
      authorization?: string;
      proxyAuthorization?: string;
      codexToken?: string;
      openCodeToken?: string;
      cookie?: string;
      origin?: string;
      method?: string;
      body: string;
    }> = [];
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        targetRequests.push({
          authorization: request.headers.authorization,
          proxyAuthorization: request.headers["proxy-authorization"],
          codexToken: request.headers["x-orkestrator-codex-token"] as string | undefined,
          openCodeToken: request.headers["x-orkestrator-opencode-token"] as string | undefined,
          cookie: request.headers.cookie,
          origin: request.headers.origin,
          method: request.method,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, url: request.url }));
      });
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const dataDir = await createTempDir("ork-gateway-proxy-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);
    await writeFile(path.join(rendererRoot, "index.html"), "<div id=\"root\"></div>");

    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}__orkestrator/proxy/loopback/${targetAddress.port}/hello?x=1`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${info!.token}`,
          "proxy-authorization": "Basic must-not-reach-upstream",
          cookie: "orkestrator_gateway_auth=test-token-123456; app_session=abc123",
          origin: new URL(info!.url).origin,
          "content-type": "application/json",
          "x-orkestrator-codex-token": "codex-bridge-token",
          "x-orkestrator-opencode-token": "opencode-password",
        },
        body: JSON.stringify({ prompt: "review" }),
      });
      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ ok: true, url: "/hello?x=1" });
      expect(targetRequests).toEqual([{
        authorization: `Basic ${Buffer.from("opencode:opencode-password").toString("base64")}`,
        proxyAuthorization: undefined,
        codexToken: "codex-bridge-token",
        openCodeToken: undefined,
        cookie: "app_session=abc123",
        origin: undefined,
        method: "POST",
        body: JSON.stringify({ prompt: "review" }),
      }]);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });

  test("rewrites loopback proxy redirects and target cookies into the proxy namespace", async () => {
    const target = createServer((request, response) => {
      if (request.url === "/relative") {
        response.writeHead(302, { location: "/next" });
        response.end();
        return;
      }
      if (request.url === "/absolute") {
        const address = target.address();
        if (!address || typeof address !== "object") throw new Error("Target server did not bind");
        response.writeHead(302, { location: `http://127.0.0.1:${address.port}/next?x=1` });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
        "Access-Control-Allow-Credentials": "true",
        "set-cookie": [
          "app_session=abc123; Path=/; HttpOnly",
          "orkestrator_gateway_auth=evil; Path=/",
        ],
      });
      response.end(JSON.stringify({ cookie: request.headers.cookie ?? "" }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const proxyPrefix = `/__orkestrator/proxy/loopback/${targetAddress.port}`;

    try {
      const cookieResponse = await requestUrl(`${info.url}${proxyPrefix}/cookies`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(cookieResponse.status).toBe(200);
      expect(cookieResponse.headers["set-cookie"]).toEqual([
        `app_session=abc123; Path=${proxyPrefix}/; HttpOnly`,
      ]);
      // A proxied service must not be able to inject its own CORS policy.
      expect(cookieResponse.headers["access-control-allow-origin"]).toBeUndefined();
      expect(cookieResponse.headers["access-control-allow-credentials"]).toBeUndefined();

      const relativeRedirect = await requestUrl(`${info.url}${proxyPrefix}/relative`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(relativeRedirect.status).toBe(302);
      expect(relativeRedirect.headers.location).toBe(`${proxyPrefix}/next`);

      const absoluteRedirect = await requestUrl(`${info.url}${proxyPrefix}/absolute`, {
        headers: { authorization: `Bearer ${info.token}` },
      });
      expect(absoluteRedirect.status).toBe(302);
      expect(absoluteRedirect.headers.location).toBe(`${proxyPrefix}/next?x=1`);
    } finally {
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
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
    expect(result.headers.vary?.toLowerCase()).toContain("origin");
    expect(result.headers.vary?.toLowerCase()).toContain("accept-encoding");
    expect(decodeResponseBody(result)).toBe(
      `<script src="${prefix}/asset.js"></script>${" preview text".repeat(512)}`,
    );
  });

  test("allows null-origin browser preview preflights and forwards non-simple requests", async () => {
    const received = mock(() => undefined);
    const target = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        received(request.method, request.url, request.headers["x-preview-test"], Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const targetUrl = `${info.url}__orkestrator/browser/loopback/${targetAddress.port}/api`;
    const preflight = await requestUrl(targetUrl, {
      method: "OPTIONS",
      headers: {
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-preview-test",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("null");
    expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type, x-preview-test");
    expect(received).not.toHaveBeenCalled();

    const proxied = await requestUrl(targetUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${info.token}`,
        origin: "null",
        "content-type": "application/json",
        "x-preview-test": "forwarded",
      },
      body: '{"message":"hello"}',
    });
    expect(proxied.status).toBe(200);
    expect(proxied.json()).toEqual({ ok: true });
    expect(proxied.headers["access-control-allow-origin"]).toBe("null");
    expect(proxied.headers["access-control-allow-credentials"]).toBe("true");
    expect(received).toHaveBeenCalledWith("POST", "/api", "forwarded", '{"message":"hello"}');
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

  test("aborts oversized streaming preview bodies without waiting for upstream completion", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let index = 0; index < 9; index += 1) response.write(chunk);
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/large.js`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain("exceeded 8388608");
  });

  test("rejects preview text with an unsupported content encoding", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "zstd",
      });
      response.end("opaque");
    });
    auxiliaryServers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { info } = await startGateway();
    const result = await requestUrl(`${info.url}__orkestrator/browser/loopback/${targetAddress.port}/`, {
      headers: { authorization: `Bearer ${info.token}`, origin: "null" },
    });
    expect(result.status).toBe(502);
    expect(result.body).toContain("unsupported content encoding");
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

  test("redirects preview-referred root requests back into their namespace", async () => {
    const { info } = await startGateway();
    const referer = `${info.url}__orkestrator/browser/loopback/3000/app`;

    const redirect = await requestUrl(`${info.url}api/status?probe=1`, {
      headers: { referer, origin: "null" },
    });
    expect(redirect.status).toBe(307);
    expect(redirect.headers.location).toBe("/__orkestrator/browser/loopback/3000/api/status?probe=1");
    expect(redirect.headers["access-control-allow-origin"]).toBe("null");
    expect(redirect.headers["access-control-allow-credentials"]).toBe("true");
    expect(redirect.headers["cache-control"]).toBe("no-store");

    const preflight = await requestUrl(`${info.url}api/status`, {
      method: "OPTIONS",
      headers: {
        referer,
        origin: "null",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("null");
    expect(preflight.headers["access-control-allow-headers"]).toBe("content-type");

    const unrelatedReferer = await requestUrl(`${info.url}api/status`, {
      headers: { referer: `${info.url}some/other/page` },
    });
    expect(unrelatedReferer.status).toBe(401);

    const malformedReferer = await requestUrl(`${info.url}api/status`, {
      headers: { referer: "not a url" },
    });
    expect(malformedReferer.status).toBe(401);
  });

  test("cancels the upstream request when the preview client disconnects", async () => {
    // Abruptly dropping an in-process connection to a Bun HTTP server wedges
    // the bun:test runner even after the scenario completes, so the whole
    // disconnect scenario runs in a subprocess and reports over stdout.
    const dataDir = await createTempDir("ork-gateway-disconnect-");
    const rendererRoot = await createRendererRoot(dataDir);
    const scriptPath = path.join(dataDir, "disconnect-scenario.ts");
    const gatewayModule = path.resolve(import.meta.dir, "../../../apps/backend/src/gateway.ts");
    await writeFile(scriptPath, `
      import { createServer } from "node:http";
      import { connect } from "node:net";
      import { OrkestratorGateway } from ${JSON.stringify(gatewayModule)};

      setTimeout(() => { console.log("TIMED_OUT"); process.exit(1); }, 8000);

      const target = createServer((request, response) => {
        request.socket.once("close", () => {
          console.log("UPSTREAM_CLOSED");
          process.exit(0);
        });
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write("streaming");
      });
      await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
      const targetPort = target.address().port;

      const gateway = new OrkestratorGateway({
        backend: { invoke: async () => null },
        dataDir: ${JSON.stringify(dataDir)},
        rendererRoot: ${JSON.stringify(rendererRoot)},
        bindAddress: "127.0.0.1",
        port: 0,
        env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        allowNonTailscaleBind: true,
      });
      const info = await gateway.start();
      if (!info) throw new Error("Gateway did not start");
      const gatewayUrl = new URL(info.url);

      const socket = connect({ host: gatewayUrl.hostname, port: Number(gatewayUrl.port) }, () => {
        socket.write([
          "GET /__orkestrator/browser/loopback/" + targetPort + "/stream HTTP/1.1",
          "Host: " + gatewayUrl.host,
          "Authorization: Bearer " + info.token,
          "",
          "",
        ].join("\\r\\n"));
      });
      socket.once("data", () => socket.destroy());
    `);

    const scenario = Bun.spawn([process.execPath, scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      scenario.exited,
      new Response(scenario.stdout).text(),
      new Response(scenario.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(stdout).toContain("UPSTREAM_CLOSED");
    expect(exitCode).toBe(0);
  });

  test("serves renderer requests through a configured dev server proxy", async () => {
    const devServer = createServer((request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`dev:${request.url}`);
    });
    await new Promise<void>((resolve) => devServer.listen(0, "127.0.0.1", resolve));
    const devAddress = devServer.address();
    if (!devAddress || typeof devAddress !== "object") throw new Error("Dev server did not bind");

    const dataDir = await createTempDir("ork-gateway-dev-");
    const rendererRoot = path.join(dataDir, "dist");
    await mkdir(rendererRoot);

    const gateway = new OrkestratorGateway({
      backend: { invoke: mock(async () => null) },
      dataDir,
      rendererRoot,
      rendererDevServerUrl: `http://127.0.0.1:${devAddress.port}`,
      bindAddress: "127.0.0.1",
      port: 0,
      env: { ORKESTRATOR_GATEWAY_TOKEN: "test-token-123456" },
      logger: { debug: mock(() => undefined), error: mock(() => undefined), info: mock(() => undefined), warn: mock(() => undefined) },
      allowNonTailscaleBind: true,
    });
    gateways.push(gateway);
    const info = await gateway.start();

    try {
      const response = await requestUrl(`${info!.url}src/main.tsx?dev=1`, {
        headers: { authorization: `Bearer ${info!.token}` },
      });
      expect(response.status).toBe(200);
      expect(response.body).toBe("dev:/src/main.tsx?dev=1");
    } finally {
      await new Promise<void>((resolve) => devServer.close(() => resolve()));
    }
  });

  test("stops promptly and disconnects an active streaming proxy response", async () => {
    const target = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("streaming");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress !== "object") throw new Error("Target server did not bind");

    const { gateway, info } = await startGateway();
    const request = httpRequest(`${info.url}__orkestrator/proxy/loopback/${targetAddress.port}/stream`, {
      headers: { authorization: `Bearer ${info.token}` },
    });
    let resolveResponseClosed: () => void = () => undefined;
    const responseClosed = new Promise<void>((resolve) => {
      resolveResponseClosed = resolve;
    });
    const responseStarted = new Promise<void>((resolve, reject) => {
      request.once("response", (response) => {
        response.once("close", resolveResponseClosed);
        response.once("data", () => resolve());
        response.once("error", reject);
      });
      request.once("error", reject);
    });
    request.end();

    try {
      await responseStarted;
      await Promise.race([
        gateway.stop(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Gateway stop timed out")), 1_000)),
      ]);
      await expect(responseClosed).resolves.toBeUndefined();
    } finally {
      request.destroy();
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    }
  });
});

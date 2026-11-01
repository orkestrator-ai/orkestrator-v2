/**
 * Proof that gzip SSE streams incrementally in `--compression on` (todo 0052,
 * task 3), on the routes a remote client can take: straight to the gateway, and
 * through a pass-through proxy over HTTP/1.1 and over HTTP/2, the two shapes of
 * Tailscale Serve's browser hop. No Tailscale is involved here;
 * `scripts/sse-route-probe.ts` measures the real route.
 *
 * Every frame is proved in lockstep: the next one is not written until this one
 * has decoded, whole, and the wire bytes end on a sync flush. So a test cannot
 * pass on a timing assumption, and a frame that is held fails rather than being
 * delivered with its successor. The negative controls at the end show the checks
 * do catch a buffering hop and a buffering encoder.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { createServer as createHttp2Server, type ServerHttp2Session } from "node:http2";
import { createGzip, gunzipSync, gzipSync } from "node:zlib";

import { GATEWAY_KEEPALIVE_EVENT } from "@orkestrator/protocol/gateway-event-stream";

import { openSseProbeStream, type SseProbeStream } from "../scripts/sse-route-probe.js";
import type { OrkestratorGateway } from "../src/gateway";
import {
  auxiliaryServers,
  eventClients,
  eventFrames,
  frameId,
  startGateway,
  waitUntil,
} from "./gateway-test-harness.js";

type CompressionGauges = {
  streamingActive: number;
  streamingStarted: number;
  streamingDeclined: number;
  streamingFailures: number;
};

function compressionGauges(gateway: OrkestratorGateway): CompressionGauges {
  return (
    gateway as unknown as {
      metrics: { snapshot(): { compression: CompressionGauges } };
    }
  ).metrics.snapshot().compression;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** Headers a hop must not forward (RFC 9110 §7.6.1), which HTTP/2 also forbids. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding"]);

type TestProxy = {
  origin: string;
  http2: boolean;
  /** Upstream connections the proxy has closed after its client went away. */
  upstreamClosed: () => number;
  /** Bytes the proxy has read from upstream. */
  upstreamBytes: () => number;
  release: () => void;
};

/** Forwards bytes as they come and headers unchanged, as Serve's reverse proxy does. */
async function startHttp1Proxy(
  targetOrigin: string,
  options: { hold?: boolean } = {},
): Promise<TestProxy> {
  const target = new URL(targetOrigin);
  let upstreamClosed = 0;
  let upstreamBytes = 0;
  let held = options.hold === true;
  const heldChunks: Buffer[] = [];
  const flushers = new Set<() => void>();
  const server = createServer((request, response) => {
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: request.url,
        // Serve keeps the client's Host too.
        headers: request.headers,
      },
      (upstreamResponse) => {
        const headers = Object.fromEntries(
          Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, headers as OutgoingHttpHeaders);
        response.flushHeaders();
        flushers.add(() => {
          for (const chunk of heldChunks.splice(0)) response.write(chunk);
        });
        upstreamResponse.on("data", (chunk: Buffer) => {
          upstreamBytes += chunk.byteLength;
          if (held) heldChunks.push(chunk);
          else response.write(chunk);
        });
        upstreamResponse.on("end", () => response.end());
        upstreamResponse.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => response.destroy());
    response.once("close", () => {
      upstreamClosed += 1;
      upstream.destroy();
    });
    upstream.end();
  });
  auxiliaryServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Test proxy did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    http2: false,
    upstreamClosed: () => upstreamClosed,
    upstreamBytes: () => upstreamBytes,
    release: () => {
      held = false;
      for (const flush of flushers) flush();
    },
  };
}

/** HTTP/2 in front of HTTP/1.1 behind, the shape a browser sees through Serve. */
async function startHttp2Proxy(targetOrigin: string): Promise<TestProxy> {
  const target = new URL(targetOrigin);
  let upstreamClosed = 0;
  let upstreamBytes = 0;
  const sessions = new Set<ServerHttp2Session>();
  const server = createHttp2Server((request, response) => {
    const headers = Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !name.startsWith(":")),
    ) as IncomingHttpHeaders;
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: request.url,
        headers: { ...headers, host: request.headers[":authority"] },
      },
      (upstreamResponse) => {
        const forwarded = Object.fromEntries(
          Object.entries(upstreamResponse.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
        );
        response.writeHead(upstreamResponse.statusCode ?? 502, forwarded as OutgoingHttpHeaders);
        // HTTP/2 writeHead sends headers immediately.
        upstreamResponse.on("data", (chunk: Buffer) => {
          upstreamBytes += chunk.byteLength;
          response.write(chunk);
        });
        upstreamResponse.on("end", () => response.end());
        upstreamResponse.on("error", () => response.destroy());
      },
    );
    upstream.on("error", () => response.destroy());
    response.once("close", () => {
      upstreamClosed += 1;
      upstream.destroy();
    });
    upstream.end();
  });
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  cleanups.push(() => {
    for (const session of sessions) session.destroy();
    server.close();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Test proxy did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    http2: true,
    upstreamClosed: () => upstreamClosed,
    upstreamBytes: () => upstreamBytes,
    release: () => {},
  };
}

type Route = {
  origin: string;
  http2: boolean;
  proxy: TestProxy | null;
};

const ROUTES: ReadonlyArray<[string, (origin: string) => Promise<Route>]> = [
  ["directly", async (origin) => ({ origin, http2: false, proxy: null })],
  [
    "through an HTTP/1.1 proxy",
    async (origin) => {
      const proxy = await startHttp1Proxy(origin);
      return { origin: proxy.origin, http2: false, proxy };
    },
  ],
  [
    "through an HTTP/2 proxy",
    async (origin) => {
      const proxy = await startHttp2Proxy(origin);
      return { origin: proxy.origin, http2: true, proxy };
    },
  ],
];

async function openStream(
  route: Route,
  path: string,
  token: string,
  headers: Record<string, string> = { "accept-encoding": "gzip" },
): Promise<SseProbeStream> {
  const stream = await openSseProbeStream(`${route.origin}${path}`, {
    http2: route.http2,
    headers: { authorization: `Bearer ${token}`, ...headers },
  });
  cleanups.push(() => stream.close());
  return stream;
}

const gatewayOrigin = (info: { url: string }) => info.url.replace(/\/$/, "");
const EVENTS_PATH = "/__orkestrator/events";
const SYNC_FLUSH_MARKER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

function endsOnSyncFlush(raw: Buffer): boolean {
  return raw.subarray(-SYNC_FLUSH_MARKER.length).equals(SYNC_FLUSH_MARKER);
}

/**
 * The frame is on the client, decoded and whole, and nothing of it is left in
 * the encoder: the bytes so far end on a sync flush.
 */
async function expectFlushedFrame(
  stream: SseProbeStream,
  marker: string,
  timeoutMs = 2000,
): Promise<void> {
  await waitUntil(
    () =>
      stream.text().includes(marker) &&
      stream.text().endsWith("\n\n") &&
      endsOnSyncFlush(stream.raw()),
    `Frame ${marker} was buffered instead of flushed`,
    timeoutMs,
  );
}

const emitEnvironment = (gateway: OrkestratorGateway, id: string, padding = "") =>
  gateway.emit("environment-changed", { id, ...(padding ? { padding } : {}) });

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Bytes that do not compress, so one frame outgrows `SSE_COMPRESSION_CHUNK_BYTES`. */
const incompressible = (bytes: number) => randomBytes(bytes / 2).toString("hex");

describe.each(ROUTES)("gzip /events %s", (_name, openRoute) => {
  test("each event arrives, whole and flushed, before the next is written", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, EVENTS_PATH, info.token);
    await expectFlushedFrame(stream, ": connected");

    for (let index = 0; index < 5; index += 1) {
      const before = stream.raw().byteLength;
      emitEnvironment(gateway, `small-${index}`);
      await expectFlushedFrame(stream, `small-${index}`);
      expect(stream.raw().byteLength).toBeGreaterThan(before);
    }
    // A frame larger than the compressor's chunk leaves in several chunks, and
    // the one after it still does not wait for anything.
    emitEnvironment(gateway, "large", incompressible(200 * 1024));
    await expectFlushedFrame(stream, "large");
    emitEnvironment(gateway, "after-large");
    await expectFlushedFrame(stream, "after-large");

    const delivered = eventFrames(stream.text(), "environment-changed");
    expect(delivered.map((frame) => /"id":"([^"]+)"/.exec(frame)?.[1])).toEqual([
      "small-0",
      "small-1",
      "small-2",
      "small-3",
      "small-4",
      "large",
      "after-large",
    ]);
    expect(stream.aborted()).toBe(false);
  });

  test("a terminal-only stream flushes every output frame too", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(
      route,
      `${EVENTS_PATH}?includeEvents=terminal-output-&excludeEvents=terminal-output-`,
      info.token,
    );
    await expectFlushedFrame(stream, ": connected");
    for (let index = 0; index < 3; index += 1) {
      gateway.emit("terminal-output-session", {
        text: `line-${index}`,
        generation: 1,
        revision: index + 1,
      });
      await expectFlushedFrame(stream, `line-${index}`);
    }
  });

  test("headers name gzip once, vary on the request and forbid transformation", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, EVENTS_PATH, info.token);
    emitEnvironment(gateway, "single-encoding");
    await expectFlushedFrame(stream, "single-encoding");

    expect(stream.status).toBe(200);
    expect(stream.headers["content-encoding"]).toBe("gzip");
    expect(stream.headers.vary).toBe("Accept-Encoding");
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.headers["cache-control"]).toBe("no-store, no-transform");
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    expect(stream.headers["content-length"]).toBeUndefined();
    // One gunzip reaches plain SSE text: nothing on the route encoded it twice.
    expect(stream.raw().subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(stream.text().startsWith(": compression-priming\n\n: connected\n\n")).toBe(true);
    expect(compressionGauges(gateway).streamingActive).toBe(1);
  });

  test("an idle stream flushes each keepalive comment and then delivers the next event", async () => {
    const { gateway, info } = await startGateway({
      compression: "on",
      keepaliveMs: 20,
    });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, EVENTS_PATH, info.token);
    for (let seen = 1; seen <= 3; seen += 1) {
      await waitUntil(
        () =>
          count(stream.text(), ": keepalive\n\n") >= seen &&
          stream.text().endsWith("\n\n") &&
          endsOnSyncFlush(stream.raw()),
        `Keepalive ${seen} was buffered`,
      );
    }
    expect(stream.text()).not.toContain(GATEWAY_KEEPALIVE_EVENT);
    emitEnvironment(gateway, "after-idle");
    await expectFlushedFrame(stream, "after-idle");
    expect(stream.aborted()).toBe(false);
  });

  test("gateway.keepalive reaches the client at connect, before any tick or event", async () => {
    // The default 25 s keepalive cannot fire here, so only the connect write can pass.
    const { info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, `${EVENTS_PATH}?keepaliveEvents=1`, info.token);
    await expectFlushedFrame(stream, `event: ${GATEWAY_KEEPALIVE_EVENT}\ndata: 1\n\n`);
  });

  test("gateway.keepalive replaces the comment on every tick and each one is flushed", async () => {
    const { gateway, info } = await startGateway({
      compression: "on",
      keepaliveMs: 20,
    });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, `${EVENTS_PATH}?keepaliveEvents=1`, info.token);
    const frame = `event: ${GATEWAY_KEEPALIVE_EVENT}\ndata: 1\n\n`;
    for (let seen = 2; seen <= 4; seen += 1) {
      await waitUntil(
        () =>
          count(stream.text(), frame) >= seen &&
          stream.text().endsWith("\n\n") &&
          endsOnSyncFlush(stream.raw()),
        `gateway.keepalive ${seen} was buffered`,
      );
    }
    expect(stream.text()).not.toContain(": keepalive");
    emitEnvironment(gateway, "after-named-keepalives");
    await expectFlushedFrame(stream, "after-named-keepalives");
  });

  test.each([
    ["Last-Event-ID", (cursor: string) => ["", { "last-event-id": cursor }] as const],
    ["since", (cursor: string) => [`&since=${encodeURIComponent(cursor)}`, {}] as const],
  ] as const)("a reconnect by %s replays on a fresh gzip stream", async (_cursorName, cursorOf) => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const first = await openStream(route, `${EVENTS_PATH}?keepaliveEvents=1`, info.token);
    await expectFlushedFrame(first, ": connected");
    for (const id of ["replay-a", "replay-b", "replay-c"]) {
      emitEnvironment(gateway, id);
      await expectFlushedFrame(first, id);
    }
    const cursor = frameId(eventFrames(first.text(), "environment-changed")[0]!);
    expect(cursor).not.toBeNull();
    first.close();
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "The dropped stream kept its compressor",
    );

    const [search, headers] = cursorOf(cursor!);
    const second = await openStream(
      route,
      `${EVENTS_PATH}?keepaliveEvents=1${search}`,
      info.token,
      {
        "accept-encoding": "gzip",
        ...headers,
      },
    );
    await expectFlushedFrame(second, "replay-c");
    const replayed = eventFrames(second.text(), "environment-changed").join("");
    expect(replayed).not.toContain("replay-a");
    expect(replayed).toContain("replay-b");
    // Its own gzip member, its own lease, and the keepalive it asked for.
    expect(second.raw().subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(second.text()).toContain(`event: ${GATEWAY_KEEPALIVE_EVENT}`);
    expect(compressionGauges(gateway)).toMatchObject({
      streamingActive: 1,
      streamingStarted: 2,
    });

    emitEnvironment(gateway, "replay-live");
    await expectFlushedFrame(second, "replay-live");
    expect(count(second.text(), "replay-c")).toBe(1);
  });

  test("a client that hangs up on an idle stream gives back its compressor", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, EVENTS_PATH, info.token);
    await expectFlushedFrame(stream, ": connected");
    expect(compressionGauges(gateway).streamingActive).toBe(1);
    stream.close();
    await waitUntil(() => eventClients(gateway).size === 0, "Client was not unregistered");
    expect(compressionGauges(gateway)).toMatchObject({
      streamingActive: 0,
      streamingFailures: 0,
    });
    if (route.proxy) expect(route.proxy.upstreamClosed()).toBe(1);
    // A later event has nowhere to go and must not fault.
    emitEnvironment(gateway, "after-hangup");
    expect(compressionGauges(gateway).streamingFailures).toBe(0);
  });

  test("a client that hangs up mid-burst gives back its compressor without a failure", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, EVENTS_PATH, info.token);
    await expectFlushedFrame(stream, ": connected");
    for (let index = 0; index < 200; index += 1) {
      emitEnvironment(gateway, `burst-${index}`, "x".repeat(512));
      if (index === 100) stream.close();
    }
    await waitUntil(() => eventClients(gateway).size === 0, "Client was not unregistered");
    expect(compressionGauges(gateway)).toMatchObject({
      streamingActive: 0,
      streamingFailures: 0,
    });
  });

  test.each([
    ["no header", undefined],
    ["identity", "identity"],
    ["gzip refused", "gzip;q=0"],
    ["another coding", "br"],
  ])("a client with %s streams identity, flushed, and takes no compressor", async (_, value) => {
    const { gateway, info } = await startGateway({
      compression: "on",
      keepaliveMs: 20,
    });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(
      route,
      `${EVENTS_PATH}?keepaliveEvents=1`,
      info.token,
      value === undefined ? {} : { "accept-encoding": value },
    );
    await waitUntil(
      () => count(stream.text(), `event: ${GATEWAY_KEEPALIVE_EVENT}`) >= 2,
      "Identity keepalives did not arrive",
    );
    for (let index = 0; index < 3; index += 1) {
      emitEnvironment(gateway, `identity-${index}`);
      await waitUntil(
        () => stream.text().includes(`identity-${index}`),
        `Identity frame ${index} was held`,
      );
    }
    expect(stream.headers["content-encoding"]).toBeUndefined();
    // Still a choice made on the request header, so caches must key on it.
    expect(stream.headers.vary).toBe("Accept-Encoding");
    expect(stream.raw().toString("utf8")).toBe(stream.text());
    expect(compressionGauges(gateway)).toMatchObject({
      streamingStarted: 0,
      streamingDeclined: 0,
    });
  });
});

describe("modes that never gzip an event stream", () => {
  test.each(["off", "body"] as const)(
    "%s streams identity to a gzip client and adds no Vary",
    async (compression) => {
      const { gateway, info } = await startGateway({ compression });
      const route = { origin: gatewayOrigin(info), http2: false, proxy: null };
      const stream = await openStream(route, EVENTS_PATH, info.token);
      emitEnvironment(gateway, "plain");
      await waitUntil(() => stream.text().includes("plain"), "Identity frame was held");
      expect(stream.headers["content-encoding"]).toBeUndefined();
      expect(stream.headers.vary).toBeUndefined();
      expect(compressionGauges(gateway).streamingStarted).toBe(0);
    },
  );

  test("the control listener stays identity while the browser listener gzips", async () => {
    const { gateway, info } = await startGateway({
      compression: "on",
      controlBindAddress: "127.0.0.1",
      controlPort: 0,
    });
    const control = await openStream(
      { origin: gatewayOrigin(info), http2: false, proxy: null },
      EVENTS_PATH,
      info.token,
    );
    emitEnvironment(gateway, "to-control");
    await waitUntil(() => control.text().includes("to-control"), "Control frame was held");
    expect(control.headers["content-encoding"]).toBeUndefined();
    expect(control.headers.vary).toBeUndefined();
    expect(compressionGauges(gateway).streamingStarted).toBe(0);

    const browser = await openStream(
      {
        origin: info.browserUrl!.replace(/\/$/, ""),
        http2: false,
        proxy: null,
      },
      EVENTS_PATH,
      info.token,
    );
    emitEnvironment(gateway, "to-browser");
    await expectFlushedFrame(browser, "to-browser");
    expect(browser.headers["content-encoding"]).toBe("gzip");
    expect(compressionGauges(gateway).streamingStarted).toBe(1);
  });
});

/** A loopback SSE target behind the gateway's own proxy route. */
async function startSseUpstream(headers: OutgoingHttpHeaders = {}) {
  const requests: IncomingHttpHeaders[] = [];
  const responses: ServerResponse[] = [];
  const closed: boolean[] = [];
  const server = createServer((request, response) => {
    const index = requests.push(request.headers) - 1;
    closed[index] = false;
    response.once("close", () => {
      closed[index] = true;
    });
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    });
    response.flushHeaders();
    responses.push(response);
  });
  auxiliaryServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Upstream did not bind");
  return {
    path: `/__orkestrator/proxy/loopback/${address.port}/events`,
    requests,
    responses,
    closed,
    write: (frame: string | Buffer, index = 0) => responses[index]!.write(frame),
  };
}

describe.each(ROUTES)("gzip proxied event stream %s", (_name, openRoute) => {
  test("each upstream frame arrives, whole and flushed, before the next is written", async () => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");

    for (let index = 0; index < 4; index += 1) {
      upstream.write(`data: proxied-${index}\n\n`);
      await expectFlushedFrame(stream, `proxied-${index}`);
    }
    const large = incompressible(200 * 1024);
    upstream.write(`data: ${large}\n\n`);
    await expectFlushedFrame(stream, large);
    upstream.write("data: after-large\n\n");
    await expectFlushedFrame(stream, "after-large");

    // The loopback hop stays identity, so nothing here is coded twice.
    expect(upstream.requests[0]!["accept-encoding"]).toBe("identity");
    expect(stream.headers["content-encoding"]).toBe("gzip");
    expect(stream.headers.vary).toBe("Accept-Encoding");
    expect(stream.headers["content-length"]).toBeUndefined();
    expect(stream.raw().subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(compressionGauges(gateway).streamingActive).toBe(1);
  });

  test("upstream keepalive comments and gateway.keepalive events flush one by one", async () => {
    const upstream = await startSseUpstream();
    const { info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    for (let index = 1; index <= 3; index += 1) {
      upstream.write(": keepalive\n\n");
      await waitUntil(
        () => count(stream.text(), ": keepalive\n\n") === index && endsOnSyncFlush(stream.raw()),
        `Proxied keepalive ${index} was buffered`,
      );
      upstream.write(`event: ${GATEWAY_KEEPALIVE_EVENT}\ndata: 1\n\n`);
      await waitUntil(
        () =>
          count(stream.text(), `event: ${GATEWAY_KEEPALIVE_EVENT}\n`) === index &&
          endsOnSyncFlush(stream.raw()),
        `Proxied gateway.keepalive ${index} was buffered`,
      );
    }
  });

  test.each([
    ["on", "gzip"],
    ["on", "identity"],
    ["body", "gzip"],
    ["off", "gzip"],
  ] as const)(
    "a quiet upstream in %s sends headers to a %s client",
    async (compression, encoding) => {
      const upstream = await startSseUpstream();
      const { info } = await startGateway({ compression });
      const route = await openRoute(gatewayOrigin(info));
      // Resolves on the response headers. Nothing has been written upstream yet.
      const stream = await openStream(route, upstream.path, info.token, {
        "accept-encoding": encoding!,
      });
      expect(stream.status).toBe(200);
      expect(stream.raw().byteLength).toBe(0);
      expect(stream.headers["content-encoding"]).toBe(
        compression === "on" && encoding === "gzip" ? "gzip" : undefined,
      );
      upstream.write("data: first\n\n");
      await waitUntil(() => stream.text().includes("first"), "First frame after headers was held");
    },
  );

  test("an upstream abort cannot produce a valid gzip ending", async () => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Upstream did not open");
    upstream.write("data: before-abort\n\n");
    await expectFlushedFrame(stream, "before-abort");
    upstream.responses[0]!.destroy();
    await waitUntil(() => stream.aborted() || stream.ended(), "Abort did not reach client");
    // Some HTTP/2 hops signal END_STREAM on a reset. Either way the gzip body
    // must fail decoding rather than acquire a valid trailer.
    await waitUntil(
      () => stream.aborted() || stream.decodeError() !== null,
      "Truncated gzip was accepted",
    );
    expect(() => gunzipSync(stream.raw())).toThrow();
    await waitUntil(() => compressionGauges(gateway).streamingActive === 0, "Leaked compressor");
  });

  test("an upstream that ends cleanly leaves a complete gzip body", async () => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    upstream.write("data: one\n\n");
    await expectFlushedFrame(stream, "one");
    upstream.responses[0]!.end("data: two\n\n");
    await waitUntil(() => stream.ended() || stream.aborted(), "Stream did not finish");

    expect(stream.ended()).toBe(true);
    expect(stream.decodeError()).toBeNull();
    // A strict decoder needs the trailer, not just the sync-flushed blocks.
    expect(gunzipSync(stream.raw()).toString("utf8")).toBe("data: one\n\ndata: two\n\n");
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "The finished stream kept its compressor",
    );
    expect(compressionGauges(gateway).streamingFailures).toBe(0);
  });

  test("a reconnect sends its cursor upstream and starts a fresh gzip stream", async () => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const first = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    upstream.write("id: 7\ndata: before\n\n");
    await expectFlushedFrame(first, "before");
    first.close();
    await waitUntil(() => upstream.closed[0] === true, "Upstream stayed open after the hang-up");
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "The dropped stream kept its compressor",
    );

    const second = await openStream(route, upstream.path, info.token, {
      "accept-encoding": "gzip",
      "last-event-id": "7",
    });
    await waitUntil(() => upstream.responses.length === 2, "Reconnect never reached the upstream");
    expect(upstream.requests[1]!["last-event-id"]).toBe("7");
    upstream.write("id: 8\ndata: resumed\n\n", 1);
    await expectFlushedFrame(second, "resumed");
    expect(second.raw().subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(compressionGauges(gateway)).toMatchObject({
      streamingActive: 1,
      streamingStarted: 2,
    });
  });

  test("a client that hangs up closes the upstream and gives back the compressor", async () => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    upstream.write("data: only\n\n");
    await expectFlushedFrame(stream, "only");
    stream.close();
    await waitUntil(() => upstream.closed[0] === true, "Upstream stayed open after the hang-up");
    await waitUntil(
      () => compressionGauges(gateway).streamingActive === 0,
      "The compressor outlived the client",
    );
    expect(compressionGauges(gateway).streamingFailures).toBe(0);
  });

  test.each([
    ["no header", undefined],
    ["identity", "identity"],
    ["gzip refused", "gzip;q=0"],
    ["another coding", "br"],
  ])("a client with %s streams identity and takes no compressor", async (_, value) => {
    const upstream = await startSseUpstream();
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(
      route,
      upstream.path,
      info.token,
      value === undefined ? {} : { "accept-encoding": value },
    );
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    for (let index = 0; index < 3; index += 1) {
      upstream.write(`data: identity-${index}\n\n`);
      await waitUntil(
        () => stream.text().includes(`identity-${index}`),
        `Identity frame ${index} was held`,
      );
    }
    expect(stream.headers["content-encoding"]).toBeUndefined();
    expect(stream.headers.vary).toBe("Accept-Encoding");
    expect(compressionGauges(gateway)).toMatchObject({
      streamingStarted: 0,
      streamingDeclined: 0,
    });
  });

  test("an upstream that forbids transformation is forwarded untouched", async () => {
    const upstream = await startSseUpstream({
      "cache-control": "no-store, no-transform",
    });
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    upstream.write("data: untouched\n\n");
    await waitUntil(() => stream.text().includes("untouched"), "Frame was held");
    expect(stream.headers["content-encoding"]).toBeUndefined();
    expect(stream.headers.vary).toBeUndefined();
    expect(compressionGauges(gateway).streamingStarted).toBe(0);
  });

  test("an upstream that already sent gzip is not encoded a second time", async () => {
    const upstream = await startSseUpstream({ "content-encoding": "gzip" });
    const { gateway, info } = await startGateway({ compression: "on" });
    const route = await openRoute(gatewayOrigin(info));
    const stream = await openStream(route, upstream.path, info.token);
    await waitUntil(() => upstream.responses.length === 1, "Proxy never reached the upstream");
    upstream.write(gzipSync("data: coded-upstream\n\n"));
    await waitUntil(() => stream.text().includes("coded-upstream"), "Coded frame was held");
    expect(stream.headers["content-encoding"]).toBe("gzip");
    expect(compressionGauges(gateway).streamingStarted).toBe(0);
  });
});

describe("the checks catch buffering", () => {
  test("a hop that holds bytes fails the flush check until it lets go", async () => {
    const { gateway, info } = await startGateway({ compression: "on" });
    const proxy = await startHttp1Proxy(gatewayOrigin(info), { hold: true });
    const stream = await openStream(
      { origin: proxy.origin, http2: false, proxy },
      EVENTS_PATH,
      info.token,
    );
    await waitUntil(() => proxy.upstreamBytes() > 0, "The gateway sent nothing to the proxy");
    const before = proxy.upstreamBytes();
    emitEnvironment(gateway, "held-by-hop");
    await waitUntil(() => proxy.upstreamBytes() > before, "The gateway sent no frame to the proxy");

    // The gateway has flushed the frame, so only the hop can be holding it.
    await expect(expectFlushedFrame(stream, "held-by-hop", 100)).rejects.toThrow("was buffered");
    expect(stream.text()).not.toContain("held-by-hop");

    proxy.release();
    await expectFlushedFrame(stream, "held-by-hop");
  });

  test("an encoder that does not sync-flush fails the flush check", async () => {
    const encoder = createGzip();
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "content-encoding": "gzip",
      });
      response.flushHeaders();
      encoder.pipe(response);
    });
    auxiliaryServers.push(server);
    cleanups.push(() => encoder.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address !== "object") throw new Error("Server did not bind");

    const stream = await openStream(
      { origin: `http://127.0.0.1:${address.port}`, http2: false, proxy: null },
      "/",
      "unused",
    );
    encoder.write("data: held-by-encoder\n\n");
    await expect(expectFlushedFrame(stream, "held-by-encoder", 100)).rejects.toThrow(
      "was buffered",
    );
    expect(stream.text()).toBe("");
  });
});

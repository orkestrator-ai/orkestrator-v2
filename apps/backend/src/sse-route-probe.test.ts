import { afterEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  analyzeArrivals,
  HELD_FLOOR_MS,
  measureRoute,
  parseMeasureOptions,
  parseServeOptions,
  startProbeServer,
  type ProbeMeasureOptions,
  type ProbeServer,
  type TickArrival,
} from "../scripts/sse-route-probe.js";

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const INTERVAL_MS = 1_000;

/** Ticks sent one interval apart, on a client clock an arbitrary distance away. */
function arrivals(delays: readonly number[], clockOffsetMs = 86_400_000): TickArrival[] {
  return delays.map((delay, seq) => {
    const sentAtMs = 1_000_000 + seq * INTERVAL_MS;
    return { seq, sentAtMs, arrivedAtMs: sentAtMs + clockOffsetMs + delay };
  });
}

describe("analyzeArrivals", () => {
  test("a steady route holds nothing, whatever the two clocks' offset", () => {
    for (const offset of [0, 86_400_000, -86_400_000]) {
      expect(analyzeArrivals(arrivals([40, 42, 41, 45, 40], offset), 5, INTERVAL_MS)).toMatchObject(
        { ticks: 5, missing: 0, duplicates: 0, outOfOrder: 0, heldTicks: 0, delayMaxMs: 5 },
      );
    }
  });

  test("a route that releases ticks in a batch shows every held tick", () => {
    // Four ticks held until the fifth arrives: the first waited four intervals.
    const batched = arrivals([4_000, 3_000, 2_000, 1_000, 0]);
    expect(analyzeArrivals(batched, 5, INTERVAL_MS)).toMatchObject({
      heldTicks: 4,
      delayMaxMs: 4_000,
      heldThresholdMs: INTERVAL_MS / 2,
    });
  });

  test("the threshold never drops below the floor on a fast schedule", () => {
    const fast = analyzeArrivals(arrivals([0, HELD_FLOOR_MS]), 2, 10);
    expect(fast).toMatchObject({ heldThresholdMs: HELD_FLOOR_MS, heldTicks: 0 });
    expect(analyzeArrivals(arrivals([0, HELD_FLOOR_MS + 1]), 2, 10).heldTicks).toBe(1);
  });

  test("counts missing, duplicate and out-of-order ticks", () => {
    const [first, second, third] = arrivals([0, 0, 0]) as [TickArrival, TickArrival, TickArrival];
    const result = analyzeArrivals([first, third, second, second], 5, INTERVAL_MS);
    expect(result).toMatchObject({ ticks: 3, missing: 2, duplicates: 1, outOfOrder: 2 });
  });

  test("an empty run reports every tick as missing", () => {
    expect(analyzeArrivals([], 3, INTERVAL_MS)).toMatchObject({
      ticks: 0,
      missing: 3,
      delayMaxMs: 0,
    });
  });
});

describe("options", () => {
  test("refuses the production ports", () => {
    expect(() => parseServeOptions(["--port", "34121"])).toThrow("production backend");
    expect(() => parseServeOptions(["--port", "34122"])).toThrow("production backend");
  });

  test("serves gzip on an ephemeral loopback port by default", () => {
    expect(parseServeOptions([])).toEqual({
      bind: "127.0.0.1",
      port: 0,
      compression: "on",
      keepaliveMs: 25_000,
    });
    expect(() => parseServeOptions(["--compression", "brotli"])).toThrow("--compression");
  });

  test("measures what a browser sends unless told otherwise", () => {
    const required = ["--url", "http://127.0.0.1:1", "--token-file", "/tmp/token"];
    expect(parseMeasureOptions(required)).toMatchObject({
      acceptEncoding: "gzip, deflate, br, zstd",
      http2: false,
      keepaliveEvents: true,
      frames: 30,
      intervalMs: 1_000,
      idleMs: 60_000,
    });
    expect(
      parseMeasureOptions([...required, "--accept-encoding", "none", "--http2"]),
    ).toMatchObject({ acceptEncoding: null, http2: true });
    expect(() => parseMeasureOptions(["--url", "http://127.0.0.1:1"])).toThrow("--token-file");
  });
});

describe("the probe end to end", () => {
  async function server(keepaliveMs = 25_000): Promise<{ probe: ProbeServer; token: string }> {
    const probe = await startProbeServer({
      bind: "127.0.0.1",
      port: 0,
      compression: "on",
      keepaliveMs,
    });
    cleanups.push(() => probe.stop());
    return { probe, token: (await readFile(probe.tokenFile, "utf8")).trim() };
  }

  const schedule = (
    url: string,
    token: string,
    overrides: Partial<ProbeMeasureOptions> = {},
  ): ProbeMeasureOptions => ({
    url,
    token,
    label: "test",
    acceptEncoding: "gzip",
    http2: false,
    keepaliveEvents: true,
    frames: 5,
    intervalMs: 20,
    idleMs: 20,
    reconnectAfter: 0,
    ...overrides,
  });

  test("keeps its token out of the printed fields, in a private file", async () => {
    const { probe, token } = await server();
    expect(token).toHaveLength(48);
    expect(probe.url).not.toContain(token);
    expect((await stat(probe.tokenFile)).mode & 0o777).toBe(0o600);
  });

  test("reads every tick on an untouched route and matches the gateway's bytes", async () => {
    const { probe, token } = await server();
    const result = await measureRoute(schedule(probe.url, token));
    // Lateness is left to the unit tests above: a busy host can delay a tick here.
    expect(result).toMatchObject({
      status: 200,
      ticks: 6,
      missing: 0,
      duplicates: 0,
      outOfOrder: 0,
      contentEncoding: "gzip",
      vary: "Accept-Encoding",
      cacheControl: "no-store, no-transform",
      bytesMatch: true,
      streamingActiveAfterClose: 0,
    });
    expect(result.clientRawBytes).toBeGreaterThan(0);
    expect(result.keepalives).toBeGreaterThanOrEqual(1);
  });

  test("measures identity for a client that does not ask for gzip", async () => {
    const { probe, token } = await server();
    const result = await measureRoute(schedule(probe.url, token, { acceptEncoding: "identity" }));
    expect(result).toMatchObject({
      missing: 0,
      contentEncoding: null,
      vary: "Accept-Encoding",
      bytesMatch: true,
    });
  });

  test("resumes from its cursor across a reconnect without a duplicate", async () => {
    const { probe, token } = await server();
    const result = await measureRoute(schedule(probe.url, token, { reconnectAfter: 2 }));
    expect(result).toMatchObject({
      reconnects: 1,
      missing: 0,
      duplicates: 0,
      outOfOrder: 0,
      bytesMatch: null,
      streamingActiveAfterClose: 0,
    });
  });

  /** A pass-through proxy whose handling of the event stream's body the test decides. */
  async function proxyInFront(
    origin: string,
    onEventStream: (upstream: IncomingMessage, response: ServerResponse) => void,
  ): Promise<string> {
    const target = new URL(origin);
    const proxy = createServer((request, response) => {
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: request.url,
          method: request.method,
          headers: { ...request.headers, host: target.host },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          response.flushHeaders();
          if (request.url?.startsWith("/__orkestrator/events")) {
            onEventStream(upstreamResponse, response);
          } else {
            upstreamResponse.pipe(response);
          }
        },
      );
      request.pipe(upstream);
      response.once("close", () => upstream.destroy());
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          proxy.closeAllConnections();
          proxy.close(() => resolve());
        }),
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address !== "object") throw new Error("Proxy did not bind");
    return `http://127.0.0.1:${address.port}`;
  }

  test("reports ticks a route held as not incremental", async () => {
    const { probe, token } = await server();
    const holdMs = 300;
    const url = await proxyInFront(probe.url, (upstream, response) => {
      const held: Buffer[] = [];
      let holding = true;
      const release = setTimeout(() => {
        holding = false;
        for (const chunk of held.splice(0)) response.write(chunk);
      }, holdMs);
      cleanups.push(() => clearTimeout(release));
      upstream.on("data", (chunk: Buffer) => {
        if (holding) held.push(chunk);
        else response.write(chunk);
      });
    });
    // The stream opens before the first tick, and the hold outlasts several ticks.
    const result = await measureRoute(
      schedule(url, token, { frames: 8, intervalMs: 60, idleMs: 60 }),
    );
    expect(result.missing).toBe(0);
    expect(result.delayMaxMs).toBeGreaterThan(result.heldThresholdMs);
    expect(result.heldTicks).toBeGreaterThan(0);
    expect(result.incremental).toBe(false);
  });

  test("reports a body a route changed as not incremental", async () => {
    const { probe, token } = await server();
    const url = await proxyInFront(probe.url, (upstream, response) => {
      response.write(": added by the hop\n\n");
      upstream.pipe(response);
    });
    const result = await measureRoute(schedule(url, token, { acceptEncoding: "identity" }));
    expect(result).toMatchObject({ missing: 0, bytesMatch: false, incremental: false });
    expect(result.clientRawBytes).toBeGreaterThan(result.serverEncodedBytes);
  });
});

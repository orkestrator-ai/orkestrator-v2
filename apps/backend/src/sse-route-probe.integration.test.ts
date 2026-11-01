import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createHttp2Server } from "node:http2";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  openSseProbeStream,
  main,
  measureRoute,
  startProbeServer,
  type ProbeMeasureOptions,
  type ProbeServer,
} from "../scripts/sse-route-probe.js";

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

const cleanups: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
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
    rejectPath?: string | (() => string | undefined),
    holdHeaders = false,
  ): Promise<string> {
    const target = new URL(origin);
    const proxy = createServer((request, response) => {
      if (request.url === (typeof rejectPath === "function" ? rejectPath() : rejectPath)) {
        response.writeHead(503);
        response.end();
        return;
      }
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
          if (!holdHeaders || !request.url?.startsWith("/__orkestrator/events"))
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

  test.each([false, true])(
    "withheld headers time out and close the socket (http2=%s)",
    async (http2) => {
      let closed = false;
      const handler = (request: IncomingMessage, response: ServerResponse) => {
        request.resume();
        response.on("close", () => {
          closed = true;
        });
      };
      const peer = http2
        ? createHttp2Server((request, response) => {
            request.resume();
            response.on("close", () => {
              closed = true;
            });
          })
        : createServer(handler);
      cleanups.push(() => {
        peer.close();
      });
      await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
      const address = peer.address();
      if (!address || typeof address === "string") throw new Error("No address");
      await expect(
        openSseProbeStream(`http://127.0.0.1:${address.port}/events`, {
          http2,
          headerTimeoutMs: 100,
        }),
      ).rejects.toThrow("Timed out waiting");
      await waitUntil(() => closed, "Pending request was not destroyed");
    },
  );

  test("invoke rejection closes the stream and releases the compressor", async () => {
    const { probe, token } = await server();
    let closed = false;
    const url = await proxyInFront(
      probe.url,
      (upstream, response) => {
        upstream.pipe(response);
        response.on("close", () => {
          closed = true;
        });
      },
      "/__orkestrator/invoke",
    );
    await expect(measureRoute(schedule(url, token))).rejects.toThrow("503");
    await waitUntil(() => closed, "Failed measurement left stream open");
    let active = -1;
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${probe.url}/__orkestrator/metrics`, {
        headers: { authorization: `Bearer ${token}` },
      });
      active = (await response.json()).compression.streamingActive;
      if (active === 0) break;
      await Bun.sleep(20);
    }
    expect(active).toBe(0);
  });

  test("a measurement with withheld headers fails before starting ticks", async () => {
    const { probe, token } = await server();
    let closed = false;
    const url = await proxyInFront(
      probe.url,
      (upstream, response) => {
        upstream.resume();
        response.on("close", () => {
          closed = true;
        });
      },
      undefined,
      true,
    );
    await expect(measureRoute(schedule(url, token, { headerTimeoutMs: 100 }))).rejects.toThrow(
      "Timed out waiting",
    );
    await waitUntil(() => closed, "Header timeout left stream open");
  });

  test.each(["metrics", "reconnect"])("cleans up after a %s rejection", async (failure) => {
    const { probe, token } = await server();
    let opened = false;
    let closed = false;
    const url = await proxyInFront(
      probe.url,
      (upstream, response) => {
        opened = true;
        upstream.pipe(response);
        response.on("close", () => {
          closed = true;
        });
      },
      () =>
        opened
          ? failure === "metrics"
            ? "/__orkestrator/metrics"
            : "/__orkestrator/events?keepaliveEvents=1"
          : undefined,
    );
    await expect(
      measureRoute(
        schedule(url, token, {
          reconnectAfter: failure === "reconnect" ? 1 : 0,
        }),
      ),
    ).rejects.toThrow("503");
    await waitUntil(() => closed, "Failed measurement left stream open");
  });

  test("measures a complete route over HTTP/2", async () => {
    const { probe, token } = await server();
    const target = new URL(probe.url);
    const sessions = new Set<import("node:http2").ServerHttp2Session>();
    const peer = createHttp2Server((request, response) => {
      const headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) => !key.startsWith(":")),
      );
      const upstream = httpRequest(
        {
          hostname: target.hostname,
          port: target.port,
          path: request.url,
          method: request.method,
          headers,
        },
        (body) => {
          const forwarded = Object.fromEntries(
            Object.entries(body.headers).filter(
              ([key]) => !["connection", "keep-alive", "transfer-encoding"].includes(key),
            ),
          );
          response.writeHead(body.statusCode ?? 502, forwarded);
          body.pipe(response);
          body.on("error", () => response.destroy());
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
      response.on("close", () => upstream.destroy());
    });
    peer.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    cleanups.push(() => {
      for (const session of sessions) session.destroy();
      peer.close();
    });
    await new Promise<void>((resolve) => peer.listen(0, "127.0.0.1", resolve));
    const address = peer.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const result = await measureRoute(
      schedule(probe.url, token, {
        http2: true,
        eventOrigin: `http://127.0.0.1:${address.port}`,
      }),
    );
    expect(result).toMatchObject({
      http2: true,
      ticks: 6,
      missing: 0,
      bytesMatch: true,
      streamingActiveAfterClose: 0,
    });
  });

  test("CLI maps incremental, changed-body and error runs to 0, 1 and 2", async () => {
    const { probe } = await server();
    const args = [
      "measure",
      "--token-file",
      probe.tokenFile,
      "--frames",
      "1",
      "--interval-ms",
      "100",
      "--idle-ms",
      "0",
    ];
    expect(await main([...args, "--url", probe.url])).toBe(0);
    const url = await proxyInFront(probe.url, (upstream, response) => {
      response.write(": extra\n\n");
      upstream.pipe(response);
    });
    expect(await main([...args, "--url", url, "--accept-encoding", "identity"])).toBe(1);
    const child = Bun.spawn([process.execPath, "../scripts/sse-route-probe.ts", "measure"], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toContain("--url");
  });

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
    expect(result).toMatchObject({
      missing: 0,
      bytesMatch: false,
      incremental: false,
    });
    expect(result.clientRawBytes).toBeGreaterThan(result.serverEncodedBytes);
  });
});

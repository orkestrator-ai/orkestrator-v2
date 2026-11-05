import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { decodeResponseBody, requestUrl, startGateway } from "./gateway-test-harness.js";

/** No other timer in this file's process asks for this delay. */
const IDLE_MS = 431;

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function upstream(handler: (response: ServerResponse) => void | Promise<void>) {
  const server = createServer((_request, response) => void handler(response));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function countIdleTimers() {
  const real = globalThis.setTimeout;
  let created = 0;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === IDLE_MS) created += 1;
    return (real as (...parameters: unknown[]) => unknown)(handler, delay, ...args);
  }) as typeof setTimeout;
  return {
    created: () => created,
    restore: () => {
      globalThis.setTimeout = real;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.each([
  {
    site: "buffered proxy",
    route: "proxy",
    contentType: "text/plain; charset=utf-8",
    stalledMessage: `Proxied response stalled for ${IDLE_MS} ms`,
  },
  {
    site: "browser preview rewrite",
    route: "browser",
    contentType: "text/html; charset=utf-8",
    stalledMessage: "Browser preview response stalled",
  },
])("$site idle deadline", ({ route, contentType, stalledMessage }) => {
  const CHUNKS = 10;
  const CHUNK = "x".repeat(2048);

  async function fetchBody(port: number) {
    const { info } = await startGateway({ compression: "body", proxyBodyIdleTimeoutMs: IDLE_MS });
    return requestUrl(`${info.url}__orkestrator/${route}/loopback/${port}/`, {
      headers: { authorization: `Bearer ${info.token}`, "accept-encoding": "gzip" },
    });
  }

  test("a steady body outlasts the deadline on one timer", async () => {
    const port = await upstream(async (response) => {
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": CHUNKS * CHUNK.length,
      });
      for (let chunk = 0; chunk < CHUNKS; chunk += 1) {
        response.write(CHUNK);
        await sleep(60);
      }
      response.end();
    });
    const timers = countIdleTimers();
    try {
      const result = await fetchBody(port);
      expect(result.status).toBe(200);
      // Ten chunks 60 ms apart run past the 431 ms deadline only if each one moved it.
      expect(decodeResponseBody(result)).toBe(CHUNK.repeat(CHUNKS));
      expect(timers.created()).toBe(1);
    } finally {
      timers.restore();
    }
  });

  test("silence after a chunk still ends the body at the deadline", async () => {
    let lastChunkAt = 0;
    const port = await upstream(async (response) => {
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": CHUNKS * CHUNK.length,
      });
      response.write(CHUNK);
      await sleep(60);
      lastChunkAt = Date.now();
      response.write(CHUNK);
    });
    const result = await fetchBody(port);
    expect(result.status).toBe(502);
    expect(result.body).toContain(stalledMessage);
    // Measured from the second chunk, not the first: the deadline moved.
    expect(lastChunkAt).toBeGreaterThan(0);
    expect(Date.now() - lastChunkAt).toBeGreaterThanOrEqual(IDLE_MS);
  });
});

describe("timer.refresh() as these deadlines use it", () => {
  test("keeps an unreferenced timer unreferenced and does nothing once cleared", async () => {
    let fired = 0;
    const cleared = setTimeout(() => {
      fired += 1;
    }, 5);
    cleared.unref();
    cleared.refresh();
    expect(cleared.hasRef()).toBe(false);
    clearTimeout(cleared);
    cleared.refresh();
    await sleep(30);
    expect(fired).toBe(0);
  });

  test("moves the deadline from now", async () => {
    let fired = 0;
    const timer = setTimeout(() => {
      fired += 1;
    }, 80);
    for (let beat = 0; beat < 4; beat += 1) {
      await sleep(40);
      timer.refresh();
    }
    expect(fired).toBe(0);
    await sleep(160);
    expect(fired).toBe(1);
  });
});

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
  let refreshed = 0;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
    const timer = (real as unknown as (...parameters: unknown[]) => ReturnType<typeof setTimeout>)(
      handler,
      delay,
      ...args,
    );
    if (delay === IDLE_MS) {
      created += 1;
      // Count the moves of the deadline rather than timing them: the runtime
      // starts a refreshed timer from its cached loop time, which a starved
      // process can leave far behind the wall clock.
      const refresh = timer.refresh.bind(timer);
      timer.refresh = () => {
        refreshed += 1;
        return refresh();
      };
    }
    return timer;
  }) as typeof setTimeout;
  return {
    created: () => created,
    refreshed: () => refreshed,
    restore: () => {
      globalThis.setTimeout = real;
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("buffered proxy idle deadline", () => {
  const contentType = "text/plain; charset=utf-8";
  const stalledMessage = `Proxied response stalled for ${IDLE_MS} ms`;
  const CHUNKS = 10;
  const CHUNK = "x".repeat(2048);

  async function fetchBody(port: number) {
    const { info } = await startGateway({ compression: "body", proxyBodyIdleTimeoutMs: IDLE_MS });
    return requestUrl(`${info.url}__orkestrator/proxy/loopback/${port}/`, {
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
    let secondChunkWritten = false;
    const port = await upstream(async (response) => {
      response.writeHead(200, {
        "content-type": contentType,
        "content-length": CHUNKS * CHUNK.length,
      });
      response.write(CHUNK);
      await sleep(60);
      response.write(CHUNK);
      secondChunkWritten = true;
    });
    const timers = countIdleTimers();
    try {
      const result = await fetchBody(port);
      expect(result.status).toBe(502);
      expect(result.body).toContain(stalledMessage);
      // The stall is reported only after the body went silent, and the deadline
      // was one timer that the arriving chunks moved. The "steady body" case
      // proves a moved deadline outlasts its own length; no elapsed time is
      // compared here because it depends on when a loaded host schedules the read.
      expect(secondChunkWritten).toBe(true);
      expect(timers.created()).toBe(1);
      expect(timers.refreshed()).toBeGreaterThanOrEqual(1);
    } finally {
      timers.restore();
    }
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

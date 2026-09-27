/**
 * Real-socket coverage for client-disconnect detection.
 *
 * The event assumptions *are* the behavior under test: these cases are why the
 * per-request 50 ms socket poll could be removed, and they fail if a runtime
 * upgrade stops emitting the events the watcher relies on.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import type { AddressInfo } from "node:net";
import { watchClientDisconnect } from "./acp-client-disconnect.js";

interface Handled {
  request: IncomingMessage;
  response: ServerResponse;
  disconnects: number;
  stop: () => void;
  /** Resolves on the first disconnect notification. */
  disconnected: Promise<void>;
}

type Behavior = "hold" | "respond" | "stream" | "predestroy";

let server: Server;
let port: number;
let behavior: Behavior = "hold";
const handled: Handled[] = [];
const arrivals: Array<(handled: Handled) => void> = [];

function register(request: IncomingMessage, response: ServerResponse): Handled {
  let notify!: () => void;
  const entry: Handled = {
    request,
    response,
    disconnects: 0,
    stop: () => undefined,
    disconnected: new Promise<void>((resolve) => {
      notify = resolve;
    }),
  };
  entry.stop = watchClientDisconnect(request, response, () => {
    entry.disconnects += 1;
    notify();
  });
  handled.push(entry);
  arrivals.shift()?.(entry);
  return entry;
}

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    if (behavior === "predestroy") {
      // The socket closes, and emits everything it will ever emit, before the
      // watcher is installed.
      request.socket.once("close", () => register(request, response));
      request.socket.destroy();
      return;
    }
    const entry = register(request, response);
    if (behavior === "respond") {
      response.end("ok");
      entry.stop();
    } else if (behavior === "stream") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function nextRequest(): Promise<Handled> {
  return new Promise((resolve) => arrivals.push(resolve));
}

function open(targetPort = port): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(targetPort, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

function get(path = "/"): string {
  return `GET ${path} HTTP/1.1\r\nHost: bridge\r\nConnection: keep-alive\r\n\r\n`;
}

/** A disconnect must be noticed promptly; a missed one would hang here. */
async function noticed(entry: Handled): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    entry.disconnected,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("disconnect was not noticed")), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition was not met");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("watchClientDisconnect over real sockets", () => {
  test("notices a full close while the handler is still working", async () => {
    behavior = "hold";
    const socket = await open();
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;

    socket.destroy();
    await noticed(entry);

    expect(entry.disconnects).toBe(1);
    entry.stop();
  });

  test("notices a connection reset", async () => {
    behavior = "hold";
    const socket = await open();
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;

    socket.resetAndDestroy();
    await noticed(entry);
    expect(entry.disconnects).toBe(1);
    entry.stop();
  });

  test("notices a peer half-close", async () => {
    behavior = "hold";
    const socket = await open();
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;

    socket.end();
    await noticed(entry);
    expect(entry.disconnects).toBe(1);
    entry.stop();
    socket.destroy();
  });

  test("notices an abort part-way through the request body", async () => {
    behavior = "hold";
    const socket = await open();
    const arrived = nextRequest();
    socket.write("POST /session/create HTTP/1.1\r\nHost: bridge\r\nContent-Length: 100\r\n\r\n{");
    const entry = await arrived;

    socket.destroy();
    await noticed(entry);
    expect(entry.disconnects).toBe(1);
    entry.stop();
  });

  test("notices a proxy that tears down its upstream", async () => {
    behavior = "hold";
    const proxy: NetServer = createNetServer((downstream) => {
      const upstream = connect(port, "127.0.0.1");
      downstream.pipe(upstream);
      upstream.pipe(downstream);
      downstream.on("close", () => upstream.destroy());
      upstream.on("close", () => downstream.destroy());
      downstream.on("error", () => undefined);
      upstream.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const socket = await open((proxy.address() as AddressInfo).port);
      const arrived = nextRequest();
      socket.write(get());
      const entry = await arrived;

      socket.destroy();
      await noticed(entry);
      expect(entry.disconnects).toBe(1);
      entry.stop();
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test("notices a disconnect after the response started streaming", async () => {
    behavior = "stream";
    const socket = await open();
    socket.on("data", () => undefined);
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;

    socket.destroy();
    await noticed(entry);
    expect(entry.disconnects).toBe(1);
    entry.stop();
  });

  test("a socket that closed before the watcher was installed is reported at once", async () => {
    behavior = "predestroy";
    const socket = await open();
    socket.on("error", () => undefined);
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;

    // Synchronous: no event is left to deliver it later.
    expect(entry.disconnects).toBe(1);
    entry.stop();
  });

  test("a completed response is never reported, and keep-alive reuse does not accumulate listeners", async () => {
    behavior = "respond";
    const socket = await open();
    socket.on("data", () => undefined);
    const firstArrived = nextRequest();
    socket.write(get("/first"));
    const first = await firstArrived;
    await waitUntil(() => first.response.writableFinished);

    behavior = "hold";
    const secondArrived = nextRequest();
    socket.write(get("/second"));
    const second = await secondArrived;
    // The same connection carries both requests, and the finished one has
    // taken its listeners with it.
    expect(second.request.socket).toBe(first.request.socket);
    const closeListeners = second.request.socket.listenerCount("close");

    socket.destroy();
    await noticed(second);

    expect(first.disconnects).toBe(0);
    expect(second.disconnects).toBe(1);
    second.stop();
    expect(second.request.socket.listenerCount("close")).toBe(closeListeners - 1);
  });

  test("stop() removes every listener, so a later disconnect is not reported", async () => {
    behavior = "hold";
    const socket = await open();
    const arrived = nextRequest();
    socket.write(get());
    const entry = await arrived;
    const before = {
      request: entry.request.listenerCount("aborted"),
      response: entry.response.listenerCount("close"),
      socketEnd: entry.request.socket.listenerCount("end"),
      socketClose: entry.request.socket.listenerCount("close"),
    };

    entry.stop();
    expect({
      request: entry.request.listenerCount("aborted"),
      response: entry.response.listenerCount("close"),
      socketEnd: entry.request.socket.listenerCount("end"),
      socketClose: entry.request.socket.listenerCount("close"),
    }).toEqual({
      request: before.request - 1,
      response: before.response - 1,
      socketEnd: before.socketEnd - 1,
      socketClose: before.socketClose - 1,
    });

    const closed = new Promise<void>((resolve) => entry.request.socket.once("close", resolve));
    socket.destroy();
    await closed;
    expect(entry.disconnects).toBe(0);
  });

  test("installs no timer for an in-flight request", async () => {
    behavior = "hold";
    const socket = await open();
    const originalSetInterval = globalThis.setInterval;
    let armed = 0;
    const arrived = nextRequest();
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      armed += 1;
      return originalSetInterval(...args);
    }) as typeof setInterval;
    try {
      socket.write(get());
      const entry = await arrived;
      expect(armed).toBe(0);
      socket.destroy();
      await noticed(entry);
      entry.stop();
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  connect,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import { Readable } from "node:stream";

import {
  http1Request,
  PreviewHttp1Error,
  serializeRequestHead,
  type Http1RequestOptions,
} from "./preview-http1.js";

const servers: Array<Server | NetServer> = [];
const accepted = new Set<Socket>();

afterEach(async () => {
  for (const socket of Array.from(accepted)) socket.destroy();
  accepted.clear();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          (server as Server).closeAllConnections?.();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(server: Server | NetServer): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => {
    accepted.add(socket);
    socket.on("close", () => accepted.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

async function socketTo(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function options(overrides: Partial<Http1RequestOptions> = {}): Http1RequestOptions {
  return {
    method: "GET",
    path: "/",
    headers: [["host", "localhost:3000"]],
    headersTimeoutMs: 2_000,
    maxHeaderBytes: 32 * 1024,
    maxHeaderFields: 100,
    ...overrides,
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("http1Request", () => {
  test("streams a chunked response and preserves repeated headers", async () => {
    let releaseSecond!: () => void;
    const port = await listen(
      createHttpServer((request, response) => {
        response.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
        response.writeHead(200, { "x-host": request.headers.host ?? "" });
        response.write("first");
        releaseSecond = () => response.end("second");
      }),
    );
    const result = await http1Request(await socketTo(port), options());
    expect(result.statusCode).toBe(200);
    expect(
      result.headers
        .filter(([name]) => name.toLowerCase() === "set-cookie")
        .map(([, value]) => value),
    ).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    const iterator = result.body[Symbol.asyncIterator]();
    // The first chunk arrives before the upstream finishes the response.
    expect(String((await iterator.next()).value)).toBe("first");
    releaseSecond();
    expect(String((await iterator.next()).value)).toBe("second");
    expect((await iterator.next()).done).toBe(true);
  });

  test("uploads a chunked body with exact bytes", async () => {
    const port = await listen(
      createHttpServer((request, response) => {
        const hash = createHash("sha256");
        let bytes = 0;
        request.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        request.on("end", () =>
          response.end(
            JSON.stringify({
              bytes,
              sha: hash.digest("hex"),
              te: request.headers["transfer-encoding"],
            }),
          ),
        );
      }),
    );
    const payload = Buffer.alloc(300_000, 7);
    const result = await http1Request(
      await socketTo(port),
      options({
        method: "POST",
        body: Readable.from([payload.subarray(0, 100_000), payload.subarray(100_000)]),
        bodyLength: null,
      }),
    );
    const echoed = JSON.parse(String(await readAll(result.body)));
    expect(echoed).toEqual({
      bytes: payload.length,
      sha: createHash("sha256").update(payload).digest("hex"),
      te: "chunked",
    });
  });

  test("HEAD and 304 responses have no body even with a content-length", async () => {
    const port = await listen(
      createHttpServer((request, response) => {
        if (request.method === "HEAD") {
          response.writeHead(200, { "content-length": "1234" });
          response.end();
          return;
        }
        response.writeHead(304, { etag: '"v1"' });
        response.end();
      }),
    );
    const head = await http1Request(await socketTo(port), options({ method: "HEAD" }));
    expect((await readAll(head.body)).length).toBe(0);
    const notModified = await http1Request(await socketTo(port), options());
    expect(notModified.statusCode).toBe(304);
    expect((await readAll(notModified.body)).length).toBe(0);
  });

  test("rejects ambiguous framing and oversized heads", async () => {
    const port = await listen(
      createNetServer((socket) => {
        socket.once("data", (data) => {
          if (String(data).includes("/ambiguous")) {
            socket.end(
              "HTTP/1.1 200 OK\r\ncontent-length: 5\r\ntransfer-encoding: chunked\r\n\r\n0\r\n\r\n",
            );
          } else {
            socket.end(`HTTP/1.1 200 OK\r\nx-big: ${"a".repeat(40_000)}\r\n\r\n`);
          }
        });
      }),
    );
    await expect(
      http1Request(await socketTo(port), options({ path: "/ambiguous" })),
    ).rejects.toMatchObject({ code: "malformed-response" });
    await expect(
      http1Request(await socketTo(port), options({ path: "/big" })),
    ).rejects.toMatchObject({ code: "header-too-large" });
  });

  test("header stall times out and destroys the socket", async () => {
    const port = await listen(createNetServer(() => undefined));
    const socket = await socketTo(port);
    await expect(http1Request(socket, options({ headersTimeoutMs: 30 }))).rejects.toMatchObject({
      code: "headers-timeout",
    });
    expect(socket.destroyed).toBe(true);
  });

  test("a connection closed mid-body errors the body stream", async () => {
    const port = await listen(
      createNetServer((socket) => {
        socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\ncontent-length: 10\r\n\r\nabc"));
      }),
    );
    const result = await http1Request(await socketTo(port), options());
    await expect(readAll(result.body)).rejects.toBeInstanceOf(PreviewHttp1Error);
  });

  test("returns the socket for a protocol upgrade with leftover bytes", async () => {
    const port = await listen(
      createNetServer((socket) => {
        socket.once("data", () =>
          socket.write(
            "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\nEXTRA",
          ),
        );
      }),
    );
    const socket = await socketTo(port);
    const result = await http1Request(
      socket,
      options({
        headers: [
          ["host", "x"],
          ["connection", "Upgrade"],
          ["upgrade", "websocket"],
        ],
        upgrade: true,
      }),
    );
    expect(result.statusCode).toBe(101);
    expect(String(result.upgradeHead)).toBe("EXTRA");
    socket.destroy();
  });

  test("refuses header injection", () => {
    expect(() =>
      serializeRequestHead(
        "GET",
        "/",
        [["x-a", "b\r\nx-evil: 1"]],
        { length: null, chunked: false },
        "close",
      ),
    ).toThrow(PreviewHttp1Error);
    expect(() =>
      serializeRequestHead("GET", "/a b", [], { length: null, chunked: false }, "close"),
    ).toThrow(PreviewHttp1Error);
    expect(() =>
      serializeRequestHead("GET", "http://x/", [], { length: null, chunked: false }, "close"),
    ).toThrow(PreviewHttp1Error);
  });

  test("abort cancels the exchange", async () => {
    const port = await listen(createNetServer(() => undefined));
    const controller = new AbortController();
    const pending = http1Request(await socketTo(port), options({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

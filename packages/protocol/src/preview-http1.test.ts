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
  isValidRequestTarget,
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

  test("refuses characters the latin1 wire encoding would truncate into CR/LF", () => {
    const framing = { length: null, chunked: false };
    // U+010D U+010A encode to 0x0D 0x0A; U+0120 to a space.
    for (const path of ["/a\u010d\u010aX-Evil: 1", "/a\u0120b", "/caf\u00e9", "/a\u200bb"]) {
      expect(isValidRequestTarget(path)).toBe(false);
      expect(() => serializeRequestHead("GET", path, [], framing, "close")).toThrow(
        expect.objectContaining({ code: "invalid-request" }),
      );
    }
    for (const value of ["b\u010d\u010ax-evil: 1", "a\u0120b"]) {
      expect(() => serializeRequestHead("GET", "/", [["x-a", value]], framing, "close")).toThrow(
        expect.objectContaining({ code: "invalid-request" }),
      );
    }
    // Percent-encoded targets and obs-text / tab in values stay allowed.
    expect(isValidRequestTarget("/caf%C3%A9?q=%20#x")).toBe(true);
    const head = serializeRequestHead("GET", "/", [["x-a", "caf\u00e9\tok"]], framing, "close");
    expect(head.includes(Buffer.from("x-a: caf\xe9\tok\r\n", "latin1"))).toBe(true);
  });

  test("a slow upload does not count against the headers timeout", async () => {
    const port = await listen(
      createHttpServer((request, response) => {
        let bytes = 0;
        request.on("data", (chunk: Buffer) => (bytes += chunk.length));
        request.on("end", () => response.end(String(bytes)));
      }),
    );
    async function* slow() {
      for (let index = 0; index < 4; index += 1) {
        await Bun.sleep(40);
        yield Buffer.alloc(10, index);
      }
    }
    const result = await http1Request(
      await socketTo(port),
      options({
        method: "POST",
        body: Readable.from(slow()),
        bodyLength: null,
        headersTimeoutMs: 60,
        bodyIdleTimeoutMs: 1_000,
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(String(await readAll(result.body))).toBe("40");
  });

  test("the headers timeout still fires once the body is sent", async () => {
    let received = 0;
    const port = await listen(
      createNetServer((socket) => socket.on("data", (chunk) => (received += chunk.length))),
    );
    const socket = await socketTo(port);
    const started = Date.now();
    await expect(
      http1Request(
        socket,
        options({
          method: "POST",
          body: Readable.from([Buffer.from("payload")]),
          bodyLength: 7,
          headersTimeoutMs: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: "headers-timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(received).toBeGreaterThan(0);
    expect(socket.destroyed).toBe(true);
  });

  test("a stalled upload is bounded by the body idle timeout", async () => {
    const port = await listen(createNetServer(() => undefined));
    const socket = await socketTo(port);
    const body = new Readable({ read() {} });
    body.push(Buffer.from("start"));
    await expect(
      http1Request(
        socket,
        options({
          method: "POST",
          body,
          bodyLength: null,
          headersTimeoutMs: 5_000,
          bodyIdleTimeoutMs: 50,
        }),
      ),
    ).rejects.toMatchObject({ code: "body-timeout" });
    expect(socket.destroyed).toBe(true);
  });

  describe("connection reuse", () => {
    async function exchange(response: string): Promise<{ reused: boolean; socket: Socket }> {
      const port = await listen(
        createNetServer((socket) => socket.once("data", () => socket.write(response))),
      );
      const socket = await socketTo(port);
      let reused = false;
      const result = await http1Request(
        socket,
        options({ keepAlive: true, onReusable: () => (reused = true) }),
      );
      expect(String(await readAll(result.body))).toBe("ok");
      return { reused, socket };
    }

    test("a cleanly framed HTTP/1.1 response hands the socket back", async () => {
      const port = await listen(
        createNetServer((socket) =>
          socket.on("data", () => socket.write("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")),
        ),
      );
      const socket = await socketTo(port);
      const reusable: Socket[] = [];
      const first = await http1Request(
        socket,
        options({ keepAlive: true, onReusable: (reused) => reusable.push(reused as Socket) }),
      );
      expect(String(await readAll(first.body))).toBe("ok");
      expect(reusable).toEqual([socket]);
      expect(socket.destroyed).toBe(false);
      // The returned connection carries a second exchange.
      const second = await http1Request(reusable[0]!, options());
      expect(String(await readAll(second.body))).toBe("ok");
    });

    test("an HTTP/1.1 response asking to close is not reused", async () => {
      const outcome = await exchange(
        "HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
      );
      expect(outcome.reused).toBe(false);
      expect(outcome.socket.destroyed).toBe(true);
    });

    test("HTTP/1.0 is reused only with an explicit keep-alive", async () => {
      const plain = await exchange("HTTP/1.0 200 OK\r\ncontent-length: 2\r\n\r\nok");
      expect(plain.reused).toBe(false);
      expect(plain.socket.destroyed).toBe(true);
      const kept = await exchange(
        "HTTP/1.0 200 OK\r\ncontent-length: 2\r\nconnection: keep-alive\r\n\r\nok",
      );
      expect(kept.reused).toBe(true);
      expect(kept.socket.destroyed).toBe(false);
      kept.socket.destroy();
    });
  });

  describe("malformed chunked responses", () => {
    async function chunkedBody(payload: string): Promise<{ error: unknown; socket: Socket }> {
      const port = await listen(
        createNetServer((socket) =>
          socket.once("data", () =>
            socket.write(`HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n${payload}`),
          ),
        ),
      );
      const socket = await socketTo(port);
      const result = await http1Request(socket, options());
      const error = await readAll(result.body).then(
        () => null,
        (failure: unknown) => failure,
      );
      return { error, socket };
    }

    test("an invalid chunk size errors the body and closes the connection", async () => {
      const { error, socket } = await chunkedBody("zz\r\nabc\r\n0\r\n\r\n");
      expect(error).toMatchObject({ code: "malformed-response", message: "Invalid chunk size" });
      expect(socket.destroyed).toBe(true);
    });

    test("chunk data without its CRLF terminator is refused", async () => {
      const { error, socket } = await chunkedBody("3\r\nabcX\r\n0\r\n\r\n");
      expect(error).toMatchObject({
        code: "malformed-response",
        message: "Missing chunk terminator",
      });
      expect(socket.destroyed).toBe(true);
    });

    test("bytes after the terminal chunk are refused", async () => {
      const { error, socket } = await chunkedBody("2\r\nok\r\n0\r\n\r\nEXTRA");
      expect(error).toMatchObject({
        code: "malformed-response",
        message: "Data after final chunk",
      });
      expect(socket.destroyed).toBe(true);
    });
  });

  test("abort cancels the exchange", async () => {
    const port = await listen(createNetServer(() => undefined));
    const controller = new AbortController();
    const pending = http1Request(await socketTo(port), options({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});

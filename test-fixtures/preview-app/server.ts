/**
 * Deterministic HTTP/WebSocket fixture for browser-preview transport tests.
 *
 * Every response carries the fixture's service marker so a test can detect a
 * *wrong application* rather than merely a successful HTTP status. Content is
 * synthetic. The server records a bounded log of request metadata (method,
 * path without query, selected headers) so tests can assert what actually
 * reached the upstream — including that transport credentials did not.
 *
 * Runs under Bun or Node (`node:http` only), so the same file can be copied into
 * a container image for Docker fixtures.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface PreviewFixtureRequest {
  method: string;
  path: string;
  host: string | undefined;
  origin: string | undefined;
  authorization: string | undefined;
  cookie: string | undefined;
  forwardedHost: string | undefined;
  forwardedProto: string | undefined;
  headerNames: string[];
}

export interface PreviewFixture {
  marker: string;
  port: number;
  url: string;
  server: Server;
  requests: PreviewFixtureRequest[];
  /** Resolve the deliberately stalled response(s). */
  releaseStalled(): void;
  /** Open upstream sockets, for leak assertions. */
  openSockets(): number;
  close(): Promise<void>;
}

export interface PreviewFixtureOptions {
  marker?: string;
  host?: string;
  port?: number;
  /** Bearer token `/auth/bearer` accepts. */
  bearerToken?: string;
}

const MAX_RECORDED_REQUESTS = 256;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function html(marker: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${marker}</title>
<link rel="stylesheet" href="/assets/app.css"></head>
<body data-service-marker="${marker}"><main>${body}</main>
<script type="module" src="/assets/app.js"></script></body></html>`;
}

function send(
  response: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  headers: Record<string, string | string[]> = {},
) {
  response.writeHead(status, { "content-type": type, ...headers });
  response.end(body);
}

export function startPreviewFixture(options: PreviewFixtureOptions = {}): Promise<PreviewFixture> {
  const marker = options.marker ?? "fixture-a";
  const bearer = options.bearerToken ?? "fixture-app-token";
  const requests: PreviewFixtureRequest[] = [];
  const stalled = new Set<() => void>();
  const sockets = new Set<Socket>();
  const binary = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < binary.length; index++) binary[index] = (index * 31 + 7) & 0xff;
  const binaryHash = createHash("sha256").update(binary).digest("hex");

  const record = (request: IncomingMessage, path: string) => {
    requests.push({
      method: request.method ?? "GET",
      path,
      host: request.headers.host,
      origin: request.headers.origin,
      authorization: request.headers.authorization,
      cookie: request.headers.cookie,
      forwardedHost: request.headers["x-forwarded-host"] as string | undefined,
      forwardedProto: request.headers["x-forwarded-proto"] as string | undefined,
      headerNames: Object.keys(request.headers).sort(),
    });
    if (requests.length > MAX_RECORDED_REQUESTS) requests.shift();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    record(request, url.pathname);
    response.setHeader("x-service-marker", marker);
    const path = url.pathname;

    if (path === "/" || path.startsWith("/app/")) {
      return send(
        response,
        200,
        "text/html; charset=utf-8",
        html(
          marker,
          `<h1>${marker}</h1><img srcset="/assets/small.png 1x, /assets/large.png 2x" alt="">`,
        ),
        { "x-service-marker": marker },
      );
    }
    if (path === "/health")
      return send(response, 200, "application/json", JSON.stringify({ ok: true, marker }), {
        "x-service-marker": marker,
      });
    if (path === "/assets/app.css")
      return send(response, 200, "text/css", `body{--marker:"${marker}"}`, {
        "x-service-marker": marker,
        etag: `"css-${marker}"`,
      });
    if (path === "/assets/app.js")
      return send(
        response,
        200,
        "text/javascript",
        `document.body.dataset.loaded=${JSON.stringify(marker)};`,
        { "x-service-marker": marker },
      );
    if (path === "/echo") {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 1024 * 1024) chunks.push(chunk);
      });
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        send(
          response,
          200,
          "application/json",
          JSON.stringify({
            marker,
            method: request.method,
            bytes: size,
            sha256: createHash("sha256").update(body).digest("hex"),
          }),
          { "x-service-marker": marker },
        );
      });
      return;
    }
    if (path === "/chunked") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-service-marker": marker,
      });
      response.write(
        `<!doctype html><html><body data-service-marker="${marker}"><p id="first">first</p>`,
      );
      const finish = () => response.end(`<p id="second">second</p></body></html>`);
      stalled.add(finish);
      return;
    }
    if (path === "/stall-headers") {
      stalled.add(() => send(response, 200, "text/plain", "late", { "x-service-marker": marker }));
      return;
    }
    if (path === "/stall-body") {
      response.writeHead(200, { "content-type": "text/plain", "x-service-marker": marker });
      response.write("partial");
      stalled.add(() => response.end("done"));
      return;
    }
    if (path === "/endless") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "x-service-marker": marker,
      });
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      const pump = () => {
        while (!response.destroyed && response.write(chunk)) {
          /* keep writing until backpressure */
        }
        if (!response.destroyed) response.once("drain", pump);
      };
      pump();
      return;
    }
    if (path === "/sse") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-service-marker": marker,
      });
      let count = 0;
      const timer = setInterval(() => {
        count += 1;
        response.write(`data: ${marker}-${count}\n\n`);
        if (count >= 3) {
          clearInterval(timer);
          response.end();
        }
      }, 10);
      response.on("close", () => clearInterval(timer));
      return;
    }
    if (path === "/binary") {
      return send(response, 200, "application/octet-stream", binary, {
        "x-service-marker": marker,
        "x-sha256": binaryHash,
      });
    }
    if (path === "/cookies/set") {
      return send(response, 200, "text/plain", "set", {
        "x-service-marker": marker,
        "set-cookie": [
          "__Host-session=synthetic; Path=/; Secure; HttpOnly; SameSite=Lax",
          `plain=${marker}; Path=/`,
          "orkestrator_gateway_auth=forged; Path=/",
          "__Host-orkestrator-preview=forged; Path=/; Secure",
          "widened=1; Domain=example.invalid; Path=/",
        ],
      });
    }
    if (path === "/cookies/echo")
      return send(
        response,
        200,
        "application/json",
        JSON.stringify({ marker, cookie: request.headers.cookie ?? null }),
        { "x-service-marker": marker },
      );
    if (path === "/auth/bearer") {
      const ok = request.headers.authorization === `Bearer ${bearer}`;
      return send(
        response,
        ok ? 200 : 401,
        "application/json",
        JSON.stringify({ marker, authorized: ok }),
        ok
          ? { "x-service-marker": marker }
          : { "x-service-marker": marker, "www-authenticate": 'Bearer realm="fixture"' },
      );
    }
    if (path === "/redirect/relative")
      return send(response, 302, "text/plain", "", {
        location: "/app/next",
        "x-service-marker": marker,
      });
    if (path === "/redirect/absolute") {
      return send(response, 302, "text/plain", "", {
        location: `http://${request.headers.host ?? "localhost"}/app/abs?x=1`,
        "x-service-marker": marker,
      });
    }
    if (path === "/redirect/external")
      return send(response, 302, "text/plain", "", {
        location: "https://external.invalid/callback",
        "x-service-marker": marker,
      });
    if (path === "/conditional") {
      if (request.headers["if-none-match"] === `"v1"`) {
        response.writeHead(304, { etag: `"v1"`, "x-service-marker": marker });
        return response.end();
      }
      return send(response, 200, "text/plain", "conditional", {
        etag: `"v1"`,
        "x-service-marker": marker,
      });
    }
    if (path === "/range") {
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (range) {
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), 99);
        const bytes = Buffer.from("0123456789".repeat(10)).subarray(start, end + 1);
        response.writeHead(206, {
          "content-type": "text/plain",
          "content-range": `bytes ${start}-${end}/100`,
          "content-length": bytes.length,
          "x-service-marker": marker,
        });
        return response.end(bytes);
      }
      return send(response, 200, "text/plain", "0123456789".repeat(10), {
        "accept-ranges": "bytes",
        "x-service-marker": marker,
      });
    }
    if (path === "/csp") {
      return send(response, 200, "text/html", html(marker, "csp"), {
        "content-security-policy": "default-src 'self'",
        "x-frame-options": "DENY",
        "x-service-marker": marker,
      });
    }
    return send(response, 404, "text/plain", `not found: ${marker}`, {
      "x-service-marker": marker,
    });
  });

  // Minimal RFC 6455 endpoint: echo with subprotocol selection. Only what the
  // transport tests need — text/binary echo, close echo, and a marker hello.
  server.on("upgrade", (request, socket: Socket, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    record(request, url.pathname);
    if (url.pathname !== "/ws" || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return;
    }
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n");
      return;
    }
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const selected = offered.find((protocol) => protocol === "fixture.v1");
    const accept = createHash("sha1")
      .update(key + WS_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        ...(selected ? [`Sec-WebSocket-Protocol: ${selected}`] : []),
        `X-Service-Marker: ${marker}`,
        "",
        "",
      ].join("\r\n"),
    );
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    writeFrame(
      socket,
      0x1,
      Buffer.from(JSON.stringify({ hello: marker, protocol: selected ?? null })),
    );
    let buffer = head.length ? Buffer.from(head) : Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = readFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        if (frame.opcode === 0x8) {
          writeFrame(socket, 0x8, frame.payload);
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) writeFrame(socket, 0xa, frame.payload);
        else if (frame.opcode === 0x1 || frame.opcode === 0x2)
          writeFrame(socket, frame.opcode, frame.payload);
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
      resolve({
        marker,
        port: address.port,
        url: `http://${host}:${address.port}`,
        server,
        requests,
        releaseStalled() {
          for (const release of Array.from(stalled)) {
            stalled.delete(release);
            release();
          }
        },
        openSockets: () => sockets.size,
        close: () =>
          new Promise<void>((done) => {
            for (const release of Array.from(stalled)) {
              stalled.delete(release);
            }
            for (const socket of Array.from(sockets)) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function writeFrame(socket: Socket, opcode: number, payload: Buffer): void {
  if (socket.destroyed) return;
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const value = Buffer.alloc(10);
            value[0] = 0x80 | opcode;
            value[1] = 127;
            value.writeBigUInt64BE(BigInt(length), 2);
            return value;
          })();
  socket.write(Buffer.concat([header, payload]));
}

function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index++)
      payload[index]! ^= buffer[maskOffset + (index % 4)]!;
  }
  return { opcode, payload, length: offset + length };
}

if (import.meta.main) {
  const fixture = await startPreviewFixture({
    marker: process.env.FIXTURE_MARKER ?? "fixture-a",
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 3000),
  });
  console.log(`Preview fixture ${fixture.marker}: ${fixture.url}`);
}

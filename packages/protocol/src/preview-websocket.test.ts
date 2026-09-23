import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

import {
  acceptPreviewWebSocket,
  connectPreviewWebSocket,
  PreviewWebSocketHandshakeError,
  webSocketAccept,
  type PreviewWebSocket,
} from "./preview-websocket.js";

const servers: Server[] = [];
const endpoints: PreviewWebSocket[] = [];

afterEach(async () => {
  for (const endpoint of endpoints.splice(0)) endpoint.terminate();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function echoServer(
  maxPayload = 1024,
): Promise<{ port: number; accepted: PreviewWebSocket[] }> {
  const accepted: PreviewWebSocket[] = [];
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    const ws = acceptPreviewWebSocket(request, socket, head, { protocol: "test.v1", maxPayload });
    if (!ws) return;
    accepted.push(ws);
    endpoints.push(ws);
    ws.on("message", (data, binary) => ws.send(data, binary));
    ws.start();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, accepted };
}

async function client(port: number, maxPayload = 1024): Promise<PreviewWebSocket> {
  const ws = await connectPreviewWebSocket({
    url: `ws://127.0.0.1:${port}/`,
    protocol: "test.v1",
    maxPayload,
    connectTimeoutMs: 1_000,
    handshakeTimeoutMs: 1_000,
  });
  endpoints.push(ws);
  return ws;
}

function frame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; mask?: boolean } = {},
): Buffer {
  const mask = options.mask ?? true;
  const first = ((options.fin ?? true) ? 0x80 : 0) | opcode;
  const maskBit = mask ? 0x80 : 0;
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([first, maskBit | payload.length]);
  else if (payload.length < 65_536) {
    header = Buffer.from([first, maskBit | 126, 0, 0]);
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!mask) return Buffer.concat([header, payload]);
  const key = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ key[index % 4]!));
  return Buffer.concat([header, key, masked]);
}

async function rawClient(port: number): Promise<{ socket: Socket; received: () => Buffer }> {
  const socket = connect(port, "127.0.0.1");
  let received = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => (received = Buffer.concat([received, chunk])));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    "GET / HTTP/1.1\r\nhost: x\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\nsec-websocket-version: 13\r\nsec-websocket-protocol: test.v1\r\n\r\n",
  );
  for (let attempt = 0; attempt < 100 && !received.includes("\r\n\r\n"); attempt += 1)
    await Bun.sleep(2);
  const end = received.indexOf("\r\n\r\n") + 4;
  expect(received.subarray(0, end).toString()).toContain(
    `Sec-WebSocket-Accept: ${webSocketAccept("dGhlIHNhbXBsZSBub25jZQ==")}`,
  );
  received = received.subarray(end);
  return { socket, received: () => received };
}

describe("preview websocket", () => {
  test("echoes text and binary between client and server", async () => {
    const { port } = await echoServer();
    const ws = await client(port);
    const messages: Array<[string, boolean]> = [];
    ws.on("message", (data, binary) =>
      messages.push([binary ? data.toString("hex") : data.toString(), binary]),
    );
    ws.start();
    ws.send("hello");
    ws.send(Buffer.from([0xde, 0xad]));
    for (let attempt = 0; attempt < 100 && messages.length < 2; attempt += 1) await Bun.sleep(2);
    expect(messages).toEqual([
      ["hello", false],
      ["dead", true],
    ]);
  });

  test("reassembles fragmented messages and answers pings", async () => {
    const { port } = await echoServer();
    const raw = await rawClient(port);
    raw.socket.write(
      Buffer.concat([
        frame(0x1, Buffer.from("he"), { fin: false }),
        frame(0x9, Buffer.from("p")),
        frame(0x0, Buffer.from("llo")),
      ]),
    );
    for (let attempt = 0; attempt < 100 && raw.received().length < 10; attempt += 1)
      await Bun.sleep(2);
    const bytes = raw.received();
    // pong first (control frames may interleave), then the reassembled echo.
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0x8a, 0x01, 0x70]));
    expect(bytes.subarray(3)).toEqual(Buffer.from([0x81, 0x05, ...Buffer.from("hello")]));
    raw.socket.destroy();
  });

  test("unmasked client frames and oversize messages close the connection", async () => {
    const { port } = await echoServer(8);
    const unmasked = await rawClient(port);
    unmasked.socket.write(frame(0x1, Buffer.from("x"), { mask: false }));
    for (let attempt = 0; attempt < 100 && unmasked.received().length < 4; attempt += 1)
      await Bun.sleep(2);
    expect(unmasked.received().readUInt16BE(2)).toBe(1002);
    const big = await rawClient(port);
    big.socket.write(frame(0x2, Buffer.alloc(9)));
    for (let attempt = 0; attempt < 100 && big.received().length < 4; attempt += 1)
      await Bun.sleep(2);
    expect(big.received().readUInt16BE(2)).toBe(1009);
    unmasked.socket.destroy();
    big.socket.destroy();
  });

  test("64-bit payload lengths round-trip in both directions", async () => {
    const { port } = await echoServer(200_000);
    const payload = Buffer.alloc(70_000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;
    // Raw frame with the 127 length form decodes on the server; the echo is
    // encoded with the same form.
    const raw = await rawClient(port);
    raw.socket.write(frame(0x2, payload));
    for (
      let attempt = 0;
      attempt < 500 && raw.received().length < 10 + payload.length;
      attempt += 1
    )
      await Bun.sleep(2);
    const bytes = raw.received();
    expect(bytes[0]).toBe(0x82);
    expect(bytes[1]).toBe(127);
    expect(bytes.readBigUInt64BE(2)).toBe(BigInt(payload.length));
    expect(bytes.subarray(10).equals(payload)).toBe(true);
    raw.socket.destroy();
    // Endpoint to endpoint (client frames are masked).
    const ws = await client(port, 200_000);
    const echoed = new Promise<Buffer>((resolve) => ws.on("message", (data) => resolve(data)));
    ws.start();
    ws.send(payload);
    expect((await echoed).equals(payload)).toBe(true);
  });

  test("a close frame with a one-byte payload is a protocol error", async () => {
    const { port } = await echoServer();
    const raw = await rawClient(port);
    raw.socket.write(frame(0x8, Buffer.from([0x03])));
    for (let attempt = 0; attempt < 100 && raw.received().length < 4; attempt += 1)
      await Bun.sleep(2);
    const bytes = raw.received();
    expect(bytes[0]).toBe(0x88);
    expect(bytes.readUInt16BE(2)).toBe(1002);
    raw.socket.destroy();
  });

  test("close handshake reports the peer's code", async () => {
    const { port, accepted } = await echoServer();
    const ws = await client(port);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.start();
    for (let attempt = 0; attempt < 100 && !accepted.length; attempt += 1) await Bun.sleep(2);
    accepted[0]!.close(4410, "revoked");
    expect(await closed).toBe(4410);
  });

  test("handshake rejects a mismatched subprotocol or status", async () => {
    const server = createServer((_request, response) => response.end("nope"));
    server.on("upgrade", (_request, socket) =>
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"),
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const error = await client((server.address() as AddressInfo).port).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(PreviewWebSocketHandshakeError);
    expect((error as PreviewWebSocketHandshakeError).status).toBe(403);
  });
});

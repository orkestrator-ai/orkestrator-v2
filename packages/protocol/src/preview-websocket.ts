/**
 * Minimal RFC 6455 WebSocket endpoint over a raw duplex stream, for the
 * preview tunnel only.
 *
 * Bun substitutes its own implementation for the `ws` package, and that
 * implementation reports `bufferedAmount === 0` and completes send callbacks
 * while a peer has stopped reading — it buffers without bound. The tunnel's
 * whole resource contract depends on real backpressure, so both ends speak
 * WebSocket directly over `node:net`/`node:tls` sockets, whose `write()` return
 * value and `drain` event are real under both Bun and Node/Electron.
 *
 * Scope is deliberately narrow: no extensions (per-message deflate is never
 * negotiated), unfragmented control frames, fragmented data messages are
 * reassembled under the payload bound, and every oversize or malformed frame
 * closes the connection.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import { http1Request, headerValues } from "./preview-http1.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export function webSocketAccept(key: string): string {
  return createHash("sha1")
    .update(key + GUID)
    .digest("base64");
}

export interface PreviewWebSocketOptions {
  role: "server" | "client";
  maxPayload: number;
  /** Close handshake grace before the socket is destroyed. */
  closeTimeoutMs?: number;
}

export interface PreviewWebSocketEvents {
  message: [data: Buffer, isBinary: boolean];
  close: [code: number, reason: string];
  drain: [];
  pong: [];
}

/**
 * A connected WebSocket endpoint. `send` returns the underlying socket's
 * write result; callers apply backpressure on `false` and resume on `drain`.
 */
export class PreviewWebSocket extends EventEmitter<PreviewWebSocketEvents> {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private fragmentBytes = 0;
  private closing = false;
  private closed = false;
  private closeCode = 1006;
  private closeReason = "";
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly socket: Duplex,
    private readonly options: PreviewWebSocketOptions,
    initial?: Buffer,
  ) {
    super();
    if (initial?.length) this.buffer = Buffer.from(initial);
    socket.on("drain", () => this.emit("drain"));
    socket.on("error", () => undefined);
    socket.on("close", () => this.finish());
  }

  private started = false;

  /**
   * Begin reading. Call after attaching `message`/`close` handlers so bytes
   * that arrived with the handshake are delivered in order, not dropped.
   */
  start(): this {
    if (this.started) return this;
    this.started = true;
    this.socket.on("data", (chunk: Buffer) => this.onData(chunk));
    if (this.buffer.length) this.onData(Buffer.alloc(0));
    this.socket.resume();
    return this;
  }

  get isOpen(): boolean {
    return !this.closing && !this.closed;
  }

  /** Bytes accepted by the socket but not yet flushed to the kernel. */
  get bufferedBytes(): number {
    return this.socket.writableLength;
  }

  send(data: Buffer | string, binary = typeof data !== "string"): boolean {
    if (!this.isOpen) return false;
    const payload = typeof data === "string" ? Buffer.from(data) : data;
    return this.writeFrame(binary ? WS_OPCODE.binary : WS_OPCODE.text, payload);
  }

  ping(): void {
    if (this.isOpen) this.writeFrame(WS_OPCODE.ping, Buffer.alloc(0));
  }

  pause(): void {
    this.socket.pause();
  }

  resume(): void {
    this.socket.resume();
  }

  close(code = 1000, reason = ""): void {
    if (this.closing || this.closed) return;
    this.closing = true;
    this.closeCode = code;
    this.closeReason = reason;
    const reasonBytes = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.writeFrame(WS_OPCODE.close, payload);
    this.closeTimer = setTimeout(() => this.terminate(), this.options.closeTimeoutMs ?? 2_000);
    this.closeTimer.unref?.();
    // A server may end its side once the close frame is flushed.
    if (this.options.role === "server") this.socket.end();
  }

  terminate(): void {
    this.socket.destroy();
    this.finish();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.socket.destroy();
    this.emit("close", this.closeCode, this.closeReason);
  }

  private writeFrame(opcode: number, payload: Buffer): boolean {
    const length = payload.length;
    const mask = this.options.role === "client";
    const headerLength = 2 + (length < 126 ? 0 : length < 65_536 ? 2 : 8) + (mask ? 4 : 0);
    const frame = Buffer.alloc(headerLength + length);
    frame[0] = 0x80 | opcode;
    let offset = 2;
    if (length < 126) frame[1] = length;
    else if (length < 65_536) {
      frame[1] = 126;
      frame.writeUInt16BE(length, 2);
      offset = 4;
    } else {
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(length), 2);
      offset = 10;
    }
    if (mask) {
      frame[1]! |= 0x80;
      const key = randomBytes(4);
      key.copy(frame, offset);
      offset += 4;
      for (let index = 0; index < length; index += 1)
        frame[offset + index] = payload[index]! ^ key[index % 4]!;
    } else {
      payload.copy(frame, offset);
    }
    if (this.socket.destroyed) return false;
    return this.socket.write(frame);
  }

  private fail(code: number, reason: string): void {
    this.buffer = Buffer.alloc(0);
    if (this.isOpen) this.close(code, reason);
    else this.terminate();
  }

  private onData(chunk: Buffer): void {
    if (this.closed) return;
    if (chunk.length)
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (rsv) return this.fail(1002, "reserved bits");
      if (masked !== (this.options.role === "server")) return this.fail(1002, "masking");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(this.options.maxPayload)) return this.fail(1009, "message too big");
        length = Number(big);
        offset = 10;
      }
      const control = opcode >= 0x8;
      if (control && (!fin || length > 125)) return this.fail(1002, "control frame");
      if (!control && length > this.options.maxPayload) return this.fail(1009, "message too big");
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) {
        for (let index = 0; index < payload.length; index += 1)
          payload[index]! ^= this.buffer[maskOffset + (index % 4)]!;
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.onFrame(fin, opcode, payload);
    }
  }

  private onFrame(fin: boolean, opcode: number, payload: Buffer): void {
    switch (opcode) {
      case WS_OPCODE.ping:
        if (this.isOpen) this.writeFrame(WS_OPCODE.pong, payload);
        return;
      case WS_OPCODE.pong:
        this.emit("pong");
        return;
      case WS_OPCODE.close: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
        if (!this.closing) {
          this.closeCode = code;
          this.closeReason = reason;
          this.closing = true;
          const echo = payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0);
          this.writeFrame(WS_OPCODE.close, echo);
          this.socket.end();
        }
        this.closeTimer ??= setTimeout(
          () => this.terminate(),
          this.options.closeTimeoutMs ?? 2_000,
        );
        this.closeTimer.unref?.();
        return;
      }
      case WS_OPCODE.text:
      case WS_OPCODE.binary:
        if (this.fragments.length) return this.fail(1002, "interleaved message");
        if (fin) {
          if (this.isOpen) this.emit("message", payload, opcode === WS_OPCODE.binary);
          return;
        }
        this.fragmentOpcode = opcode;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      case WS_OPCODE.continuation: {
        if (!this.fragments.length) return this.fail(1002, "unexpected continuation");
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.options.maxPayload) return this.fail(1009, "message too big");
        this.fragments.push(payload);
        if (!fin) return;
        const data = Buffer.concat(this.fragments);
        this.fragments = [];
        this.fragmentBytes = 0;
        if (this.isOpen) this.emit("message", data, this.fragmentOpcode === WS_OPCODE.binary);
        return;
      }
      default:
        this.fail(1002, "unknown opcode");
    }
  }
}

/**
 * Complete a server-side WebSocket handshake on an `upgrade` socket after the
 * caller has validated the request. Returns null (and answers 400) for an
 * invalid handshake. No extensions are ever negotiated.
 */
export function acceptPreviewWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { protocol: string; maxPayload: number },
): PreviewWebSocket | null {
  const key = request.headers["sec-websocket-key"];
  const version = request.headers["sec-websocket-version"];
  if (
    request.method !== "GET" ||
    String(request.headers.upgrade ?? "").toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key) ||
    version !== "13"
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
    return null;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${webSocketAccept(key)}`,
      `Sec-WebSocket-Protocol: ${options.protocol}`,
      "",
      "",
    ].join("\r\n"),
  );
  return new PreviewWebSocket(socket, { role: "server", maxPayload: options.maxPayload }, head);
}

export interface PreviewWebSocketClientOptions {
  url: string;
  protocol: string;
  maxPayload: number;
  connectTimeoutMs: number;
  handshakeTimeoutMs: number;
  headers?: Array<[string, string]>;
  /** Extra CA (PEM) for `wss:` to a gateway with a private certificate. */
  ca?: string;
  signal?: AbortSignal;
}

export class PreviewWebSocketHandshakeError extends Error {
  constructor(
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PreviewWebSocketHandshakeError";
  }
}

/** Open a client WebSocket over `node:net`/`node:tls` with real backpressure. */
export async function connectPreviewWebSocket(
  options: PreviewWebSocketClientOptions,
): Promise<PreviewWebSocket> {
  const url = new URL(options.url);
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  if (!secure && url.protocol !== "ws:" && url.protocol !== "http:") {
    throw new PreviewWebSocketHandshakeError(null, "Unsupported WebSocket URL");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || (secure ? 443 : 80));
  const socket: Duplex = await new Promise((resolve, reject) => {
    const connection = secure
      ? tlsConnect({
          host,
          port,
          servername: /^[\d.:]+$/.test(host) ? undefined : host,
          ca: options.ca,
          ALPNProtocols: ["http/1.1"],
        })
      : netConnect({ host, port });
    const ready = secure ? "secureConnect" : "connect";
    const timer = setTimeout(() => {
      connection.destroy();
      reject(new PreviewWebSocketHandshakeError(null, "Connection timed out"));
    }, options.connectTimeoutMs);
    const abort = () => {
      clearTimeout(timer);
      connection.destroy();
      reject(new PreviewWebSocketHandshakeError(null, "Aborted"));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    connection.once(ready, () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve(connection);
    });
    connection.once("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
  });
  socket.on("error", () => undefined);
  const key = randomBytes(16).toString("base64");
  const response = await http1Request(socket, {
    method: "GET",
    path: `${url.pathname}${url.search}`,
    headers: [
      ["host", url.host],
      ["upgrade", "websocket"],
      ["connection", "Upgrade"],
      ["sec-websocket-key", key],
      ["sec-websocket-version", "13"],
      ["sec-websocket-protocol", options.protocol],
      ...(options.headers ?? []),
    ],
    headersTimeoutMs: options.handshakeTimeoutMs,
    maxHeaderBytes: 16 * 1024,
    maxHeaderFields: 64,
    upgrade: true,
    signal: options.signal,
  }).catch((error: unknown) => {
    socket.destroy();
    throw error;
  });
  if (response.statusCode !== 101) {
    response.body.destroy();
    socket.destroy();
    throw new PreviewWebSocketHandshakeError(
      response.statusCode,
      `Handshake rejected with HTTP ${response.statusCode}`,
    );
  }
  const accept = headerValues(response.headers, "sec-websocket-accept")[0];
  const protocol = headerValues(response.headers, "sec-websocket-protocol")[0];
  if (accept !== webSocketAccept(key) || protocol !== options.protocol) {
    socket.destroy();
    throw new PreviewWebSocketHandshakeError(101, "Invalid handshake response");
  }
  return new PreviewWebSocket(
    socket,
    { role: "client", maxPayload: options.maxPayload },
    response.upgradeHead,
  );
}

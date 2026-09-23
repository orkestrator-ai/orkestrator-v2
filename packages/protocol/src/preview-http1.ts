/**
 * Minimal, strict HTTP/1.1 client over an already-connected duplex stream.
 *
 * Preview transports need to speak HTTP over sockets they established
 * themselves — a verified TLS socket, a relay channel, or a desktop tunnel
 * stream. Bun's `node:http` client does not honour `createConnection`, so this
 * module owns the exchange: it serializes one request, streams its body with
 * backpressure, parses exactly one response head under explicit bounds, and
 * exposes the decoded body as a backpressured stream. Connections are not
 * reused (`Connection: close`), which keeps framing errors from leaking into a
 * following request. Node-only; never imported by the browser renderer.
 */
import { Readable, type Duplex } from "node:stream";

export type PreviewHttp1ErrorCode =
  | "headers-timeout"
  | "malformed-response"
  | "header-too-large"
  | "connection-closed"
  | "aborted"
  | "invalid-request";

export class PreviewHttp1Error extends Error {
  constructor(
    readonly code: PreviewHttp1ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewHttp1Error";
  }
}

export type HeaderList = Array<[string, string]>;

export interface Http1RequestOptions {
  method: string;
  path: string;
  /** Must include `host`. Framing and `connection` headers are set here. */
  headers: HeaderList;
  body?: Readable | null;
  /** Known length; `null` with a body means chunked. */
  bodyLength?: number | null;
  headersTimeoutMs: number;
  maxHeaderBytes: number;
  maxHeaderFields: number;
  signal?: AbortSignal;
  /** Keep the connection for a protocol upgrade instead of closing after the response. */
  upgrade?: boolean;
}

export interface Http1Response {
  statusCode: number;
  statusMessage: string;
  headers: HeaderList;
  /** Decoded (de-chunked) body. Destroying it closes the upstream connection. */
  body: Readable;
  /** Present for `101 Switching Protocols`: bytes already read past the head. */
  upgradeHead?: Buffer;
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// oxlint-disable-next-line no-control-regex
const INVALID_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const FRAMING_HEADERS = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

export function isValidHeaderName(name: string): boolean {
  return TOKEN.test(name);
}

export function isValidHeaderValue(value: string): boolean {
  return !INVALID_VALUE.test(value);
}

/** Serialize a request head. Throws on header injection attempts. */
export function serializeRequestHead(
  method: string,
  path: string,
  headers: HeaderList,
  framing: { length: number | null; chunked: boolean },
  connection: "close" | "upgrade",
): Buffer {
  if (!TOKEN.test(method)) throw new PreviewHttp1Error("invalid-request", "Invalid method");
  if (!path.startsWith("/") || /[\s\u0000-\u001f\u007f]/.test(path)) {
    throw new PreviewHttp1Error("invalid-request", "Invalid request target");
  }
  const lines = [`${method} ${path} HTTP/1.1`];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (connection === "close" && FRAMING_HEADERS.has(lower)) continue;
    if (connection === "upgrade" && (lower === "content-length" || lower === "transfer-encoding"))
      continue;
    if (!isValidHeaderName(name) || !isValidHeaderValue(value)) {
      throw new PreviewHttp1Error("invalid-request", "Invalid header");
    }
    lines.push(`${name}: ${value}`);
  }
  if (connection === "close") {
    if (framing.chunked) lines.push("transfer-encoding: chunked");
    else if (framing.length !== null) lines.push(`content-length: ${framing.length}`);
    lines.push("connection: close");
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
}

interface ParsedHead {
  statusCode: number;
  statusMessage: string;
  headers: HeaderList;
}

export function parseResponseHead(text: string, maxHeaderFields: number): ParsedHead {
  const lines = text.split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
  if (!status) throw new PreviewHttp1Error("malformed-response", "Invalid status line");
  const headers: HeaderList = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      throw new PreviewHttp1Error("malformed-response", "Obsolete header folding");
    }
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon) : "";
    if (!TOKEN.test(name)) throw new PreviewHttp1Error("malformed-response", "Invalid header name");
    const value = line.slice(colon + 1).trim();
    if (!isValidHeaderValue(value))
      throw new PreviewHttp1Error("malformed-response", "Invalid header value");
    headers.push([name, value]);
    if (headers.length > maxHeaderFields)
      throw new PreviewHttp1Error("header-too-large", "Too many response headers");
  }
  return { statusCode: Number(status[1]), statusMessage: status[2] ?? "", headers };
}

export function headerValues(headers: HeaderList, name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter(([key]) => key.toLowerCase() === lower).map(([, value]) => value);
}

type Framing =
  | { kind: "none" }
  | { kind: "length"; remaining: number }
  | { kind: "chunked" }
  | { kind: "close" };

function responseFraming(method: string, head: ParsedHead): Framing {
  if (
    method === "HEAD" ||
    head.statusCode === 204 ||
    head.statusCode === 304 ||
    head.statusCode < 200
  ) {
    return { kind: "none" };
  }
  const encodings = headerValues(head.headers, "transfer-encoding")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const lengths = headerValues(head.headers, "content-length")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  if (encodings.length) {
    // Both framings at once is a request-smuggling shape; refuse it.
    if (lengths.length)
      throw new PreviewHttp1Error("malformed-response", "Ambiguous response framing");
    if (encodings.at(-1) !== "chunked") return { kind: "close" };
    return { kind: "chunked" };
  }
  if (lengths.length) {
    if (!lengths.every((value) => /^\d{1,15}$/.test(value) && value === lengths[0])) {
      throw new PreviewHttp1Error("malformed-response", "Invalid content-length");
    }
    return { kind: "length", remaining: Number(lengths[0]) };
  }
  return { kind: "close" };
}

/**
 * Incremental chunked-transfer decoder. Trailers are read and discarded
 * (documented: preview transports do not forward trailers).
 */
class ChunkedDecoder {
  private state: "size" | "data" | "data-crlf" | "trailer" | "done" = "size";
  private line = "";
  private remaining = 0;

  constructor(private readonly maxLineBytes = 4_096) {}

  get done(): boolean {
    return this.state === "done";
  }

  /** Returns decoded payload slices; leftover bytes after the terminal chunk are an error. */
  write(chunk: Buffer, emit: (data: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      switch (this.state) {
        case "size":
        case "trailer": {
          const newline = chunk.indexOf(0x0a, offset);
          const end = newline < 0 ? chunk.length : newline + 1;
          this.line += chunk.toString("latin1", offset, end);
          offset = end;
          if (this.line.length > this.maxLineBytes)
            throw new PreviewHttp1Error("malformed-response", "Chunk line too long");
          if (newline < 0) break;
          const line = this.line.replace(/\r?\n$/, "");
          this.line = "";
          if (this.state === "trailer") {
            if (line === "") this.state = "done";
            break;
          }
          const size = /^([0-9a-fA-F]{1,12})(?:;.*)?$/.exec(line);
          if (!size) throw new PreviewHttp1Error("malformed-response", "Invalid chunk size");
          this.remaining = Number.parseInt(size[1]!, 16);
          this.state = this.remaining === 0 ? "trailer" : "data";
          break;
        }
        case "data": {
          const take = Math.min(this.remaining, chunk.length - offset);
          emit(chunk.subarray(offset, offset + take));
          this.remaining -= take;
          offset += take;
          if (this.remaining === 0) this.state = "data-crlf";
          break;
        }
        case "data-crlf": {
          const byte = chunk[offset]!;
          offset += 1;
          if (byte === 0x0a) this.state = "size";
          else if (byte !== 0x0d)
            throw new PreviewHttp1Error("malformed-response", "Missing chunk terminator");
          break;
        }
        case "done":
          throw new PreviewHttp1Error("malformed-response", "Data after final chunk");
      }
    }
  }
}

/** Encode one chunk for a chunked request body. */
export function encodeChunk(data: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`${data.length.toString(16)}\r\n`, "latin1"),
    data,
    Buffer.from("\r\n"),
  ]);
}

const LAST_CHUNK = Buffer.from("0\r\n\r\n");

/**
 * Stream a request body into the socket with backpressure. Resolves when the
 * body is fully written; rejects if the body errors.
 */
function writeBody(socket: Duplex, body: Readable, chunked: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const onData = (data: Buffer | string) => {
      const buffer = typeof data === "string" ? Buffer.from(data) : data;
      if (buffer.length === 0) return;
      const ok = socket.write(chunked ? encodeChunk(buffer) : buffer);
      if (!ok) {
        body.pause();
        socket.once("drain", () => body.resume());
      }
    };
    const cleanup = () => {
      body.off("data", onData);
      body.off("end", onEnd);
      body.off("error", onError);
      socket.off("close", onClose);
    };
    const onEnd = () => {
      cleanup();
      if (chunked && !socket.destroyed) socket.write(LAST_CHUNK);
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      body.resume();
      resolve();
    };
    body.on("data", onData);
    body.once("end", onEnd);
    body.once("error", onError);
    socket.once("close", onClose);
  });
}

/**
 * Perform one HTTP/1.1 exchange. The caller owns the socket's lifetime until
 * this resolves; afterwards the returned body (or, for an upgrade, the caller)
 * owns it.
 */
export function http1Request(socket: Duplex, options: Http1RequestOptions): Promise<Http1Response> {
  return new Promise((resolve, reject) => {
    const method = options.method.toUpperCase();
    let settled = false;
    let head: Buffer = Buffer.alloc(0);
    const cleanupHead = () => {
      clearTimeout(timer);
      socket.off("data", onHeadData);
      socket.off("end", onHeadEnd);
      socket.off("close", onHeadEnd);
      socket.off("error", onHeadError);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanupHead();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(new PreviewHttp1Error("aborted", "Request aborted"));
    const onHeadEnd = () =>
      fail(new PreviewHttp1Error("connection-closed", "Upstream closed before responding"));
    const onHeadError = (error: Error) => fail(error);
    const timer = setTimeout(
      () => fail(new PreviewHttp1Error("headers-timeout", "Upstream response headers timed out")),
      options.headersTimeoutMs,
    );

    const onHeadData = (chunk: Buffer) => {
      head = head.length ? Buffer.concat([head, chunk]) : chunk;
      for (;;) {
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) {
          if (head.length > options.maxHeaderBytes) {
            fail(new PreviewHttp1Error("header-too-large", "Response headers too large"));
          }
          return;
        }
        if (end > options.maxHeaderBytes) {
          fail(new PreviewHttp1Error("header-too-large", "Response headers too large"));
          return;
        }
        let parsed: ParsedHead;
        try {
          parsed = parseResponseHead(head.toString("latin1", 0, end), options.maxHeaderFields);
        } catch (error) {
          fail(error as Error);
          return;
        }
        const rest = head.subarray(end + 4);
        // Skip interim responses (100 Continue, 103 Early Hints).
        if (parsed.statusCode >= 100 && parsed.statusCode < 200 && parsed.statusCode !== 101) {
          head = rest;
          continue;
        }
        settled = true;
        cleanupHead();
        if (parsed.statusCode === 101) {
          if (!options.upgrade) {
            socket.destroy();
            reject(new PreviewHttp1Error("malformed-response", "Unexpected protocol switch"));
            return;
          }
          socket.pause();
          resolve({ ...parsed, body: Readable.from([]), upgradeHead: Buffer.from(rest) });
          return;
        }
        try {
          resolve({ ...parsed, body: bodyStream(socket, responseFraming(method, parsed), rest) });
        } catch (error) {
          socket.destroy();
          reject(error);
        }
        return;
      }
    };

    if (options.signal?.aborted) {
      fail(new PreviewHttp1Error("aborted", "Request aborted"));
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onHeadData);
    socket.once("end", onHeadEnd);
    socket.once("close", onHeadEnd);
    socket.once("error", onHeadError);

    const hasBody = Boolean(options.body);
    const length = hasBody
      ? (options.bodyLength ?? null)
      : method === "POST" || method === "PUT" || method === "PATCH"
        ? 0
        : null;
    let requestHead: Buffer;
    try {
      requestHead = serializeRequestHead(
        method,
        options.path,
        options.headers,
        { length, chunked: hasBody && length === null },
        options.upgrade ? "upgrade" : "close",
      );
    } catch (error) {
      fail(error as Error);
      return;
    }
    socket.write(requestHead);
    if (options.body) {
      writeBody(socket, options.body, length === null).catch((error: Error) => fail(error));
    }
  });
}

function bodyStream(socket: Duplex, framing: Framing, initial: Buffer): Readable {
  const decoder = framing.kind === "chunked" ? new ChunkedDecoder() : null;
  let remaining = framing.kind === "length" ? framing.remaining : Number.POSITIVE_INFINITY;
  let finished = false;
  const body = new Readable({
    read() {
      if (!finished) socket.resume();
    },
    destroy(error, callback) {
      detach();
      if (!finished) socket.destroy();
      callback(error);
    },
  });
  const finish = () => {
    if (finished) return;
    finished = true;
    detach();
    body.push(null);
    // Connection: close — nothing else may be read from this connection.
    socket.destroy();
  };
  const push = (data: Buffer) => {
    if (data.length && !body.push(Buffer.from(data))) socket.pause();
  };
  const consume = (chunk: Buffer) => {
    if (finished) return;
    try {
      if (decoder) {
        decoder.write(chunk, push);
        if (decoder.done) finish();
      } else if (framing.kind === "length") {
        const take = Math.min(remaining, chunk.length);
        push(chunk.subarray(0, take));
        remaining -= take;
        if (remaining === 0) finish();
      } else {
        push(chunk);
      }
    } catch (error) {
      finished = true;
      detach();
      socket.destroy();
      body.destroy(error as Error);
    }
  };
  const onEnd = () => {
    if (finished) return;
    if (framing.kind === "close") finish();
    else {
      finished = true;
      detach();
      body.destroy(new PreviewHttp1Error("connection-closed", "Upstream closed mid-body"));
    }
  };
  const onError = (error: Error) => {
    if (finished) return;
    finished = true;
    detach();
    body.destroy(error);
  };
  const detach = () => {
    socket.off("data", consume);
    socket.off("end", onEnd);
    socket.off("close", onEnd);
    socket.off("error", onError);
  };
  if (framing.kind === "none" || (framing.kind === "length" && remaining === 0)) {
    finished = true;
    body.push(null);
    socket.destroy();
    return body;
  }
  socket.on("data", consume);
  socket.once("end", onEnd);
  socket.once("close", onEnd);
  socket.on("error", onError);
  if (initial.length) consume(initial);
  socket.resume();
  return body;
}

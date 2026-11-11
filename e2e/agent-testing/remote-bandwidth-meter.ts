/**
 * One browser client's network to an isolated profile's gateway, for the
 * remote bandwidth matrix (docs/development/remote-bandwidth.md): a loopback
 * TCP relay that counts the exact wire bytes each request class carries and
 * can shape the link to a slower rate and a fixed one-way latency.
 *
 * Bytes are counted at the TCP level when the relay hands them to the
 * receiving socket, so they are what crossed the wire after content coding
 * and WebSocket framing, HTTP headers included. Each connection's client
 * bytes are parsed incrementally as HTTP/1.1 (`RequestStream`): a request
 * head is held until it is complete, however TCP splits it, then classified
 * and forwarded; its body is forwarded as it arrives, framed by its
 * `Content-Length` or chunked coding, so a body never starts a request. The
 * gateway's bytes are attributed to the request the connection is serving:
 * Chromium does not pipeline HTTP/1.1, so a response arrives before the next
 * request's head. A WebSocket upgrade or an event stream keeps its connection
 * for life.
 *
 * Shaping is one queue per direction shared by every connection of the
 * client, as one access link is: each chunk waits `latencyMs`, then leaves at
 * `kbps` (kbit/s of 1,000 bits, as `remote-bandwidth-throttle.ts` uses). Both
 * directions are shaped, as a real access link is, where the in-process
 * baseline shapes only the downstream rate. A peer's end of stream waits
 * behind that connection's queued bytes, so a finite response is delivered
 * whole before the relay closes the client's side. The queue honours each
 * destination socket's backpressure: a destination whose `write` returned
 * false gets nothing more until it drains, and its buffered bytes count
 * against the bound. Past `MAX_QUEUED_BYTES` the relay stops reading the
 * sending sockets, so a slow link or a client that stops reading
 * backpressures the gateway instead of buffering without limit.
 *
 * Invokes are also attributed to their command name, read from the request
 * body's `command` field: a backend command name, never its arguments.
 *
 * Nothing here keeps a URL, header or payload: only sizes, counts, times and
 * command names.
 */
import net, { type AddressInfo, type Socket } from "node:net";

export type LinkCategory = "events" | "invoke" | "websocket" | "other";

export interface LinkTotals {
  /** Bytes delivered to the client, per class. */
  down: Record<LinkCategory, number>;
  /** Bytes delivered to the gateway, per class. */
  up: Record<LinkCategory, number>;
  /** Requests started, per class (an upgrade or stream counts once). */
  requests: Record<LinkCategory, number>;
  /** Connections accepted from the client. */
  connections: number;
  /** `Date.now()` of the last stream byte (SSE or WebSocket) delivered, 0 before any. */
  lastStreamDelivery: number;
  /** Invokes per command name: requests and bytes delivered to the client. */
  commands: Record<string, { requests: number; down: number }>;
  /** The most bytes queued behind the shaped link at once since the last `resetPeak`. */
  peakQueuedBytes: number;
  /** Queued bytes never delivered because their connection was reset or closed first. */
  droppedBytes: number;
}

export interface LinkShape {
  /** Link rate in kbit/s (1,000 bits); absent or 0 means unshaped. */
  kbps?: number;
  /** One-way delay added to every chunk, in each direction. */
  latencyMs?: number;
}

export interface CountingLink {
  readonly url: string;
  snapshot(): LinkTotals;
  shape(next: LinkShape): void;
  /** Starts a new queue-peak window, so each cell reports its own peak. */
  resetPeak(): void;
  close(): Promise<void>;
}

/** Bytes queued per direction before the relay stops reading the sender. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const RESUME_QUEUED_BYTES = MAX_QUEUED_BYTES / 2;
/** Cap on a held request head, so a client that never ends one cannot grow it. */
export const MAX_REQUEST_HEAD_BYTES = 16 * 1024;
/** Cap on the invoke body read for its command name, and on a chunk-size line. */
const MAX_COMMAND_PEEK_BYTES = 8 * 1024;
const MAX_CHUNK_LINE_BYTES = 1024;
const REQUEST_LINE = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) (\S+) HTTP\/1\.[01]$/;
const HEAD_END = Buffer.from("\r\n\r\n");
const CRLF = Buffer.from("\r\n");

const API_PREFIX = "/__orkestrator/";
/** Distinct command names kept; any later one is counted as `(other)`. */
const MAX_COMMAND_NAMES = 256;
const COMMAND_FIELD = /"command"\s*:\s*"([A-Za-z0-9_.:-]{1,96})"/;

/** The command an invoke body names, if it holds the `command` field. */
export function commandOf(body: Buffer): string | undefined {
  return COMMAND_FIELD.exec(body.subarray(0, MAX_COMMAND_PEEK_BYTES).toString("latin1"))?.[1];
}

export function categorize(target: string, upgrade = false): LinkCategory {
  const pathname = target.split("?", 1)[0] ?? "";
  if (upgrade && pathname.startsWith(API_PREFIX)) return "websocket";
  if (pathname === `${API_PREFIX}events`) return "events";
  if (pathname === `${API_PREFIX}invoke`) return "invoke";
  return "other";
}

/** A link rate in bytes per millisecond: kbit/s of 1,000 bits. */
export function bytesPerMs(kbps: number | undefined): number {
  return kbps && kbps > 0 ? kbps / 8 : 0;
}

function emptyRecord(): Record<LinkCategory, number> {
  return { events: 0, invoke: 0, websocket: 0, other: 0 };
}

/** Bytes of the client's stream, and the class of the request they belong to. */
export interface Segment {
  bytes: Buffer;
  category: LinkCategory;
}

type ParseState =
  | "head"
  | "body"
  | "chunk-size"
  | "chunk-data"
  | "chunk-data-end"
  | "trailer"
  /** An upgrade or event stream: the connection stays with its request. */
  | "dedicated"
  /** Not HTTP the parser understands: the rest stays with the current class. */
  | "opaque";

/**
 * The client side of one connection, parsed incrementally as HTTP/1.1
 * requests. `feed` returns the bytes ready to forward, each with the class of
 * the request it belongs to: a request head is held until it is complete (or
 * `MAX_REQUEST_HEAD_BYTES`), body bytes are released at once.
 */
export class RequestStream {
  /** The class of the request this connection is serving. */
  category: LinkCategory = "other";
  /** The invoke being served, once its body named its command. */
  command: string | undefined;
  private state: ParseState = "head";
  private held: Buffer = Buffer.alloc(0);
  private remaining = 0;
  private peek = "";
  private peeking = false;

  constructor(
    private readonly hooks: {
      onRequest?: (category: LinkCategory) => void;
      onCommand?: (name: string) => void;
    } = {},
  ) {}

  feed(chunk: Buffer): Segment[] {
    const segments: Segment[] = [];
    const emit = (bytes: Buffer) => {
      if (bytes.byteLength === 0) return;
      const last = segments[segments.length - 1];
      if (last && last.category === this.category) last.bytes = Buffer.concat([last.bytes, bytes]);
      else segments.push({ bytes, category: this.category });
    };
    let rest = chunk;
    while (rest.byteLength > 0) {
      switch (this.state) {
        case "dedicated":
        case "opaque":
          emit(rest);
          rest = Buffer.alloc(0);
          break;
        case "head": {
          const buffered = this.held.byteLength ? Buffer.concat([this.held, rest]) : rest;
          const end = buffered.indexOf(HEAD_END);
          if (end < 0) {
            if (buffered.byteLength > MAX_REQUEST_HEAD_BYTES) {
              this.startRequest(buffered.toString("latin1"), true);
              this.held = Buffer.alloc(0);
              emit(buffered);
            } else this.held = Buffer.from(buffered);
            rest = Buffer.alloc(0);
            break;
          }
          const head = buffered.subarray(0, end + HEAD_END.byteLength);
          rest = buffered.subarray(end + HEAD_END.byteLength);
          this.held = Buffer.alloc(0);
          this.startRequest(head.toString("latin1"), false);
          emit(head);
          break;
        }
        case "body": {
          const taken = rest.subarray(0, this.remaining);
          rest = rest.subarray(taken.byteLength);
          this.remaining -= taken.byteLength;
          this.peekBody(taken);
          emit(taken);
          if (this.remaining === 0) this.state = "head";
          break;
        }
        case "chunk-size":
        case "trailer": {
          const buffered = this.held.byteLength ? Buffer.concat([this.held, rest]) : rest;
          const end = buffered.indexOf(CRLF);
          if (end < 0) {
            if (buffered.byteLength > MAX_CHUNK_LINE_BYTES) {
              this.state = "opaque";
              this.held = Buffer.alloc(0);
              emit(buffered);
            } else this.held = Buffer.from(buffered);
            rest = Buffer.alloc(0);
            break;
          }
          const line = buffered.subarray(0, end + CRLF.byteLength);
          rest = buffered.subarray(end + CRLF.byteLength);
          this.held = Buffer.alloc(0);
          emit(line);
          if (this.state === "trailer") {
            // An empty line ends the trailer, and the request.
            if (end === 0) this.state = "head";
            break;
          }
          const size = Number.parseInt(line.toString("latin1").split(";", 1)[0]!.trim(), 16);
          if (!Number.isFinite(size) || size < 0) this.state = "opaque";
          else if (size === 0) this.state = "trailer";
          else {
            this.remaining = size;
            this.state = "chunk-data";
          }
          break;
        }
        case "chunk-data": {
          const taken = rest.subarray(0, this.remaining);
          rest = rest.subarray(taken.byteLength);
          this.remaining -= taken.byteLength;
          this.peekBody(taken);
          emit(taken);
          if (this.remaining === 0) {
            this.remaining = CRLF.byteLength;
            this.state = "chunk-data-end";
          }
          break;
        }
        case "chunk-data-end": {
          const taken = rest.subarray(0, this.remaining);
          rest = rest.subarray(taken.byteLength);
          this.remaining -= taken.byteLength;
          emit(taken);
          if (this.remaining === 0) this.state = "chunk-size";
          break;
        }
      }
    }
    return segments;
  }

  /** Releases a held partial head or line, when the client ends its side. */
  flush(): Segment[] {
    if (this.held.byteLength === 0) return [];
    const bytes = this.held;
    this.held = Buffer.alloc(0);
    return [{ bytes, category: this.category }];
  }

  private startRequest(head: string, truncated: boolean): void {
    const lines = head.split("\r\n");
    const match = REQUEST_LINE.exec(lines[0] ?? "");
    if (!match) {
      this.state = "opaque";
      return;
    }
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
    }
    const upgrade = /(^|,)\s*websocket\s*(,|$)/i.test(headers.get("upgrade") ?? "");
    this.category = categorize(match[2]!, upgrade);
    this.command = undefined;
    this.peek = "";
    this.peeking = this.category === "invoke";
    this.hooks.onRequest?.(this.category);
    const chunked = /(^|,)\s*chunked\s*$/i.test(headers.get("transfer-encoding") ?? "");
    const length = Number(headers.get("content-length") ?? "0");
    if (truncated) this.state = "opaque";
    else if (upgrade || this.category === "events" || this.category === "websocket") {
      this.state = "dedicated";
    } else if (chunked) this.state = "chunk-size";
    else if (Number.isSafeInteger(length) && length > 0) {
      this.remaining = length;
      this.state = "body";
    } else if (Number.isSafeInteger(length) && length >= 0) this.state = "head";
    else this.state = "opaque";
  }

  private peekBody(bytes: Buffer): void {
    if (!this.peeking || bytes.byteLength === 0) return;
    const room = MAX_COMMAND_PEEK_BYTES - this.peek.length;
    this.peek += bytes.subarray(0, Math.max(0, room)).toString("latin1");
    const named = COMMAND_FIELD.exec(this.peek)?.[1];
    if (named) {
      this.command = named;
      this.peeking = false;
      this.peek = "";
      this.hooks.onCommand?.(named);
    } else if (this.peek.length >= MAX_COMMAND_PEEK_BYTES) {
      this.peeking = false;
      this.peek = "";
    }
  }
}

/** A queued chunk, or (`chunk` null) the end of stream for `to`. */
type Pending = {
  from: Socket | null;
  to: Socket;
  chunk: Buffer | null;
  readyAt: number;
  account?: () => void;
};

/**
 * One direction of the link: chunks wait for their latency, then leave at
 * the link rate in arrival order. Unshaped, a chunk is written at once. A
 * destination whose `write` returned false gets nothing more until `drain`;
 * the others carry on, each in its own order.
 */
export class ShapedPipe {
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private nextFree = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly paused = new Set<Socket>();
  private readonly blocked = new Set<Socket>();
  peakQueuedBytes = 0;
  /** Bytes dropped because their destination closed or was discarded first. */
  droppedBytes = 0;

  constructor(
    private shape: LinkShape,
    private readonly now: () => number = Date.now,
  ) {}

  reshape(next: LinkShape): void {
    this.shape = next;
    this.kick();
  }

  private get unshaped(): boolean {
    return !this.shape.kbps && !this.shape.latencyMs;
  }

  push(from: Socket, to: Socket, chunk: Buffer, account: () => void): void {
    if (this.unshaped && this.queue.length === 0 && !this.blocked.has(to)) {
      this.deliver({ from, to, chunk, readyAt: 0, account });
      return;
    }
    this.queue.push({
      from,
      to,
      chunk,
      readyAt: this.now() + (this.shape.latencyMs ?? 0),
      account,
    });
    this.queuedBytes += chunk.byteLength;
    this.notePeak();
    if (this.bytesQueued > MAX_QUEUED_BYTES && !this.paused.has(from)) {
      from.pause();
      this.paused.add(from);
    }
    this.pump();
  }

  /** Ends `to` once every chunk queued for it has been delivered. */
  end(to: Socket): void {
    if (this.unshaped && !this.queue.some((item) => item.to === to) && !this.blocked.has(to)) {
      if (!to.destroyed) to.end();
      return;
    }
    this.queue.push({
      from: null,
      to,
      chunk: null,
      readyAt: this.now() + (this.shape.latencyMs ?? 0),
    });
    this.pump();
  }

  /** Forgets `socket`: drops what is queued for it, and stops tracking it as a sender. */
  discard(socket: Socket): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index]!;
      if (item.to !== socket) continue;
      this.queue.splice(index, 1);
      const size = item.chunk?.byteLength ?? 0;
      this.queuedBytes -= size;
      this.droppedBytes += size;
    }
    this.paused.delete(socket);
    this.blocked.delete(socket);
    this.kick();
  }

  /** Bytes the link holds: its queue plus what blocked destinations still buffer. */
  get bytesQueued(): number {
    let buffered = 0;
    for (const socket of this.blocked) buffered += socket.writableLength ?? 0;
    return this.queuedBytes + buffered;
  }

  private notePeak(): void {
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.bytesQueued);
  }

  private deliver(item: Pending): void {
    if (item.chunk === null) {
      if (!item.to.destroyed) item.to.end();
      return;
    }
    if (item.to.destroyed || !item.to.writable) {
      this.droppedBytes += item.chunk.byteLength;
      return;
    }
    const flowing = item.to.write(item.chunk);
    item.account?.();
    if (!flowing && !this.blocked.has(item.to)) {
      this.blocked.add(item.to);
      this.notePeak();
      const to = item.to;
      to.once("drain", () => {
        if (!this.blocked.delete(to)) return;
        this.kick();
      });
    }
  }

  private kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pump();
  }

  private nextIndex(): number {
    if (this.blocked.size === 0) return this.queue.length > 0 ? 0 : -1;
    return this.queue.findIndex((item) => !this.blocked.has(item.to));
  }

  private pump(): void {
    if (this.timer) return;
    for (;;) {
      const index = this.nextIndex();
      if (index < 0) break;
      const head = this.queue[index]!;
      // A chunk arrives once it has been wholly transmitted: it starts when
      // its latency has passed and the link is free, and takes its size over
      // the rate.
      const rate = bytesPerMs(this.shape.kbps);
      const size = head.chunk?.byteLength ?? 0;
      const deliverAt = Math.max(head.readyAt, this.nextFree) + (rate ? size / rate : 0);
      const wait = deliverAt - this.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        break;
      }
      this.queue.splice(index, 1);
      this.queuedBytes -= size;
      this.nextFree = deliverAt;
      this.deliver(head);
    }
    if (this.bytesQueued <= RESUME_QUEUED_BYTES && this.paused.size > 0) {
      for (const socket of Array.from(this.paused)) {
        this.paused.delete(socket);
        if (!socket.destroyed) socket.resume();
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.paused.clear();
    this.blocked.clear();
  }
}

export async function startCountingLink(
  gatewayUrl: string,
  initial: LinkShape = {},
): Promise<CountingLink> {
  const gateway = new URL(gatewayUrl);
  const totals: Omit<LinkTotals, "peakQueuedBytes" | "droppedBytes"> = {
    down: emptyRecord(),
    up: emptyRecord(),
    requests: emptyRecord(),
    connections: 0,
    commands: {},
    lastStreamDelivery: 0,
  };
  const commandEntry = (name: string) => {
    const key =
      name in totals.commands || Object.keys(totals.commands).length < MAX_COMMAND_NAMES
        ? name
        : "(other)";
    return (totals.commands[key] ??= { requests: 0, down: 0 });
  };
  const downstream = new ShapedPipe(initial);
  const upstream = new ShapedPipe(initial);
  const sockets = new Set<Socket>();

  // Half-open, so one side's end of stream can wait behind its queued bytes.
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    totals.connections += 1;
    const stream = new RequestStream({
      onRequest: (category) => {
        totals.requests[category] += 1;
      },
      onCommand: (name) => {
        commandEntry(name).requests += 1;
      },
    });
    const gatewaySocket = net.connect({
      port: Number(gateway.port),
      host: gateway.hostname,
      allowHalfOpen: true,
    });
    const forwardUp = (segments: Segment[]) => {
      for (const segment of segments) {
        const size = segment.bytes.byteLength;
        upstream.push(client, gatewaySocket, segment.bytes, () => {
          totals.up[segment.category] += size;
        });
      }
    };
    client.on("data", (chunk: Buffer) => forwardUp(stream.feed(chunk)));
    gatewaySocket.on("data", (chunk: Buffer) => {
      const charged = stream.category;
      const chargedCommand = stream.command;
      downstream.push(gatewaySocket, client, chunk, () => {
        totals.down[charged] += chunk.byteLength;
        if (chargedCommand) commandEntry(chargedCommand).down += chunk.byteLength;
        if (charged === "events" || charged === "websocket") totals.lastStreamDelivery = Date.now();
      });
    });
    // An orderly end of stream follows that direction's queued bytes.
    client.once("end", () => {
      forwardUp(stream.flush());
      upstream.end(gatewaySocket);
    });
    gatewaySocket.once("end", () => downstream.end(client));
    for (const [socket, peer] of [
      [client, gatewaySocket],
      [gatewaySocket, client],
    ] as const) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.once("close", (hadError: boolean) => {
        sockets.delete(socket);
        upstream.discard(socket);
        downstream.discard(socket);
        // A reset, not an orderly close: nothing more can cross, so drop the peer too.
        if (hadError || !socket.readableEnded) {
          upstream.discard(peer);
          downstream.discard(peer);
          peer.destroy();
        }
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    snapshot: () => ({
      down: { ...totals.down },
      up: { ...totals.up },
      requests: { ...totals.requests },
      connections: totals.connections,
      commands: Object.fromEntries(
        Object.entries(totals.commands).map(([name, entry]) => [name, { ...entry }]),
      ),
      lastStreamDelivery: totals.lastStreamDelivery,
      peakQueuedBytes: Math.max(downstream.peakQueuedBytes, upstream.peakQueuedBytes),
      droppedBytes: downstream.droppedBytes + upstream.droppedBytes,
    }),
    shape(next) {
      downstream.reshape(next);
      upstream.reshape(next);
    },
    resetPeak() {
      downstream.peakQueuedBytes = downstream.bytesQueued;
      upstream.peakQueuedBytes = upstream.bytesQueued;
    },
    close: () =>
      new Promise<void>((resolve) => {
        downstream.stop();
        upstream.stop();
        for (const socket of Array.from(sockets)) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** What happened between two snapshots of one link. */
export function linkDelta(before: LinkTotals, after: LinkTotals) {
  const down = emptyRecord();
  const up = emptyRecord();
  const requests = emptyRecord();
  for (const key of Object.keys(down) as LinkCategory[]) {
    down[key] = after.down[key] - before.down[key];
    up[key] = after.up[key] - before.up[key];
    requests[key] = after.requests[key] - before.requests[key];
  }
  const commands: Record<string, { requests: number; down: number }> = {};
  for (const [name, entry] of Object.entries(after.commands)) {
    const prior = before.commands[name] ?? { requests: 0, down: 0 };
    const delta = { requests: entry.requests - prior.requests, down: entry.down - prior.down };
    if (delta.requests > 0 || delta.down > 0) commands[name] = delta;
  }
  return {
    down,
    downBytes: down.events + down.invoke + down.websocket + down.other,
    commands,
    up,
    upBytes: up.events + up.invoke + up.websocket + up.other,
    requests,
    connections: after.connections - before.connections,
  };
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** Numeric difference of two flat metric records (gateway `/metrics` sections). */
export function numericDelta(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const [key, value] of Object.entries(after ?? {})) {
    if (typeof value !== "number") continue;
    const prior = before?.[key];
    delta[key] = value - (typeof prior === "number" ? prior : 0);
  }
  return delta;
}

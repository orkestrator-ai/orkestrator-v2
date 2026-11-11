/**
 * One browser client's network to an isolated profile's gateway, for the
 * remote bandwidth matrix (docs/development/remote-bandwidth.md): a loopback
 * TCP relay that
 * counts the exact wire bytes each request class carries and can shape the
 * link to a slower rate and a fixed one-way latency.
 *
 * Bytes are counted at the TCP level when the relay hands them to the
 * receiving socket, so they are what crossed the wire after content coding
 * and WebSocket framing, HTTP headers included. Each connection's bytes are
 * attributed to the class of the request it is serving: Chromium does not
 * pipeline HTTP/1.1, so a new request line at the start of a client chunk
 * marks the start of the next exchange. A WebSocket upgrade or an event
 * stream keeps its connection for life.
 *
 * Shaping is one queue per direction shared by every connection of the
 * client, as one access link is: each chunk waits `latencyMs`, then leaves at
 * `kbps`. The queue is bounded by bytes: past `MAX_QUEUED_BYTES` the relay
 * stops reading the sending sockets, so a slow link backpressures the gateway
 * instead of buffering without limit.
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
}

export interface LinkShape {
  /** Link rate in kbit/s; absent or 0 means unshaped. */
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
/** Cap on the request-line peek, so a client that sends no newline cannot grow it. */
const MAX_REQUEST_LINE_BYTES = 8 * 1024;
const REQUEST_LINE = /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH) (\S+) HTTP\/1\.[01]\r\n/;

const API_PREFIX = "/__orkestrator/";
/** Distinct command names kept; any later one is counted as `(other)`. */
const MAX_COMMAND_NAMES = 256;
const COMMAND_FIELD = /"command"\s*:\s*"([A-Za-z0-9_.:-]{1,96})"/;

/** The command an invoke body chunk names, if it holds the `command` field. */
export function commandOf(chunk: Buffer): string | undefined {
  return COMMAND_FIELD.exec(chunk.subarray(0, MAX_REQUEST_LINE_BYTES).toString("latin1"))?.[1];
}

export function categorize(target: string, upgrade = false): LinkCategory {
  const pathname = target.split("?", 1)[0] ?? "";
  if (upgrade && pathname.startsWith(API_PREFIX)) return "websocket";
  if (pathname === `${API_PREFIX}events`) return "events";
  if (pathname === `${API_PREFIX}invoke`) return "invoke";
  return "other";
}

/** The request a client chunk starts, or null when it continues the current one. */
export function requestStart(chunk: Buffer): { category: LinkCategory } | null {
  const head = chunk.subarray(0, MAX_REQUEST_LINE_BYTES).toString("latin1");
  const match = REQUEST_LINE.exec(head);
  if (!match) return null;
  const upgrade = /\r\nupgrade:\s*websocket\r\n/i.test(head);
  return { category: categorize(match[2]!, upgrade) };
}

function emptyRecord(): Record<LinkCategory, number> {
  return { events: 0, invoke: 0, websocket: 0, other: 0 };
}

type Pending = { to: Socket; chunk: Buffer; readyAt: number; account: () => void };

/**
 * One direction of the link: chunks wait for their latency, then leave at
 * the link rate in arrival order. Unshaped, a chunk is written at once.
 */
export class ShapedPipe {
  private readonly queue: Pending[] = [];
  private queuedBytes = 0;
  private nextFree = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly paused = new Set<Socket>();
  peakQueuedBytes = 0;

  constructor(
    private shape: LinkShape,
    private readonly now: () => number = Date.now,
  ) {}

  reshape(next: LinkShape): void {
    this.shape = next;
    this.pump();
  }

  push(from: Socket, to: Socket, chunk: Buffer, account: () => void): void {
    if (!this.shape.kbps && !this.shape.latencyMs && this.queue.length === 0) {
      to.write(chunk);
      account();
      return;
    }
    this.queue.push({ to, chunk, readyAt: this.now() + (this.shape.latencyMs ?? 0), account });
    this.queuedBytes += chunk.byteLength;
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
    if (this.queuedBytes > MAX_QUEUED_BYTES && !this.paused.has(from)) {
      from.pause();
      this.paused.add(from);
    }
    this.pump();
  }

  get bytesQueued(): number {
    return this.queuedBytes;
  }

  private pump(): void {
    if (this.timer) return;
    for (;;) {
      const head = this.queue[0];
      if (!head) return;
      // A chunk arrives once it has been wholly transmitted: it starts when
      // its latency has passed and the link is free, and takes its size over
      // the rate.
      const bytesPerMs = this.shape.kbps ? (this.shape.kbps * 1024) / 8 / 1000 : 0;
      const deliverAt =
        Math.max(head.readyAt, this.nextFree) +
        (bytesPerMs ? head.chunk.byteLength / bytesPerMs : 0);
      const wait = deliverAt - this.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump();
        }, wait);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= head.chunk.byteLength;
      this.nextFree = deliverAt;
      if (!head.to.destroyed) {
        head.to.write(head.chunk);
        head.account();
      }
      if (this.queuedBytes <= RESUME_QUEUED_BYTES && this.paused.size > 0) {
        for (const socket of Array.from(this.paused)) {
          this.paused.delete(socket);
          if (!socket.destroyed) socket.resume();
        }
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.paused.clear();
  }
}

export async function startCountingLink(
  gatewayUrl: string,
  initial: LinkShape = {},
): Promise<CountingLink> {
  const gateway = new URL(gatewayUrl);
  const totals: LinkTotals = {
    down: emptyRecord(),
    up: emptyRecord(),
    requests: emptyRecord(),
    connections: 0,
    commands: {},
    lastStreamDelivery: 0,
    peakQueuedBytes: 0,
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

  const server = net.createServer((client) => {
    totals.connections += 1;
    let category: LinkCategory = "other";
    let dedicated = false;
    /** The invoke being served, once its body named its command. */
    let command: string | undefined;
    let awaitingCommand = false;
    const gatewaySocket = net.connect(Number(gateway.port), gateway.hostname);
    for (const socket of [client, gatewaySocket]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
    }
    client.on("data", (chunk: Buffer) => {
      if (!dedicated) {
        const start = requestStart(chunk);
        if (start) {
          category = start.category;
          totals.requests[category] += 1;
          dedicated = category === "events" || category === "websocket";
          command = undefined;
          awaitingCommand = category === "invoke";
        }
        if (awaitingCommand) {
          const named = commandOf(chunk);
          if (named) {
            command = named;
            awaitingCommand = false;
            commandEntry(named).requests += 1;
          }
        }
      }
      const charged = category;
      upstream.push(client, gatewaySocket, chunk, () => {
        totals.up[charged] += chunk.byteLength;
      });
    });
    gatewaySocket.on("data", (chunk: Buffer) => {
      const charged = category;
      const chargedCommand = command;
      downstream.push(gatewaySocket, client, chunk, () => {
        totals.down[charged] += chunk.byteLength;
        if (chargedCommand) commandEntry(chargedCommand).down += chunk.byteLength;
        if (charged === "events" || charged === "websocket") totals.lastStreamDelivery = Date.now();
      });
    });
    client.once("close", () => gatewaySocket.end());
    gatewaySocket.once("close", () => client.end());
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

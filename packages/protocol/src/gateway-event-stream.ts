/**
 * Client side of the gateway's authoritative event stream, shared by the
 * browser gateway and the Electron main-process client.
 *
 * The gateway (`apps/backend/src/gateway-events.ts`) revisions every
 * authoritative event and keeps a bounded replay ring. A client that echoes the
 * last `id` it saw gets the missed frames replayed on reconnect; one whose
 * cursor fell outside the ring gets `gateway.reconcile-required` instead. This
 * module owns the client half of that contract so every transport recovers the
 * same way:
 *
 * - SSE framing, with an explicit per-frame byte bound.
 * - Cursor tracking, including the `gateway.cursor` frames that advance a
 *   filtered subscription past events it never received.
 * - Deciding when consumers must refetch: once for the first fresh connection
 *   and again for every explicit reconciliation, but not for a replayed
 *   reconnect, which has already delivered everything that was missed.
 * - Keeping replay control frames and the synthesized connected event out of
 *   ordinary listeners, so a server frame can never impersonate the transport.
 */

/**
 * Synthesized by the client transport, never sent by the gateway. Consumers
 * listening for it must refetch authoritative state: it fires for a fresh
 * connection and whenever replay could not cover a disconnect.
 */
export const NATIVE_EVENT_STREAM_CONNECTED_EVENT = "native-event-stream-connected";
/** Desktop terminals recover output outside the authoritative replay ring on every open. */
export const TERMINAL_EVENT_STREAM_CONNECTED_EVENT = "terminal-event-stream-connected";
export const GATEWAY_CONNECTED_EVENT = "gateway.connected";
export const GATEWAY_RECONCILE_REQUIRED_EVENT = "gateway.reconcile-required";
export const GATEWAY_CURSOR_EVENT = "gateway.cursor";
/** Query parameter a fetch-based client uses to resume from its cursor. */
export const GATEWAY_EVENT_CURSOR_PARAM = "since";
/**
 * Query parameter asking for keepalives an `EventSource` can see. It never
 * surfaces the gateway's `: keepalive` comment, so it asks for this named event
 * instead. A named event skips `onmessage`, and a gateway that ignores the
 * parameter just never sends it, which tells the client not to expect any.
 */
export const GATEWAY_KEEPALIVE_EVENTS_PARAM = "keepaliveEvents";
export const GATEWAY_KEEPALIVE_EVENT = "gateway.keepalive";
/**
 * A link that drops with no answer (a tailnet peer that vanished) never errors
 * an open stream: the socket waits on TCP for many minutes. A stream the gateway
 * has said nothing on for two keepalives (`KEEPALIVE_MS`, 25 s) and some slack is
 * treated as lost, and a connection attempt that gets no answer is given up on
 * sooner, so a link that returns is found again promptly.
 */
export const GATEWAY_STREAM_SILENCE_LIMIT_MS = 60_000;
export const GATEWAY_STREAM_CONNECT_TIMEOUT_MS = 20_000;
/**
 * Matches the gateway's per-client hard buffer (`SSE_CLIENT_HARD_BUFFER_BYTES`)
 * so a legitimate snapshot is never refused, while a peer that never ends a
 * frame cannot grow client memory without bound.
 */
export const MAX_GATEWAY_EVENT_FRAME_BYTES = 8 * 1024 * 1024;

export interface SseFrame {
  data: string | null;
  id: string | null;
  /** The frame's `event:` field, present only when the block names one. */
  event?: string;
}

export type GatewayStreamMessage =
  | { kind: "event"; event: string; payload: unknown }
  /** Consumers must refetch authoritative state. */
  | { kind: "resync" }
  /** A transport frame that must not reach ordinary listeners. */
  | { kind: "control" }
  | { kind: "malformed" };

export class GatewayEventFrameTooLargeError extends Error {
  constructor(maxFrameBytes: number) {
    super(`Gateway event stream frame exceeded the ${maxFrameBytes}-byte limit`);
    this.name = "GatewayEventFrameTooLargeError";
  }
}

/** True for frames only the transport may act on. */
export function isGatewayTransportEvent(event: string): boolean {
  return (
    event === GATEWAY_CONNECTED_EVENT ||
    event === GATEWAY_RECONCILE_REQUIRED_EVENT ||
    event === GATEWAY_CURSOR_EVENT ||
    event === NATIVE_EVENT_STREAM_CONNECTED_EVENT ||
    event === TERMINAL_EVENT_STREAM_CONNECTED_EVENT
  );
}

/**
 * Parses one SSE block. The last `id:` and `event:` lines win; `data:` lines
 * join with `\n`.
 */
export function parseSseBlock(block: string): SseFrame {
  const lines = block.split(/\r?\n/);
  const idLine = lines.findLast((line) => line.startsWith("id:"));
  const eventLine = lines.findLast((line) => line.startsWith("event:"));
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  const event = eventLine?.slice(6).trimStart();
  return {
    data: data || null,
    id: idLine ? idLine.slice(3).trimStart() : null,
    ...(event ? { event } : {}),
  };
}

/** Parses a frame's `data` as a gateway `{ event, payload }` envelope. */
export function parseGatewayEventData(data: string): { event: string; payload: unknown } | null {
  let parsed: { event?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(data) as { event?: unknown; payload?: unknown };
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.event !== "string") return null;
  return { event: parsed.event, payload: parsed.payload };
}

/** The longest boundary, `\r\n\r\n`, can leave this much of itself in one chunk. */
const MAX_SPLIT_BOUNDARY_PREFIX = 3;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 length without allocating an encoded copy; stops once past `limit`. */
function utf8Bytes(value: string, limit = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(value.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}

/**
 * A UTF-16 code unit never encodes to fewer than one byte or more than three,
 * so most checks are answered from `length` alone.
 */
function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  if (value.length * 3 <= maxBytes) return false;
  return utf8Bytes(value, maxBytes) > maxBytes;
}

/** Incremental SSE framing over decoded text chunks, with a per-frame bound. */
export class SseFrameDecoder {
  /**
   * The incomplete frame, joined only once a boundary arrives. Scanning or
   * measuring the whole of it per chunk would make a large frame quadratic.
   */
  private chunks: string[] = [];
  private pendingLength = 0;
  private pendingBytes = 0;
  /** The pending text's end, enough to find a boundary a chunk split. */
  private tail = "";

  constructor(private readonly maxFrameBytes = MAX_GATEWAY_EVENT_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError("maxFrameBytes must be a positive integer");
    }
  }

  /** Returns every frame the chunk completed; throws once a frame is too large. */
  push(chunk: string): SseFrame[] {
    if (!/\r?\n\r?\n/.test(this.tail + chunk)) {
      this.pendingBytes += utf8Bytes(chunk);
      // A surrogate pair split by the chunk counted as two lone units of 3.
      if (isHighSurrogate(this.tail.charCodeAt(this.tail.length - 1))) {
        if (isLowSurrogate(chunk.charCodeAt(0))) this.pendingBytes -= 2;
      }
      this.chunks.push(chunk);
      this.pendingLength += chunk.length;
      this.tail = (this.tail + chunk).slice(-MAX_SPLIT_BOUNDARY_PREFIX);
      if (this.pendingBytes > this.maxFrameBytes) {
        throw new GatewayEventFrameTooLargeError(this.maxFrameBytes);
      }
      return [];
    }

    const text = this.chunks.join("") + chunk;
    const boundary = /\r?\n\r?\n/g;
    // Anything earlier was already searched and held no boundary.
    boundary.lastIndex = this.pendingLength - this.tail.length;
    const frames: SseFrame[] = [];
    let start = 0;
    for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
      const block = text.slice(start, match.index);
      start = match.index + match[0].length;
      if (exceedsUtf8Bytes(block, this.maxFrameBytes)) {
        throw new GatewayEventFrameTooLargeError(this.maxFrameBytes);
      }
      frames.push(parseSseBlock(block));
    }
    const remainder = text.slice(start);
    this.chunks = remainder ? [remainder] : [];
    this.pendingLength = remainder.length;
    this.pendingBytes = utf8Bytes(remainder);
    this.tail = remainder.slice(-MAX_SPLIT_BOUNDARY_PREFIX);
    if (this.pendingBytes > this.maxFrameBytes) {
      throw new GatewayEventFrameTooLargeError(this.maxFrameBytes);
    }
    return frames;
  }
}

/**
 * Reads one SSE response body to its end, handing every complete frame to
 * `onFrame`. The reader is always cancelled, including after a throw from
 * `onFrame` or an oversized frame. Aborting `signal` also ends a read that is
 * waiting on a silent connection, which the transport may never error.
 * `onChunk` sees every chunk, keepalive comments included, for liveness.
 */
export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onFrame: (frame: SseFrame) => void,
  maxFrameBytes = MAX_GATEWAY_EVENT_FRAME_BYTES,
  onChunk?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameDecoder(maxFrameBytes);
  const stop = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) return;
      onChunk?.();
      const text = decoder.decode(value, { stream: !done });
      for (const frame of frames.push(text)) {
        if (signal.aborted) return;
        onFrame(frame);
      }
      if (done) break;
    }
  } finally {
    signal.removeEventListener("abort", stop);
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Cursor and recovery state for one client's authoritative stream. It outlives
 * individual connections: create one per logical subscription and feed it
 * every frame from every connection in order.
 */
export class GatewayEventStreamState {
  private cursorValue: string | null = null;
  private announced = false;

  /** The newest cursor to resume from, or null before the first frame. */
  get cursor(): string | null {
    return this.cursorValue;
  }

  /** Classifies one frame of the authoritative stream and advances the cursor. */
  accept(data: string, id: string | null): GatewayStreamMessage {
    const parsed = parseGatewayEventData(data);
    if (!parsed) return { kind: "malformed" };
    // An empty id is "no id", not a reset: echoing it would make the gateway
    // treat this client as fresh and skip the replay it is owed.
    if (id) this.cursorValue = id;

    if (parsed.event === GATEWAY_CURSOR_EVENT) return { kind: "control" };
    if (parsed.event === GATEWAY_RECONCILE_REQUIRED_EVENT) {
      this.announced = true;
      return { kind: "resync" };
    }
    if (parsed.event === GATEWAY_CONNECTED_EVENT) {
      // Only the first fresh connection is news. A later connection either
      // replayed what it missed or is followed by an explicit reconcile frame.
      const status =
        parsed.payload && typeof parsed.payload === "object" && "status" in parsed.payload
          ? (parsed.payload as { status?: unknown }).status
          : null;
      if (status === "fresh" && !this.announced) {
        this.announced = true;
        return { kind: "resync" };
      }
      return { kind: "control" };
    }
    if (
      parsed.event === NATIVE_EVENT_STREAM_CONNECTED_EVENT ||
      parsed.event === TERMINAL_EVENT_STREAM_CONNECTED_EVENT
    )
      return { kind: "control" };
    return { kind: "event", event: parsed.event, payload: parsed.payload };
  }
}

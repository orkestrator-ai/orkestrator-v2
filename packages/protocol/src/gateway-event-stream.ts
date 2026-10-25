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

/**
 * UTF-8 length without allocating an encoded copy. A UTF-16 code unit never
 * encodes to fewer than one byte or more than three, so most checks are
 * answered from `length` alone.
 */
function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true;
  if (value.length * 3 <= maxBytes) return false;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
    if (bytes > maxBytes) return true;
  }
  return false;
}

/** Incremental SSE framing over decoded text chunks, with a per-frame bound. */
export class SseFrameDecoder {
  private pending = "";

  constructor(private readonly maxFrameBytes = MAX_GATEWAY_EVENT_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new RangeError("maxFrameBytes must be a positive integer");
    }
  }

  /** Returns every frame the chunk completed; throws once a frame is too large. */
  push(chunk: string): SseFrame[] {
    this.pending += chunk;
    const frames: SseFrame[] = [];
    let boundary = /\r?\n\r?\n/.exec(this.pending);
    while (boundary) {
      const block = this.pending.slice(0, boundary.index);
      this.pending = this.pending.slice(boundary.index + boundary[0].length);
      if (exceedsUtf8Bytes(block, this.maxFrameBytes)) {
        throw new GatewayEventFrameTooLargeError(this.maxFrameBytes);
      }
      frames.push(parseSseBlock(block));
      boundary = /\r?\n\r?\n/.exec(this.pending);
    }
    if (exceedsUtf8Bytes(this.pending, this.maxFrameBytes)) {
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

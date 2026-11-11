/**
 * OpenCode 2.x live events (`GET /api/event`).
 *
 * The stream has no replay: it is a hint channel over the message snapshot
 * (AGENTS.md invariants 3 and 4). Durable events carry
 * `durable: { aggregateID, seq }`, a per-session sequence, so a missed event
 * shows up as a sequence gap; the caller then re-reads the snapshot. The gap
 * signal is conservative, not exact: 2.2.6 never broadcasts a few durable
 * sequence numbers (about two per run, observed live), so some gaps cost a
 * re-read that finds nothing new. Ephemeral events (`session.text.delta`,
 * `session.tool.progress`, …) carry no sequence and may be lost without
 * consequence.
 *
 * The parser never awaits a consumer and bounds every frame: an oversized
 * frame is dropped and reported as a desync, so the caller re-reads rather
 * than trusting a partial picture.
 *
 * An idle healthy stream sends no events, only `: heartbeat` SSE comments
 * (on connect and every 15 s at 2.2.6). The parser drops comments, so the
 * optional `onLife` callback is how a caller's silence watchdog sees them:
 * it is called for every chunk read, and with `heartbeat: true` for every
 * heartbeat comment, which is what arms the watchdog.
 */

/** A single SSE frame larger than this is dropped (and reported) rather than buffered. */
export const OPENCODE2_MAX_EVENT_FRAME_BYTES = 1024 * 1024;

export interface OpenCode2Event {
  type: string;
  data: unknown;
  durable?: { aggregateID: string; seq: number };
}

export type OpenCode2StreamSignal =
  | { kind: "event"; event: OpenCode2Event }
  /** Something was lost; re-read the authoritative snapshot. */
  | { kind: "desync"; reason: "oversized-frame" | "malformed-frame" };

/**
 * Read an SSE body until it ends or `signal` aborts, calling `onSignal`
 * synchronously for every frame. Never throws for a malformed frame; a
 * transport failure ends the read with the error so the caller reconnects.
 * `onLife` is called synchronously for every chunk of bytes read
 * (`heartbeat: false`) and for every `: heartbeat` comment frame
 * (`heartbeat: true`); it never sees content.
 */
export async function readOpenCode2Events(
  body: ReadableStream<Uint8Array>,
  onSignal: (signal: OpenCode2StreamSignal) => void,
  signal?: AbortSignal,
  onLife?: (heartbeat: boolean) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const abort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  let buffer = "";
  let skipping = false;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      onLife?.(false);
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const end = frameEnd(buffer);
        if (end === undefined) break;
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end.length);
        if (skipping) {
          // The tail of a frame that was already reported oversized.
          skipping = false;
          continue;
        }
        if (onLife && isHeartbeatComment(frame)) {
          onLife(true);
          continue;
        }
        const parsed = parseFrame(frame);
        if (parsed) onSignal(parsed);
      }
      if (buffer.length > OPENCODE2_MAX_EVENT_FRAME_BYTES) {
        buffer = "";
        if (!skipping) onSignal({ kind: "desync", reason: "oversized-frame" });
        skipping = true;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function frameEnd(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** A frame of SSE comment lines only, one of which is `: heartbeat`. */
function isHeartbeatComment(frame: string): boolean {
  let heartbeat = false;
  for (const line of frame.split(/\r?\n/)) {
    if (!line) continue;
    if (!line.startsWith(":")) return false;
    if (line.slice(1).trim() === "heartbeat") heartbeat = true;
  }
  return heartbeat;
}

function parseFrame(frame: string): OpenCode2StreamSignal | undefined {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { kind: "desync", reason: "malformed-frame" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "desync", reason: "malformed-frame" };
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string") return { kind: "desync", reason: "malformed-frame" };
  const durable = record.durable as Record<string, unknown> | undefined;
  const event: OpenCode2Event = { type: record.type, data: record.data };
  if (
    durable &&
    typeof durable.aggregateID === "string" &&
    typeof durable.seq === "number" &&
    Number.isSafeInteger(durable.seq)
  ) {
    event.durable = { aggregateID: durable.aggregateID, seq: durable.seq };
  }
  return { kind: "event", event };
}

export type OpenCode2SequenceVerdict = "next" | "gap" | "stale" | "first";

/**
 * Tracks the last durable sequence seen per session. `gap` means at least one
 * durable event for that session was missed and the snapshot must be re-read;
 * `stale` is a replayed or duplicate frame that adds nothing. Bounded: a
 * session evicted for capacity simply restarts at `first`, which callers treat
 * as "re-read before trusting".
 */
export class OpenCode2SequenceTracker {
  private readonly last = new Map<string, number>();

  constructor(private readonly maxSessions = 1024) {}

  note(aggregateID: string, seq: number): OpenCode2SequenceVerdict {
    const previous = this.last.get(aggregateID);
    if (previous !== undefined && seq <= previous) return "stale";
    this.last.delete(aggregateID);
    this.last.set(aggregateID, seq);
    while (this.last.size > this.maxSessions) {
      this.last.delete(this.last.keys().next().value!);
    }
    if (previous === undefined) return "first";
    return seq === previous + 1 ? "next" : "gap";
  }

  /** The snapshot was re-read through `seq`; continue from there. */
  resync(aggregateID: string, seq: number): void {
    this.last.delete(aggregateID);
    this.last.set(aggregateID, seq);
  }

  forget(aggregateID: string): void {
    this.last.delete(aggregateID);
  }
}

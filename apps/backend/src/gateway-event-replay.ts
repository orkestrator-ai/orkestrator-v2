/**
 * Bounded, generation-scoped replay storage for authoritative gateway events.
 *
 * This is a reconnect aid, not a durable log. Backend snapshots remain
 * authoritative. A cursor outside the retained window is rejected explicitly
 * so a client can reconcile instead of accepting a partial history.
 */

export const DEFAULT_GATEWAY_REPLAY_FRAME_CAPACITY = 2_048;
/**
 * Deliberately a quarter of the gateway's per-client hard buffer. Replay is one
 * synchronous flush, so a window sized at the hard limit leaves zero headroom
 * and a slow socket is destroyed partway through delivering it.
 */
export const DEFAULT_GATEWAY_REPLAY_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Release payloads five minutes after the last authoritative event. Revisions
 * keep advancing after release, so a returning client is told to reconcile.
 */
export const DEFAULT_GATEWAY_REPLAY_IDLE_RETENTION_MS = 5 * 60_000;

export interface GatewayReplayFrame {
  revision: number;
  cursor: string;
  event: string;
  /** The encoded SSE frame. Every client is written these same bytes. */
  message: Buffer;
  encodedBytes: number;
}

export type GatewayCursorParseResult =
  | { kind: "absent" }
  | { kind: "invalid"; raw: string }
  | {
      kind: "valid";
      raw: string;
      generation: string;
      revision: number;
    };

export interface GatewayReplayResult {
  complete: boolean;
  frames: GatewayReplayFrame[];
  latestRevision: number;
  oldestRevision: number;
}

export interface GatewayEventReplayOptions {
  frameCapacity?: number;
  maxBytes?: number;
  idleRetentionMs?: number;
}

const frameEncoder = new TextEncoder();

/**
 * UTF-8 encodes a frame into memory of its own. `Buffer.from(string)` may carve
 * a small frame out of a shared pool slab, and a retained frame would then pin
 * the whole slab, so the ring's byte bound would understate what it holds.
 */
export function encodeGatewayFrame(frame: string): Buffer {
  const encoded = frameEncoder.encode(frame);
  return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
}

function formatDataMessage(cursor: string, event: string, payload: unknown): Buffer {
  return encodeGatewayFrame(`id: ${cursor}\ndata: ${JSON.stringify({ event, payload })}\n\n`);
}

export function formatGatewayCursor(generation: string, revision: number): string {
  return `${generation}:${revision}`;
}

/**
 * Cursors are opaque to clients but intentionally strict at the gateway:
 * accepting whitespace, control characters, or unsafe integers would make an
 * echoed SSE `id` ambiguous and could strand automatic EventSource retries.
 */
export function parseGatewayCursor(raw: string | null | undefined): GatewayCursorParseResult {
  if (raw === null || raw === undefined) return { kind: "absent" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "invalid", raw: trimmed };
  const match = /^([A-Za-z0-9_-]{8,128}):(0|[1-9]\d*)$/.exec(trimmed);
  if (!match) return { kind: "invalid", raw: trimmed };
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision)) return { kind: "invalid", raw: trimmed };
  return {
    kind: "valid",
    raw: trimmed,
    generation: match[1]!,
    revision,
  };
}

export class GatewayEventReplay {
  readonly generation: string;
  private readonly frameCapacity: number;
  private readonly maxBytes: number;
  private readonly idleRetentionMs: number;
  private readonly frames: GatewayReplayFrame[] = [];
  private revision = 0;
  private retainedBytes = 0;
  private droppedFrames = 0;
  private oversizedAppends = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(generation: string, options: GatewayEventReplayOptions = {}) {
    this.generation = generation;
    this.frameCapacity = Math.max(
      1,
      options.frameCapacity ?? DEFAULT_GATEWAY_REPLAY_FRAME_CAPACITY,
    );
    this.maxBytes = Math.max(0, options.maxBytes ?? DEFAULT_GATEWAY_REPLAY_MAX_BYTES);
    this.idleRetentionMs = Math.max(
      0,
      options.idleRetentionMs ?? DEFAULT_GATEWAY_REPLAY_IDLE_RETENTION_MS,
    );
  }

  get latestRevision(): number {
    return this.revision;
  }

  get oldestRevision(): number {
    return this.frames[0]?.revision ?? 0;
  }

  get latestCursor(): string {
    return formatGatewayCursor(this.generation, this.revision);
  }

  append(event: string, payload: unknown): GatewayReplayFrame {
    // Serialization may throw; publish a revision only once its frame exists.
    const revision = this.revision + 1;
    const cursor = formatGatewayCursor(this.generation, revision);
    const message = formatDataMessage(cursor, event, payload);
    this.revision = revision;
    const frame: GatewayReplayFrame = {
      revision: this.revision,
      cursor,
      event,
      message,
      encodedBytes: message.byteLength,
    };
    // One frame over the byte bound evicts the whole window, itself included, and
    // every reconnecting client then reconciles. Keeping the older frames instead
    // would make that gap undetectable, so this only makes it visible.
    if (frame.encodedBytes > this.maxBytes) this.oversizedAppends += 1;
    this.frames.push(frame);
    this.retainedBytes += frame.encodedBytes;
    while (this.frames.length > this.frameCapacity || this.retainedBytes > this.maxBytes) {
      const removed = this.frames.shift();
      if (!removed) break;
      this.retainedBytes -= removed.encodedBytes;
      this.droppedFrames += 1;
    }
    this.scheduleIdleRelease();
    return frame;
  }

  since(revision: number): GatewayReplayResult {
    if (!Number.isSafeInteger(revision) || revision < 0 || revision > this.revision) {
      return {
        complete: false,
        frames: [],
        latestRevision: this.revision,
        oldestRevision: this.oldestRevision,
      };
    }
    if (revision === this.revision) {
      return {
        complete: true,
        frames: [],
        latestRevision: this.revision,
        oldestRevision: this.oldestRevision,
      };
    }
    const oldestRevision = this.oldestRevision;
    const complete = oldestRevision !== 0 && revision + 1 >= oldestRevision;
    return {
      complete,
      // Revisions are contiguous: `append` adds one per frame and frames leave
      // only from the front, so the range's start is a subtraction away.
      frames: complete ? this.frames.slice(revision + 1 - oldestRevision) : [],
      latestRevision: this.revision,
      oldestRevision,
    };
  }

  releaseRetained(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.frames.length = 0;
    this.retainedBytes = 0;
  }

  getStats(): {
    generation: string;
    latestRevision: number;
    oldestRevision: number;
    retainedFrames: number;
    retainedBytes: number;
    droppedFrames: number;
    oversizedAppends: number;
    frameCapacity: number;
    maxBytes: number;
    idleRetentionMs: number;
  } {
    return {
      generation: this.generation,
      latestRevision: this.revision,
      oldestRevision: this.oldestRevision,
      retainedFrames: this.frames.length,
      retainedBytes: this.retainedBytes,
      droppedFrames: this.droppedFrames,
      oversizedAppends: this.oversizedAppends,
      frameCapacity: this.frameCapacity,
      maxBytes: this.maxBytes,
      idleRetentionMs: this.idleRetentionMs,
    };
  }

  private scheduleIdleRelease(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.idleRetentionMs === 0) {
      this.releaseRetained();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.frames.length = 0;
      this.retainedBytes = 0;
    }, this.idleRetentionMs);
    this.idleTimer.unref?.();
  }
}

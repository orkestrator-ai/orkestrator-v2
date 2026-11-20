import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BRIDGE_STATE_REVISION_VERSION,
  bridgeObservationFrameData,
  type BridgeObservationFrameRevisions,
} from "../bridge-state-revision.js";

/** Most observers one bridge serves at once; the backend holds one per connection. */
export const BRIDGE_OBSERVATION_MAX_SUBSCRIBERS = 16;
/** Bytes a subscriber may leave unread before it is closed (it reconnects with its cursor). */
export const BRIDGE_OBSERVATION_MAX_PENDING_BYTES = 1024 * 1024;
/** Keepalive cadence; the backend treats 75 s of silence as a lost stream. */
export const BRIDGE_OBSERVATION_KEEPALIVE_MS = 30_000;

export interface BridgeObservationHubOptions {
  /** The process generation in every cursor; a fresh id by default. */
  generation?: string;
  maxSubscribers?: number;
  maxPendingBytes?: number;
  keepaliveMs?: number;
  /** Interval seam for tests. */
  setInterval?: (callback: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface Subscriber {
  response: ServerResponse;
  close: () => void;
}

/**
 * `GET /event/subscribe?observe=1` for a `node:http` bridge (Cursor, Pi, ACP):
 * the backend observer's content-free wakeup stream, the same contract the
 * Claude and Codex bridges serve (bridges/AGENTS.md, "Session surface routes").
 *
 * - Frames carry the event type, the cursor `id:` (`<generation>:<n>`) and
 *   `{"sessionId","stateRevision","transcriptRevision"}`; never content.
 * - Nothing is retained for replay: a cursor that is not current (an older
 *   revision, another process generation) gets `replay.required`, and the
 *   backend re-reads every session.
 * - `publish` is synchronous and never awaits or throws, so it is safe inside
 *   an SDK listener. A subscriber that cannot drain is closed, not queued.
 * - It never touches liveness, hydrates or re-attaches a session.
 */
export class BridgeObservationHub {
  readonly generation: string;
  private revision = 0;
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxSubscribers: number;
  private readonly maxPendingBytes: number;
  private readonly keepaliveMs: number;
  private readonly setIntervalImpl: (callback: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;

  constructor(options: BridgeObservationHubOptions = {}) {
    this.generation = options.generation ?? randomUUID();
    this.maxSubscribers = Math.max(1, options.maxSubscribers ?? BRIDGE_OBSERVATION_MAX_SUBSCRIBERS);
    this.maxPendingBytes = Math.max(
      1,
      options.maxPendingBytes ?? BRIDGE_OBSERVATION_MAX_PENDING_BYTES,
    );
    this.keepaliveMs = Math.max(1, options.keepaliveMs ?? BRIDGE_OBSERVATION_KEEPALIVE_MS);
    this.setIntervalImpl =
      options.setInterval ??
      ((callback, ms) => {
        const handle = setInterval(callback, ms);
        handle.unref?.();
        return handle;
      });
    this.clearIntervalImpl =
      options.clearInterval ??
      ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  get currentCursor(): string {
    return `${this.generation}:${this.revision}`;
  }

  /**
   * Announce that a session changed. Synchronous, never throws. Without a
   * subscriber it only advances the cursor.
   */
  publish(
    type: string,
    sessionId: string | undefined,
    revisions: BridgeObservationFrameRevisions = {},
  ): void {
    const revision = ++this.revision;
    if (this.subscribers.size === 0) return;
    let data: string;
    try {
      data = bridgeObservationFrameData(sessionId, revisions);
    } catch {
      data = "{}";
    }
    const frame = sseFrame(type, data, `${this.generation}:${revision}`);
    for (const subscriber of Array.from(this.subscribers)) this.write(subscriber, frame);
  }

  /** Serve one subscription. The caller has authenticated the request. */
  serve(request: IncomingMessage, response: ServerResponse, url: URL): void {
    if (url.searchParams.get("observe") !== "1") {
      respondJson(response, 400, {
        error: "observe=1 is required: this bridge serves only the observation stream",
      });
      return;
    }
    if (this.subscribers.size >= this.maxSubscribers) {
      respondJson(response, 503, { error: "Too many observation subscribers" });
      return;
    }
    const requested =
      url.searchParams.get("since") ?? headerValue(request.headers["last-event-id"]);
    const current = this.revision;
    const cursor = requested ?? `${this.generation}:${current}`;
    const resetRequired = cursor !== `${this.generation}:${current}`;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    let keepalive: unknown = null;
    const subscriber: Subscriber = {
      response,
      close: () => {
        if (closed) return;
        closed = true;
        this.subscribers.delete(subscriber);
        if (keepalive !== null) this.clearIntervalImpl(keepalive);
        keepalive = null;
        if (!response.writableEnded) {
          try {
            response.end();
          } catch {
            // Already gone.
          }
        }
      },
    };
    this.subscribers.add(subscriber);
    request.on("close", subscriber.close);
    response.on("close", subscriber.close);
    response.on("error", subscriber.close);
    // Echo the client's own cursor, so a client that adopts every `id:` never
    // skips past a gap it has not been told about yet.
    this.write(
      subscriber,
      sseFrame(
        "connected",
        JSON.stringify({
          status: "connected",
          timestamp: new Date().toISOString(),
          resetRequired,
          observe: true,
          revisions: BRIDGE_STATE_REVISION_VERSION,
        }),
        safeCursor(cursor),
      ),
    );
    if (resetRequired) {
      this.write(
        subscriber,
        sseFrame(
          "replay.required",
          JSON.stringify({ through: `${this.generation}:${current}` }),
          `${this.generation}:${current}`,
        ),
      );
    }
    if (closed) return;
    keepalive = this.setIntervalImpl(() => {
      this.write(
        subscriber,
        sseFrame("keepalive", JSON.stringify({ timestamp: new Date().toISOString() })),
      );
    }, this.keepaliveMs);
  }

  /** Close every subscriber (shutdown). */
  close(): void {
    for (const subscriber of Array.from(this.subscribers)) subscriber.close();
  }

  private write(subscriber: Subscriber, frame: string): void {
    const { response } = subscriber;
    if (response.writableEnded || response.destroyed) {
      subscriber.close();
      return;
    }
    if (response.writableLength + Buffer.byteLength(frame) > this.maxPendingBytes) {
      subscriber.close();
      return;
    }
    try {
      response.write(frame);
    } catch {
      subscriber.close();
    }
  }
}

function sseFrame(event: string, data: string, id?: string): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${data}\n\n`;
}

/** A client cursor echoed back: one line, bounded, or replaced by a marker. */
function safeCursor(cursor: string): string {
  return /^[\x21-\x7e]{1,128}$/.test(cursor) ? cursor : "invalid:0";
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function respondJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

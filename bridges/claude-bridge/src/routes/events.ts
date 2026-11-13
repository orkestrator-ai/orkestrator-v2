// SSE Events route
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventEmitter } from "../services/event-emitter.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

/**
 * A subscriber that cannot drain this backlog is closed instead of queued
 * further, and reconnects with its cursor. Frames are content-free, so the
 * frame count is the bound that binds in practice; the byte cap stays as the
 * explicit second bound every queue carries.
 */
export const MAX_PENDING_SSE_FRAMES = 1_000;
export const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;

interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/**
 * The only stream the bridge serves (`?observe=1`): each frame is the event
 * type, its cursor and the session it names, never the payload. The backend's
 * activity observer subscribes only to learn *that* a session changed, then
 * reads it through the no-touch activity route.
 */
export function observationFrameData(sessionId: string | undefined): string {
  return JSON.stringify(sessionId === undefined ? {} : { sessionId });
}

interface EventCursor {
  generation: string;
  revision: number;
}

function formatCursor(revision: number): string {
  return `${eventEmitter.generation}:${revision}`;
}

export function parseEventCursor(value: string | undefined): EventCursor | null {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const generation = value.slice(0, separator);
  const revisionText = value.slice(separator + 1);
  if (!/^[a-zA-Z0-9-]+$/.test(generation) || !/^\d+$/.test(revisionText)) {
    return null;
  }
  const revision = Number(revisionText);
  return Number.isSafeInteger(revision) && revision >= 0 ? { generation, revision } : null;
}

/**
 * Serializes writes onto one promise chain (concurrent `writeSSE` calls can
 * interleave frame bytes) and bounds the backlog. The first frame is always
 * accepted so a single oversized frame cannot wedge an idle connection.
 *
 * Exported for tests: the limits are per-connection module constants, so
 * driving the real ones would need a 16MB fixture.
 */
export function createBoundedSseWriter(
  write: (frame: SseFrame) => Promise<void>,
  onOverflow: () => void,
  limits: { maxPendingFrames?: number; maxPendingBytes?: number } = {},
): (frame: SseFrame) => Promise<void> {
  const maxPendingFrames = limits.maxPendingFrames ?? MAX_PENDING_SSE_FRAMES;
  const maxPendingBytes = limits.maxPendingBytes ?? MAX_PENDING_SSE_BYTES;
  let tail: Promise<void> = Promise.resolve();
  let pendingFrames = 0;
  let pendingBytes = 0;
  let overflowed = false;
  return (frame) => {
    if (overflowed) return Promise.resolve();
    // Bytes on the wire, not UTF-16 code units: a non-ASCII session id or
    // keepalive can weigh more than `frame.data.length` reports.
    const frameBytes = Buffer.byteLength(frame.data);
    if (
      pendingFrames > 0 &&
      (pendingFrames >= maxPendingFrames || pendingBytes + frameBytes > maxPendingBytes)
    ) {
      overflowed = true;
      onOverflow();
      return Promise.resolve();
    }
    pendingFrames += 1;
    pendingBytes += frameBytes;
    const release = () => {
      pendingFrames -= 1;
      pendingBytes -= frameBytes;
    };
    const attempt = tail.then(() => write(frame));
    attempt.then(release, release);
    tail = attempt.catch(() => undefined);
    return attempt;
  };
}

/**
 * The moment an SSE connection stops, as one settle hook shared by every
 * write.
 *
 * Racing each write against a promise that settles only when the connection
 * closes attaches a reaction to that promise per frame, and every reaction is
 * kept until the connection closes; a long-lived `?observe=1` stream retained
 * one per frame it ever sent. Here a write registers one waiter and removes it
 * as soon as the write settles, so what is held at any moment is bounded by
 * the writes in flight.
 *
 * Exported for tests.
 */
export interface SseConnectionClosure {
  /** Settles once `close` runs. Await it once, for the connection's life. */
  readonly closed: Promise<void>;
  readonly isClosed: boolean;
  /** Idempotent. Releases every write still waiting. */
  close(): void;
  /**
   * Resolves when `write` resolves or the connection closes, whichever is
   * first, and rejects if `write` rejects first.
   */
  race(write: Promise<unknown>): Promise<void>;
  /** Writes currently registered. Tests only. */
  readonly pendingWaiters: number;
}

export function createSseConnectionClosure(): SseConnectionClosure {
  const waiters = new Set<() => void>();
  let isClosed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  return {
    closed,
    get isClosed() {
      return isClosed;
    },
    get pendingWaiters() {
      return waiters.size;
    },
    close() {
      if (isClosed) return;
      isClosed = true;
      for (const wake of Array.from(waiters)) wake();
      waiters.clear();
      resolveClosed();
    },
    race(write) {
      if (isClosed) {
        // Same as a race against an already-settled close: never wait, and
        // leave nothing unhandled behind.
        write.catch(() => undefined);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        const wake = () => resolve();
        waiters.add(wake);
        write.then(
          () => {
            waiters.delete(wake);
            resolve();
          },
          (error: unknown) => {
            waiters.delete(wake);
            reject(error);
          },
        );
      });
    },
  };
}

/** Frequency of the idle-connection keepalive comment frame. */
export const KEEPALIVE_INTERVAL_MS = 30_000;

export function createEventsRouter(
  limits: {
    maxPendingFrames?: number;
    maxPendingBytes?: number;
    keepaliveIntervalMs?: number;
  } = {},
): Hono {
  const events = new Hono();
  const maxPendingFrames = limits.maxPendingFrames ?? MAX_PENDING_SSE_FRAMES;
  const maxPendingBytes = limits.maxPendingBytes ?? MAX_PENDING_SSE_BYTES;
  const keepaliveIntervalMs = limits.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;

  events.get("/subscribe", (c) => {
    const origin = c.req.header("origin");
    const userAgent = c.req.header("user-agent");
    log.debug("sse.subscribe-requested", { origin, userAgent });
    // The full-payload stream is gone; every backend that subscribes sends
    // `observe=1`. Refusing anything else fails a consumer that expects
    // payloads loudly, rather than handing it content-free frames it would
    // misread as empty updates.
    if (c.req.query("observe") !== "1") {
      return c.json(
        { error: "observe=1 is required: this bridge serves only the observation stream" },
        400,
      );
    }
    return streamSSE(c, async (stream) => {
      const connectedAt = new Date().toISOString();
      log.debug("sse.opened", { connectedAt });

      let isOpen = true;
      // Settles on a request abort or on `closeConnection`, whichever is first.
      const closure = createSseConnectionClosure();
      const onRequestAbort = () => {
        log.debug("sse.aborted");
        isOpen = false;
        closure.close();
      };
      if (c.req.raw.signal.aborted) {
        isOpen = false;
        closure.close();
      } else {
        // Register before the first awaited write. A client can consume
        // `connected` and abort while the handshake is still flushing;
        // attaching this listener afterwards loses that edge and leaks the
        // subscription.
        c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true });
      }
      const closeConnection = (reason: string) => {
        if (!isOpen) return;
        isOpen = false;
        log.info("sse.closed", { reason });
        closure.close();
      };

      const writeFrame = createBoundedSseWriter(
        async (frame) => {
          if (!isOpen) throw new Error("SSE request aborted");
          // A stream write may remain backpressured forever after its browser
          // disappears. Racing the close lets the route release its emitter
          // subscription even when the underlying writer never settles; the
          // waiter is removed as soon as this write settles.
          await closure.race(stream.writeSSE(frame));
          if (!isOpen) throw new Error("SSE request aborted");
        },
        () => closeConnection("write backlog exceeded its cap"),
        { maxPendingFrames, maxPendingBytes },
      );

      const requestedCursorValue = c.req.header("last-event-id") ?? c.req.query("since");
      const requestedCursor = parseEventCursor(requestedCursorValue);
      const cursorWasSupplied = requestedCursorValue !== undefined;
      const pendingLiveFrames: SseFrame[] = [];
      let pendingLiveBytes = 0;
      let handshaking = true;
      let keepaliveInterval: ReturnType<typeof setInterval> | undefined;
      let unsubscribe = () => {};

      try {
        // Subscribe before reading the current revision. Anything emitted
        // during the handshake is buffered and flushed after it, so no event
        // falls between the cursor check and the live stream.
        unsubscribe = eventEmitter.subscribe((event, revision) => {
          if (!isOpen) return;
          const frame: SseFrame = {
            id: formatCursor(revision),
            event: event.type,
            data: observationFrameData(event.sessionId),
          };
          if (handshaking) {
            const frameBytes = Buffer.byteLength(frame.data) + Buffer.byteLength(frame.event);
            if (
              pendingLiveFrames.length >= maxPendingFrames ||
              pendingLiveBytes + frameBytes > maxPendingBytes
            ) {
              closeConnection("handshake backlog exceeded its cap");
              return;
            }
            pendingLiveFrames.push(frame);
            pendingLiveBytes += frameBytes;
            return;
          }
          void writeFrame(frame).catch((error) => {
            if (!c.req.raw.signal.aborted) {
              log.warn("sse.write-failed", { error: formatLogError(error) });
              closeConnection("write failed");
            }
          });
        });

        // Read with no await after the subscription: every buffered frame is
        // past this revision.
        const subscribedAt = eventEmitter.currentRevision;
        const cursor = requestedCursor ?? {
          generation: cursorWasSupplied ? "invalid" : eventEmitter.generation,
          revision: subscribedAt,
        };
        // No events are retained, so a cursor is either current or a gap. A
        // gap (an older revision, a future one, another process generation, a
        // malformed cursor) is `replay.required`, and the client re-reads its
        // authoritative state.
        const resetRequired =
          cursor.generation !== eventEmitter.generation || cursor.revision !== subscribedAt;

        // Echo the client's own cursor, never the latest revision: a client
        // adopts every `id:` it sees, and must not skip past a gap it has not
        // been told about yet.
        await writeFrame({
          id: `${cursor.generation}:${cursor.revision}`,
          event: "connected",
          data: JSON.stringify({
            status: "connected",
            timestamp: connectedAt,
            resetRequired,
            // Confirms observation mode; a backend refuses a bridge that does not.
            observe: true,
          }),
        });
        if (resetRequired) {
          await writeFrame({
            id: formatCursor(subscribedAt),
            event: "replay.required",
            data: JSON.stringify({ through: formatCursor(subscribedAt) }),
          });
        }
        // Queue the whole drain in one synchronous turn. The bounded writer
        // chains strictly FIFO, so enqueue order *is* wire order: awaiting each
        // buffered frame in turn would let a live frame emitted during one of
        // those awaits take the `void writeFrame(...)` path and land *between*
        // two buffered frames, regressing the client's stored cursor.
        const drained = pendingLiveFrames.splice(0);
        pendingLiveBytes = 0;
        handshaking = false;
        const drainWrites = drained.map((frame) => writeFrame(frame));
        // `allSettled` leaves no unhandled rejection behind, but a failed drain
        // must still reach the handler's catch and close the connection rather
        // than being swallowed — same semantics as awaiting each write.
        for (const settled of await Promise.allSettled(drainWrites)) {
          if (settled.status === "rejected") throw settled.reason;
        }

        // Send a keepalive on an interval to prevent connection timeout
        keepaliveInterval = setInterval(() => {
          if (!isOpen) {
            if (keepaliveInterval) clearInterval(keepaliveInterval);
            return;
          }
          void writeFrame({
            event: "keepalive",
            data: JSON.stringify({ timestamp: new Date().toISOString() }),
          }).catch((error) => {
            if (!c.req.raw.signal.aborted) {
              log.warn("sse.keepalive-failed", { error: formatLogError(error, { stack: false }) });
              closeConnection("keepalive failed");
            }
          });
        }, keepaliveIntervalMs);

        // Wait until the client disconnects or the writer declares the consumer
        // dead; returning ends the response and the client reconnects.
        await closure.closed;
      } catch (error) {
        if (!c.req.raw.signal.aborted) {
          log.warn("sse.handshake-failed", { error: formatLogError(error) });
        }
      } finally {
        log.debug("sse.cleanup");
        isOpen = false;
        c.req.raw.signal.removeEventListener("abort", onRequestAbort);
        if (keepaliveInterval) clearInterval(keepaliveInterval);
        unsubscribe();
      }
    });
  });

  return events;
}

const events = createEventsRouter();

export default events;

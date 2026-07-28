// SSE Events route
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventEmitter } from "../services/event-emitter.js";
import type { SSEEvent } from "../types/index.js";

/**
 * Serialized frame payload per event object, shared across subscribers.
 *
 * The emitter hands every subscriber the same event object, and each one
 * previously ran its own `JSON.stringify` over a payload that can be a
 * multi-hundred-KB message snapshot — the cost scaled with subscriber count.
 * The first subscriber serializes (synchronously, inside `emit`, so the
 * snapshot is taken before the payload can mutate) and the rest reuse it. A
 * WeakMap keyed on the event object means the cache lives exactly as long as
 * the event does.
 *
 * Exported for tests.
 */
const serializedEventData = new WeakMap<SSEEvent, string>();

export function serializeEventData(event: SSEEvent): string {
  let data = serializedEventData.get(event);
  if (data === undefined) {
    data = JSON.stringify({
      sessionId: event.sessionId,
      ...(event.data as object),
    });
    serializedEventData.set(event, data);
  }
  return data;
}

/**
 * A subscriber that cannot drain this backlog is closed instead of queued
 * further. Every queued frame is a fully serialized message snapshot, so an
 * unbounded chain against a stalled consumer retains multi-MB strings for as
 * long as the connection nominally exists. The bounded replay ring below
 * covers short disconnects; older gaps explicitly tell the client to
 * rehydrate from the authoritative REST endpoints.
 */
export const MAX_PENDING_SSE_FRAMES = 1_000;
export const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;

interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

interface ReplayFrame extends SseFrame {
  revision: number;
  bytes: number;
}

interface ReplayCursor {
  generation: string;
  revision: number;
}

export const MAX_REPLAY_SSE_FRAMES = 512;
/**
 * Sized for an EventSource reconnect gap, not for a whole session.
 *
 * 512 frames is roughly 30s of dense streaming — the same reasoning the codex
 * bridge's ring uses — and every frame here is a serialized message snapshot
 * that grows with the transcript. A 32MB ceiling therefore let one large
 * session pin, indefinitely and in the background, more memory than idle
 * transcript eviction reclaims. A browser reconnects within seconds; a client
 * further behind than this window is better served by `replay.required` and a
 * REST rehydrate, which it already knows how to do.
 */
export const MAX_REPLAY_SSE_BYTES = 4 * 1024 * 1024;

/**
 * How long the ring keeps retaining frames after its last live subscriber goes
 * away.
 *
 * Retention exists to cover a reconnect, so once no connection has existed for
 * substantially longer than one, there is no cursor left to serve. Past this
 * point the subscriber stops serializing entirely and drops what it holds:
 * before the ring existed, an emit with zero subscribers did essentially
 * nothing, and an idle bridge should cost the same again.
 */
export const REPLAY_IDLE_RETENTION_MS = 60_000;

export function createReplayBuffer(
  limits: { maxFrames?: number; maxBytes?: number } = {},
) {
  const maxFrames = limits.maxFrames ?? MAX_REPLAY_SSE_FRAMES;
  const maxBytes = limits.maxBytes ?? MAX_REPLAY_SSE_BYTES;
  const frames: ReplayFrame[] = [];
  let bytes = 0;

  return {
    append(event: SSEEvent, revision: number, generation: string): void {
      const data = serializeEventData(event);
      const frame: ReplayFrame = {
        revision,
        id: `${generation}:${revision}`,
        event: event.type,
        data,
        bytes: Buffer.byteLength(data) + Buffer.byteLength(event.type),
      };
      frames.push(frame);
      bytes += frame.bytes;
      while (frames.length > maxFrames || bytes > maxBytes) {
        const removed = frames.shift();
        if (!removed) break;
        bytes -= removed.bytes;
      }
    },
    getFrames(
      since: ReplayCursor,
      through: number,
      generation: string,
    ): { frames: ReplayFrame[]; resetRequired: boolean } {
      if (since.generation !== generation || since.revision > through) {
        return { frames: [], resetRequired: true };
      }
      const oldest = frames[0]?.revision;
      const resetRequired =
        since.revision < through
        && (oldest === undefined || since.revision < oldest - 1);
      return {
        frames: resetRequired
          ? []
          : frames.filter(
              (frame) =>
                frame.revision > since.revision
                && frame.revision <= through,
            ),
        resetRequired,
      };
    },
    clear(): void {
      frames.length = 0;
      bytes = 0;
    },
    /** Retained weight, so the idle drop is observable. Exported for tests. */
    stats(): { frames: number; bytes: number } {
      return { frames: frames.length, bytes };
    },
  };
}

/**
 * Gates ring retention on there being someone plausibly able to replay from it.
 *
 * The ring subscriber runs on every emit, and serializing a frame costs a full
 * `JSON.stringify` of a message snapshot. Doing that for a bridge nobody is
 * connected to — and holding the result — is background cost with no consumer,
 * so retention is armed by the first live subscriber and dropped again once the
 * last one has been gone for `idleRetentionMs`. A client that reconnects after
 * the drop gets `replay.required`, which the frontend already handles.
 *
 * Exported for tests: the production window is a minute.
 */
export function createReplayRetention(
  ring: { clear(): void },
  idleRetentionMs: number = REPLAY_IDLE_RETENTION_MS,
) {
  let liveSubscribers = 0;
  let retaining = true;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleDrop = () => {
    if (dropTimer) return;
    dropTimer = setTimeout(() => {
      dropTimer = undefined;
      if (liveSubscribers > 0) return;
      retaining = false;
      ring.clear();
    }, idleRetentionMs);
    // Never let a cache drop hold an exiting bridge open.
    dropTimer.unref?.();
  };

  // A bridge that has just started has no subscriber either, so it begins on
  // the same countdown a drained one does.
  scheduleDrop();

  return {
    /** False means "do not even serialize this event". */
    shouldRetain(): boolean {
      return retaining;
    },
    /** Claim retention for one live subscriber; the result releases it once. */
    acquire(): () => void {
      liveSubscribers += 1;
      retaining = true;
      if (dropTimer) {
        clearTimeout(dropTimer);
        dropTimer = undefined;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        liveSubscribers -= 1;
        if (liveSubscribers === 0) scheduleDrop();
      };
    },
    get liveSubscribers(): number {
      return liveSubscribers;
    },
  };
}

const replayBuffer = createReplayBuffer();
const replayRetention = createReplayRetention(replayBuffer);

function formatReplayCursor(revision: number): string {
  return `${eventEmitter.generation}:${revision}`;
}

/**
 * Record the normalized wire frame once, independent of live subscribers.
 * This gives short disconnects a bounded cursor replay without retaining raw,
 * mutable SDK message objects.
 */
eventEmitter.subscribe((event, revision) => {
  // Bail before `serializeEventData`: with retention dropped there is nothing
  // to replay to, and the stringify is the expensive half.
  if (!replayRetention.shouldRetain()) return;
  replayBuffer.append(event, revision, eventEmitter.generation);
});

export function parseReplayCursor(value: string | undefined): ReplayCursor | null {
  if (!value) return null;
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  const generation = value.slice(0, separator);
  const revisionText = value.slice(separator + 1);
  if (!/^[a-zA-Z0-9-]+$/.test(generation) || !/^\d+$/.test(revisionText)) {
    return null;
  }
  const revision = Number(revisionText);
  return Number.isSafeInteger(revision) && revision >= 0
    ? { generation, revision }
    : null;
}

export function getReplayFrames(
  since: ReplayCursor,
  through: number,
): { frames: ReplayFrame[]; resetRequired: boolean } {
  return replayBuffer.getFrames(since, through, eventEmitter.generation);
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
    // Bytes on the wire, not UTF-16 code units: a transcript full of non-ASCII
    // text can weigh up to 3x what `frame.data.length` reports.
    const frameBytes = Buffer.byteLength(frame.data);
    if (
      pendingFrames > 0 &&
      (pendingFrames >= maxPendingFrames ||
        pendingBytes + frameBytes > maxPendingBytes)
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
  const maxPendingFrames =
    limits.maxPendingFrames ?? MAX_PENDING_SSE_FRAMES;
  const maxPendingBytes =
    limits.maxPendingBytes ?? MAX_PENDING_SSE_BYTES;
  const keepaliveIntervalMs =
    limits.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;

events.get("/subscribe", (c) => {
  const origin = c.req.header("origin");
  const userAgent = c.req.header("user-agent");
  console.debug("[events] SSE subscribe request", { origin, userAgent });
  return streamSSE(c, async (stream) => {
    const connectedAt = new Date().toISOString();
    console.debug("[events] SSE connection opened", { connectedAt });

    let isOpen = true;
    let resolveConnectionClosed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      resolveConnectionClosed = resolve;
    });
    let resolveRequestAborted!: () => void;
    const requestAborted = new Promise<void>((resolve) => {
      resolveRequestAborted = resolve;
    });
    const onRequestAbort = () => {
      console.debug("[events] SSE connection aborted by client");
      isOpen = false;
      resolveRequestAborted();
    };
    if (c.req.raw.signal.aborted) {
      isOpen = false;
      resolveRequestAborted();
    } else {
      // Register before the first awaited write. A client can consume
      // `connected` and abort while replay is still flushing; attaching this
      // listener afterwards loses that edge and leaks the subscription.
      c.req.raw.signal.addEventListener("abort", onRequestAbort, { once: true });
    }
    const closeConnection = (reason: string) => {
      if (!isOpen) return;
      isOpen = false;
      console.error(`[events] Closing SSE subscriber (${reason})`);
      resolveConnectionClosed();
    };

    const writeFrame = createBoundedSseWriter(
      async (frame) => {
        if (!isOpen) throw new Error("SSE request aborted");
        // A stream write may remain backpressured forever after its browser
        // disappears. Racing the request signal lets the route release its
        // emitter subscription even when the underlying writer never settles.
        await Promise.race([
          stream.writeSSE(frame),
          requestAborted,
          connectionClosed,
        ]);
        if (!isOpen) throw new Error("SSE request aborted");
      },
      () => closeConnection("write backlog exceeded its cap"),
      { maxPendingFrames, maxPendingBytes },
    );

    const requestedCursorValue =
      c.req.header("last-event-id") ?? c.req.query("since");
    const requestedCursor = parseReplayCursor(requestedCursorValue);
    const cursorWasSupplied = requestedCursorValue !== undefined;
    const pendingLiveFrames: ReplayFrame[] = [];
    let pendingLiveBytes = 0;
    let replaying = true;
    let keepaliveInterval: ReturnType<typeof setInterval> | undefined;
    let unsubscribe = () => {};
    // Arm ring retention for as long as this connection exists, and for one
    // reconnect window after it goes away.
    const releaseReplayRetention = replayRetention.acquire();

    try {
      // Subscribe before choosing the replay ceiling. Anything emitted during
      // the handshake is buffered and flushed after the retained replay,
      // closing the otherwise unavoidable replay/subscribe race.
      unsubscribe = eventEmitter.subscribe((event, revision) => {
        if (!isOpen) return;
        const data = serializeEventData(event);
        const frame: ReplayFrame = {
          revision,
          id: formatReplayCursor(revision),
          event: event.type,
          data,
          bytes: Buffer.byteLength(data) + Buffer.byteLength(event.type),
        };
        if (replaying) {
          if (
            pendingLiveFrames.length >= maxPendingFrames
            || pendingLiveBytes + frame.bytes > maxPendingBytes
          ) {
            closeConnection("handshake backlog exceeded its cap");
            return;
          }
          pendingLiveFrames.push(frame);
          pendingLiveBytes += frame.bytes;
          return;
        }
        void writeFrame(frame).catch((error) => {
          if (!c.req.raw.signal.aborted) {
            console.error("[events] Error writing SSE:", error);
            closeConnection("write failed");
          }
        });
      });

      const replayCeiling = eventEmitter.currentRevision;
      const cursor = requestedCursor ?? {
        generation: cursorWasSupplied ? "invalid" : eventEmitter.generation,
        revision: replayCeiling,
      };
      const replay = getReplayFrames(cursor, replayCeiling);

      // Echo the client's own cursor. Setting this frame to the latest revision
      // would make EventSource skip replay frames if the connection died halfway
      // through the handshake.
      await writeFrame({
        id: `${cursor.generation}:${cursor.revision}`,
        event: "connected",
        data: JSON.stringify({
          status: "connected",
          timestamp: connectedAt,
          replayed: replay.frames.length,
          resetRequired: replay.resetRequired,
        }),
      });
      if (replay.resetRequired) {
        await writeFrame({
          id: formatReplayCursor(replayCeiling),
          event: "replay.required",
          data: JSON.stringify({ through: formatReplayCursor(replayCeiling) }),
        });
      } else {
        for (const frame of replay.frames) await writeFrame(frame);
      }
      // Queue the whole drain in one synchronous turn. The bounded writer
      // chains strictly FIFO, so enqueue order *is* wire order: awaiting each
      // buffered frame in turn would let a live frame emitted during one of
      // those awaits take the `void writeFrame(...)` path and land *between*
      // two buffered frames. A browser adopts every `id:` it sees, so that
      // reorders revisions and regresses the client's stored cursor — and an
      // out-of-order `message.patched` fails the revision guard, forcing the
      // full transcript refetch the replay ring exists to avoid.
      //
      // Every buffered frame is past `replayCeiling` by construction: the
      // subscription above and the ceiling read below are separated by no
      // await, so nothing can be emitted in between.
      const drained = pendingLiveFrames.splice(0);
      pendingLiveBytes = 0;
      replaying = false;
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
            console.debug("[events] Keepalive failed, closing connection:", error);
            closeConnection("keepalive failed");
          }
        });
      }, keepaliveIntervalMs);

      // Wait until the client disconnects or the writer declares the consumer
      // dead; returning ends the response and the client reconnects.
      await Promise.race([
        connectionClosed,
        requestAborted,
      ]);
    } catch (error) {
      if (!c.req.raw.signal.aborted) {
        console.error("[events] SSE handshake failed:", error);
      }
    } finally {
      console.debug("[events] SSE connection cleanup");
      isOpen = false;
      c.req.raw.signal.removeEventListener("abort", onRequestAbort);
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      unsubscribe();
      releaseReplayRetention();
    }
  });
});

  return events;
}

const events = createEventsRouter();

export default events;

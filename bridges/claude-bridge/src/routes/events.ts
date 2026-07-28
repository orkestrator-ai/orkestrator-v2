// SSE Events route
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventEmitter } from "../services/event-emitter.js";
import type { SSEEvent } from "../types/index.js";

const events = new Hono();

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
export const MAX_REPLAY_SSE_BYTES = 32 * 1024 * 1024;
const replayFrames: ReplayFrame[] = [];
let replayBytes = 0;

function formatReplayCursor(revision: number): string {
  return `${eventEmitter.generation}:${revision}`;
}

/**
 * Record the normalized wire frame once, independent of live subscribers.
 * This gives short disconnects a bounded cursor replay without retaining raw,
 * mutable SDK message objects.
 */
eventEmitter.subscribe((event, revision) => {
  const data = serializeEventData(event);
  const frame: ReplayFrame = {
    revision,
    id: formatReplayCursor(revision),
    event: event.type,
    data,
    bytes: Buffer.byteLength(data) + Buffer.byteLength(event.type),
  };
  replayFrames.push(frame);
  replayBytes += frame.bytes;
  while (
    replayFrames.length > MAX_REPLAY_SSE_FRAMES
    || replayBytes > MAX_REPLAY_SSE_BYTES
  ) {
    const removed = replayFrames.shift();
    if (!removed) break;
    replayBytes -= removed.bytes;
  }
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
  if (
    since.generation !== eventEmitter.generation
    || since.revision > through
  ) {
    return { frames: [], resetRequired: true };
  }
  const oldest = replayFrames[0]?.revision;
  const resetRequired =
    since.revision < through
    && (oldest === undefined || since.revision < oldest - 1);
  return {
    frames: resetRequired
      ? []
      : replayFrames.filter(
          (frame) =>
            frame.revision > since.revision
            && frame.revision <= through,
        ),
    resetRequired,
  };
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
            pendingLiveFrames.length >= MAX_PENDING_SSE_FRAMES
            || pendingLiveBytes + frame.bytes > MAX_PENDING_SSE_BYTES
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
      replaying = false;
      for (const frame of pendingLiveFrames) {
        if (frame.revision <= replayCeiling) continue;
        await writeFrame(frame);
      }
      pendingLiveFrames.length = 0;
      pendingLiveBytes = 0;

      // Send keepalive every 30 seconds to prevent connection timeout
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
      }, 30000);

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
    }
  });
});

export default events;

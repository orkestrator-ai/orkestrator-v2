// SSE Events route
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { eventEmitter } from "../services/event-emitter.js";

const events = new Hono();

/**
 * A subscriber that cannot drain this backlog is closed instead of queued
 * further. Every queued frame is a fully serialized message snapshot, so an
 * unbounded chain against a stalled consumer retains multi-MB strings for as
 * long as the connection nominally exists. This bridge has no replay ring;
 * the client reconnects and rehydrates from the REST endpoints, which the UI
 * must be able to do anyway (missed events are never the only source of truth).
 */
export const MAX_PENDING_SSE_FRAMES = 1_000;
export const MAX_PENDING_SSE_BYTES = 16 * 1024 * 1024;

interface SseFrame {
  event: string;
  data: string;
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
    const frameBytes = frame.data.length;
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
    const closeConnection = (reason: string) => {
      if (!isOpen) return;
      isOpen = false;
      console.error(`[events] Closing SSE subscriber (${reason})`);
      resolveConnectionClosed();
    };

    const writeFrame = createBoundedSseWriter(
      async (frame) => {
        if (!isOpen) return;
        await stream.writeSSE(frame);
      },
      () => closeConnection("write backlog exceeded its cap"),
    );

    await writeFrame({
      event: "connected",
      data: JSON.stringify({ status: "connected", timestamp: connectedAt }),
    });

    // Subscribe to events
    const unsubscribe = eventEmitter.subscribe((event) => {
      if (!isOpen) return;
      void writeFrame({
        event: event.type,
        data: JSON.stringify({
          sessionId: event.sessionId,
          ...(event.data as object),
        }),
      }).catch((error) => {
        console.error("[events] Error writing SSE:", error);
        closeConnection("write failed");
      });
    });

    // Send keepalive every 30 seconds to prevent connection timeout
    const keepaliveInterval = setInterval(() => {
      if (!isOpen) {
        clearInterval(keepaliveInterval);
        return;
      }
      void writeFrame({
        event: "keepalive",
        data: JSON.stringify({ timestamp: new Date().toISOString() }),
      }).catch((error) => {
        console.debug("[events] Keepalive failed, closing connection:", error);
        closeConnection("keepalive failed");
      });
    }, 30000);

    // Wait until the client disconnects or the writer declares the consumer
    // dead; returning ends the response and the client reconnects.
    try {
      await Promise.race([
        connectionClosed,
        new Promise((resolve) => {
          c.req.raw.signal.addEventListener("abort", () => {
            console.debug("[events] SSE connection aborted by client");
            resolve(undefined);
          });
        }),
      ]);
    } finally {
      console.debug("[events] SSE connection cleanup");
      isOpen = false;
      clearInterval(keepaliveInterval);
      unsubscribe();
    }
  });
});

export default events;

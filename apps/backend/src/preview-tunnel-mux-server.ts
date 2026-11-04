import type { Duplex } from "node:stream";

import {
  PREVIEW_TUNNEL_CLOSE,
  PREVIEW_TUNNEL_HELLO_TIMEOUT_MS,
} from "@orkestrator/protocol/preview-access";
import {
  decodePreviewTunnelMuxData,
  encodePreviewTunnelMuxData,
  encodePreviewTunnelMuxFrame,
  parsePreviewTunnelMuxClientFrame,
  PREVIEW_TUNNEL_MUX,
  PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES,
  type PreviewTunnelMuxServerFrame,
} from "@orkestrator/protocol/preview-tunnel-mux";
import {
  previewError,
  previewErrorFromUnknown,
  type PreviewError,
  type PreviewErrorCategory,
} from "@orkestrator/protocol/preview-services";
import type { PreviewWebSocket } from "@orkestrator/protocol/node/preview-websocket";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import type { PreviewAdmission, PreviewSlot } from "./preview-admission.js";
import type { PreviewMetrics } from "./preview-metrics.js";
import { connectPreviewUpstream, type PreviewUpstreamOptions } from "./preview-upstream.js";

/** What `PreviewTunnelServer` lends one multiplexed session. */
export interface PreviewTunnelMuxContext {
  runtime: PreviewRuntime;
  metrics: PreviewMetrics;
  /** One slot per upstream connection, shared with v1 tunnels. */
  streams: PreviewAdmission;
  /** One slot per authenticated session. */
  sessions: PreviewAdmission;
  upstream: PreviewUpstreamOptions;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  aggregateQueuedBytes(): number;
  endHandshake(): void;
  onClosed(): void;
}

const CLOSE_FOR: Partial<Record<PreviewErrorCategory, number>> = {
  forbidden: PREVIEW_TUNNEL_CLOSE.forbidden,
  "access-expired": PREVIEW_TUNNEL_CLOSE.revoked,
  "generation-changed": PREVIEW_TUNNEL_CLOSE.generationChanged,
  "capacity-exceeded": PREVIEW_TUNNEL_CLOSE.capacity,
  "invalid-request": PREVIEW_TUNNEL_CLOSE.protocol,
};

interface MuxStream {
  id: number;
  state: "opening" | "open";
  slot: PreviewSlot;
  upstream: Duplex | null;
  opening: AbortController;
  /** Bytes this server may still send before the client credits more. */
  sendCredit: number;
  /** Client bytes received and not yet credited back. */
  uncredited: number;
  /** Client bytes the upstream has flushed, waiting to be credited in one frame. */
  flushed: number;
  clientEnded: boolean;
  /** Paused waiting for credit, the WebSocket's drain or the aggregate bound. */
  blocked: boolean;
}

/**
 * One v2 session: a single authenticated WebSocket carrying many upstream
 * connections (`preview-tunnel-mux.ts` has the wire contract). Each stream is
 * one upstream TCP connection and holds its own admission slot; the session's
 * credential bounds what every stream can reach, and revoking it closes them
 * all. Bytes are bounded per stream by credit and per session by the
 * WebSocket's queue, so one stopped reader stalls only its own stream.
 */
export function acceptPreviewTunnelMux(
  ws: PreviewWebSocket,
  context: PreviewTunnelMuxContext,
): void {
  const { runtime, metrics } = context;
  const limits = runtime.limits;
  const window = PREVIEW_TUNNEL_MUX.windowBytes;
  const streams = new Map<number, MuxStream>();
  let state: "authenticating" | "ready" | "closing" | "closed" = "authenticating";
  let access: AuthenticatedPreviewAccess | null = null;
  let sessionSlot: PreviewSlot | null = null;
  let untrack: (() => void) | null = null;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let lastStreamId = 0;
  let alive = true;

  const send = (frame: PreviewTunnelMuxServerFrame) => {
    ws.send(encodePreviewTunnelMuxFrame(frame), false);
  };

  const release = (stream: MuxStream, notify: boolean) => {
    if (streams.get(stream.id) !== stream) return;
    streams.delete(stream.id);
    stream.opening.abort();
    stream.upstream?.destroy();
    stream.upstream = null;
    stream.slot.release();
    metrics.increment("tunnel.closed");
    if (notify && state === "ready") send({ type: "closed", stream: stream.id });
  };

  const cleanup = () => {
    if (state === "closed") return;
    state = "closed";
    context.endHandshake();
    clearTimeout(helloTimer);
    clearInterval(ping);
    clearTimeout(leaseTimer);
    clearTimeout(recheckTimer);
    for (const stream of Array.from(streams.values())) release(stream, false);
    sessionSlot?.release();
    sessionSlot = null;
    untrack?.();
    untrack = null;
    context.onClosed();
  };

  /** End the whole session, and every stream on it. */
  const fail = (code: number, category: PreviewErrorCategory, withFrame = false) => {
    if (state === "closed" || state === "closing") return;
    if (withFrame) send({ type: "error", error: previewError(category) });
    state = "closing";
    for (const stream of Array.from(streams.values())) release(stream, false);
    ws.close(code, category);
  };
  const violation = () => fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");

  const helloTimer = setTimeout(
    () => fail(PREVIEW_TUNNEL_CLOSE.timeout, "access-expired"),
    context.helloTimeoutMs ?? PREVIEW_TUNNEL_HELLO_TIMEOUT_MS,
  );
  // Same liveness rule as v1. A v2 client never stops reading its socket,
  // since a stalled stream waits for credit rather than pausing the
  // WebSocket, but it still sends its own pings.
  const ping = setInterval(() => {
    if (!ws.isOpen) {
      clearInterval(ping);
      return;
    }
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, context.pingIntervalMs ?? 30_000);
  ping.unref?.();
  const markAlive = () => {
    alive = true;
  };
  ws.on("pong", markAlive);
  ws.on("ping", markAlive);
  ws.on("close", cleanup);

  const canSend = (stream: MuxStream) =>
    stream.sendCredit > 0 &&
    ws.bufferedBytes < limits.tunnelQueueMaxBytesPerDirection &&
    context.aggregateQueuedBytes() < limits.tunnelQueueMaxBytesAggregate;

  const unblock = () => {
    if (state !== "ready") return;
    let waiting = false;
    for (const stream of streams.values()) {
      if (!stream.blocked) continue;
      if (canSend(stream)) {
        stream.blocked = false;
        stream.upstream?.resume();
      } else if (stream.sendCredit > 0) waiting = true;
    }
    // A stream out of credit waits for its CREDIT frame. One that has credit
    // and is held only by the shared ceiling while this socket is flushed
    // gets no drain, so poll for it.
    if (
      waiting &&
      recheckTimer === undefined &&
      ws.bufferedBytes < limits.tunnelQueueMaxBytesPerDirection
    ) {
      recheckTimer = setTimeout(() => {
        recheckTimer = undefined;
        unblock();
      }, 25);
      recheckTimer.unref?.();
    }
  };
  ws.on("drain", unblock);

  const pumpToClient = (stream: MuxStream, socket: Duplex, chunk: Buffer) => {
    if (stream.upstream !== socket) return;
    let offset = 0;
    while (offset < chunk.length) {
      if (!canSend(stream)) {
        // Hand the rest of this read back to the upstream until credit, a
        // drain or the aggregate bound lets it continue.
        socket.pause();
        socket.unshift(chunk.subarray(offset));
        stream.blocked = true;
        unblock();
        return;
      }
      const size = Math.min(
        PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES,
        stream.sendCredit,
        chunk.length - offset,
      );
      ws.send(encodePreviewTunnelMuxData(stream.id, chunk.subarray(offset, offset + size)), true);
      stream.sendCredit -= size;
      offset += size;
    }
  };

  const open = async (stream: MuxStream) => {
    const current = access!;
    const started = Date.now();
    try {
      runtime.access.assertCurrent(current);
      const target = await runtime.registry.acquireTarget(current.serviceId, current.generation);
      if (target.tls) {
        throw Object.assign(new Error("tls upstream"), {
          preview: previewError("unsupported", {
            message: "The desktop tunnel carries HTTP services only.",
          }),
        });
      }
      const socket = await connectPreviewUpstream(target, context.upstream, stream.opening.signal);
      if (streams.get(stream.id) !== stream || state !== "ready") {
        socket.destroy();
        return;
      }
      stream.upstream = socket;
      stream.state = "open";
      metrics.observe("tunnel.open_ms", Date.now() - started);
      metrics.increment("tunnel.open");
      socket.on("data", (chunk: Buffer) => pumpToClient(stream, socket, chunk));
      socket.once("end", () => {
        if (streams.get(stream.id) === stream && state === "ready")
          send({ type: "eof", stream: stream.id });
      });
      socket.once("close", () => release(stream, true));
      send({ type: "open-ok", stream: stream.id });
    } catch (error) {
      const failure =
        (error as { preview?: PreviewError }).preview ??
        previewErrorFromUnknown(error) ??
        previewError("internal");
      metrics.increment("tunnel.failed", failure.category);
      if (streams.get(stream.id) !== stream || state !== "ready") return;
      streams.delete(stream.id);
      stream.slot.release();
      send({ type: "open-failed", stream: stream.id, error: failure });
    }
  };

  const hello = (attachmentId: string, credential: string) => {
    try {
      access = runtime.access.authenticateTunnel(attachmentId, credential);
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category ?? "forbidden";
      metrics.increment("tunnel.rejected", category);
      fail(
        category === "forbidden"
          ? PREVIEW_TUNNEL_CLOSE.unauthenticated
          : (CLOSE_FOR[category] ?? PREVIEW_TUNNEL_CLOSE.forbidden),
        category,
      );
      return;
    }
    clearTimeout(helloTimer);
    context.endHandshake();
    sessionSlot = context.sessions.tryAcquire(access.serviceId);
    if (!sessionSlot) {
      metrics.increment("tunnel.rejected", "capacity-exceeded");
      fail(PREVIEW_TUNNEL_CLOSE.capacity, "capacity-exceeded", true);
      return;
    }
    try {
      untrack = runtime.access.track(access, {
        close: () => fail(PREVIEW_TUNNEL_CLOSE.revoked, "access-expired", true),
      });
    } catch (error) {
      const category = previewErrorFromUnknown(error)?.category ?? "access-expired";
      fail(CLOSE_FOR[category] ?? PREVIEW_TUNNEL_CLOSE.revoked, category);
      return;
    }
    leaseTimer = setTimeout(
      () => fail(PREVIEW_TUNNEL_CLOSE.revoked, "access-expired", true),
      Math.max(0, access.expiresAt - Date.now()),
    );
    leaseTimer.unref?.();
    state = "ready";
    send({
      type: "ready",
      serviceId: access.serviceId,
      endpointGeneration: access.generation,
      expiresAt: new Date(access.expiresAt).toISOString(),
    });
  };

  const openStream = (id: number) => {
    if (id <= lastStreamId || streams.size >= PREVIEW_TUNNEL_MUX.maxStreams) return violation();
    lastStreamId = id;
    const slot = context.streams.tryAcquire(access!.serviceId);
    if (!slot) {
      metrics.increment("tunnel.rejected", "capacity-exceeded");
      send({ type: "open-failed", stream: id, error: previewError("capacity-exceeded") });
      return;
    }
    const stream: MuxStream = {
      id,
      state: "opening",
      slot,
      upstream: null,
      opening: new AbortController(),
      sendCredit: window,
      uncredited: 0,
      flushed: 0,
      clientEnded: false,
      blocked: false,
    };
    streams.set(id, stream);
    void open(stream);
  };

  const receiveData = (message: Buffer) => {
    const decoded = decodePreviewTunnelMuxData(message);
    if (!decoded) return violation();
    const stream = streams.get(decoded.stream);
    if (!stream) {
      // Released already (a race with CLOSED); only an id never opened is a violation.
      if (decoded.stream > lastStreamId) violation();
      return;
    }
    // Application bytes are only accepted after OPEN_OK, within credit.
    const socket = stream.upstream;
    if (stream.state !== "open" || !socket || stream.clientEnded) return violation();
    const size = decoded.data.length;
    if (stream.uncredited + size > window) return violation();
    stream.uncredited += size;
    socket.write(decoded.data, () => {
      if (streams.get(stream.id) !== stream) return;
      stream.flushed += size;
      // Credit in quarter-window batches: a client that has used its whole
      // window has a full window here, so it always gets credit once it flushes.
      if (stream.flushed < window / 4) return;
      const bytes = stream.flushed;
      stream.flushed = 0;
      stream.uncredited -= bytes;
      if (state === "ready") send({ type: "credit", stream: stream.id, bytes });
    });
  };

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    markAlive();
    if (state === "closed" || state === "closing") return;
    if (isBinary) {
      if (state !== "ready") return violation();
      receiveData(data);
      return;
    }
    const frame = parsePreviewTunnelMuxClientFrame(data.toString("utf8"));
    if (!frame) return violation();
    if (frame.type === "hello") {
      if (state !== "authenticating") violation();
      else hello(frame.attachmentId, frame.credential);
      return;
    }
    if (state !== "ready") return violation();
    if (frame.type === "open") return openStream(frame.stream);
    const stream = streams.get(frame.stream);
    if (!stream) {
      if (frame.stream > lastStreamId) violation();
      return;
    }
    switch (frame.type) {
      case "eof":
        if (stream.state !== "open" || stream.clientEnded) return violation();
        stream.clientEnded = true;
        stream.upstream?.end();
        return;
      case "cancel":
        release(stream, false);
        return;
      case "credit":
        if (stream.sendCredit + frame.bytes > window) return violation();
        stream.sendCredit += frame.bytes;
        if (stream.blocked) unblock();
        return;
    }
  });
  ws.start();
}

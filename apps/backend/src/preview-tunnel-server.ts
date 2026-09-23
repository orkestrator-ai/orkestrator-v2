import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import {
  encodePreviewTunnelFrame,
  parsePreviewTunnelClientFrame,
  PREVIEW_TUNNEL_CLOSE,
  PREVIEW_TUNNEL_HELLO_TIMEOUT_MS,
  PREVIEW_TUNNEL_PATH,
  PREVIEW_TUNNEL_SUBPROTOCOL,
  type PreviewTunnelServerFrame,
} from "@orkestrator/protocol/preview-access";
import {
  previewError,
  previewErrorFromUnknown,
  type PreviewError,
  type PreviewErrorCategory,
} from "@orkestrator/protocol/preview-services";
import {
  acceptPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/preview-websocket";

import type { AuthenticatedPreviewAccess } from "./core/preview-access.js";
import type { PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission, type PreviewSlot } from "./preview-admission.js";
import type { PreviewMetrics } from "./preview-metrics.js";
import { connectPreviewUpstream, type PreviewUpstreamOptions } from "./preview-upstream.js";

export interface PreviewTunnelServerOptions {
  runtime: PreviewRuntime;
  metrics: PreviewMetrics;
  logger: Pick<Console, "debug" | "warn">;
  upstream?: Partial<PreviewUpstreamOptions>;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
}

type TunnelState = "authenticating" | "ready" | "opening" | "open" | "closing" | "closed";

const CLOSE_FOR: Partial<Record<PreviewErrorCategory, number>> = {
  forbidden: PREVIEW_TUNNEL_CLOSE.forbidden,
  "access-expired": PREVIEW_TUNNEL_CLOSE.revoked,
  "generation-changed": PREVIEW_TUNNEL_CLOSE.generationChanged,
  "capacity-exceeded": PREVIEW_TUNNEL_CLOSE.capacity,
  "invalid-request": PREVIEW_TUNNEL_CLOSE.protocol,
};

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`,
  );
  setTimeout(() => socket.destroy(), 1_000).unref?.();
}

/**
 * Desktop preview tunnel: one authenticated WebSocket per upstream TCP
 * connection. The attachment credential authorizes exactly one service at one
 * endpoint generation; the client never names a host, port, container, or
 * path. Bytes are relayed in bounded frames with real socket backpressure in
 * both directions and are never replayed after a disconnect.
 */
export class PreviewTunnelServer {
  private readonly sockets = new Set<PreviewWebSocket>();
  private readonly admission: PreviewAdmission;
  private readonly upstream: PreviewUpstreamOptions;
  private pendingHandshakes = 0;
  private closed = false;

  constructor(private readonly options: PreviewTunnelServerOptions) {
    const limits = options.runtime.limits;
    this.admission = new PreviewAdmission("tunnel", {
      perService: limits.tunnelsPerService,
      perBackend: limits.tunnelsPerBackend,
    });
    this.upstream = { connectTimeoutMs: limits.connectTimeoutMs, ...options.upstream };
  }

  get listening(): boolean {
    return !this.closed;
  }

  /** Bytes queued toward clients across every tunnel. */
  aggregateQueuedBytes(): number {
    let total = 0;
    for (const ws of this.sockets) total += ws.bufferedBytes;
    return total;
  }

  stats() {
    return {
      sockets: this.sockets.size,
      pendingHandshakes: this.pendingHandshakes,
      aggregateQueuedBytes: this.aggregateQueuedBytes(),
      admission: this.admission.stats(),
    };
  }

  /** Returns false for any path this server does not own. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
    } catch {
      return false;
    }
    if (pathname !== PREVIEW_TUNNEL_PATH) return false;
    if (this.closed) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    // Only native clients open tunnels. A browser page always sends Origin,
    // so any Origin is a cross-site attempt against this endpoint.
    if (request.headers.origin !== undefined) {
      rejectUpgrade(socket, 403, "Forbidden");
      return true;
    }
    const offered = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    if (!offered.includes(PREVIEW_TUNNEL_SUBPROTOCOL)) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return true;
    }
    if (this.pendingHandshakes >= this.options.runtime.limits.tunnelHandshakesPending) {
      this.options.metrics.increment("tunnel.rejected", "capacity-exceeded");
      rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    const ws = acceptPreviewWebSocket(request, socket, head, {
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: this.options.runtime.limits.tunnelFrameMaxBytes,
    });
    if (!ws) return true;
    this.pendingHandshakes += 1;
    let counted = true;
    this.accept(ws, () => {
      if (!counted) return;
      counted = false;
      this.pendingHandshakes -= 1;
    });
    return true;
  }

  private accept(ws: PreviewWebSocket, endHandshake: () => void): void {
    const { runtime, metrics } = this.options;
    const limits = runtime.limits;
    const opened = Date.now();
    this.sockets.add(ws);
    let state: TunnelState = "authenticating";
    let access: AuthenticatedPreviewAccess | null = null;
    let slot: PreviewSlot | null = null;
    let untrack: (() => void) | null = null;
    let upstream: Duplex | null = null;
    let upstreamEnded = false;
    let clientEnded = false;
    let alive = true;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const opening = new AbortController();

    const send = (frame: PreviewTunnelServerFrame) => {
      ws.send(encodePreviewTunnelFrame(frame), false);
    };
    const cleanup = () => {
      if (state === "closed") return;
      state = "closed";
      endHandshake();
      clearTimeout(helloTimer);
      clearInterval(ping);
      clearTimeout(leaseTimer);
      opening.abort();
      upstream?.destroy();
      upstream = null;
      slot?.release();
      slot = null;
      untrack?.();
      untrack = null;
      this.sockets.delete(ws);
      metrics.increment("tunnel.closed");
    };
    const fail = (
      code: number,
      category: PreviewErrorCategory,
      frame?: "open-failed" | "error",
      error?: PreviewError,
    ) => {
      if (state === "closed" || state === "closing") return;
      if (frame) send({ type: frame, error: error ?? previewError(category) });
      state = "closing";
      upstream?.destroy();
      ws.close(code, category);
    };

    const helloTimer = setTimeout(
      () => fail(PREVIEW_TUNNEL_CLOSE.timeout, "access-expired"),
      this.options.helloTimeoutMs ?? PREVIEW_TUNNEL_HELLO_TIMEOUT_MS,
    );
    // Liveness on Orkestrator's own protocol only; application bytes are never touched.
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, this.options.pingIntervalMs ?? 30_000);
    ping.unref?.();
    ws.on("pong", () => (alive = true));
    ws.on("close", cleanup);

    const pumpToClient = (chunk: Buffer) => {
      const socket = upstream;
      if (!socket) return;
      const frameMax = limits.tunnelFrameMaxBytes;
      let flushed = true;
      for (let offset = 0; offset < chunk.length; offset += frameMax) {
        flushed = ws.send(chunk.subarray(offset, offset + frameMax), true) && flushed;
      }
      if (ws.bufferedBytes > limits.tunnelQueueMaxBytesPerDirection * 2) {
        // A reader that stopped consuming entirely: close with a typed failure
        // rather than buffering application bytes without bound.
        fail(PREVIEW_TUNNEL_CLOSE.capacity, "capacity-exceeded", "error");
        return;
      }
      const overAggregate = this.aggregateQueuedBytes() >= limits.tunnelQueueMaxBytesAggregate;
      if (!flushed || ws.bufferedBytes >= limits.tunnelQueueMaxBytesPerDirection) {
        socket.pause();
        ws.once("drain", () => {
          if (upstream === socket && state === "open") socket.resume();
        });
      } else if (overAggregate) {
        // This tunnel's own socket is flushed, so no drain will come: poll the
        // shared ceiling instead of waiting on an event that never fires.
        socket.pause();
        const recheck = () => {
          if (upstream !== socket || state !== "open") return;
          if (this.aggregateQueuedBytes() < limits.tunnelQueueMaxBytesAggregate) socket.resume();
          else setTimeout(recheck, 25).unref?.();
        };
        setTimeout(recheck, 25).unref?.();
      }
    };

    const open = async () => {
      if (!access) return;
      state = "opening";
      try {
        runtime.access.assertCurrent(access);
        const target = await runtime.registry.acquireTarget(access.serviceId, access.generation);
        if (target.tls) {
          throw Object.assign(new Error("tls upstream"), {
            preview: previewError("unsupported", {
              message: "The desktop tunnel carries HTTP services only.",
            }),
          });
        }
        const socket = await connectPreviewUpstream(target, this.upstream, opening.signal);
        if (state !== "opening") {
          socket.destroy();
          return;
        }
        upstream = socket;
        state = "open";
        metrics.observe("tunnel.open_ms", Date.now() - opened);
        metrics.increment("tunnel.open");
        socket.on("data", pumpToClient);
        socket.once("end", () => {
          upstreamEnded = true;
          send({ type: "eof" });
          if (clientEnded) ws.close(PREVIEW_TUNNEL_CLOSE.normal);
        });
        socket.once("close", () => {
          if (state === "open") {
            state = "closing";
            ws.close(PREVIEW_TUNNEL_CLOSE.normal);
          }
        });
        send({ type: "open-ok" });
      } catch (error) {
        const failure =
          (error as { preview?: PreviewError }).preview ??
          previewErrorFromUnknown(error) ??
          previewError("internal");
        metrics.increment("tunnel.failed", failure.category);
        if (state === "opening") {
          fail(
            CLOSE_FOR[failure.category] ?? PREVIEW_TUNNEL_CLOSE.upstreamFailed,
            failure.category,
            "open-failed",
            failure,
          );
        }
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
      endHandshake();
      slot = this.admission.tryAcquire(access.serviceId);
      if (!slot) {
        metrics.increment("tunnel.rejected", "capacity-exceeded");
        fail(PREVIEW_TUNNEL_CLOSE.capacity, "capacity-exceeded", "error");
        return;
      }
      try {
        untrack = runtime.access.track(access, {
          close: () => fail(PREVIEW_TUNNEL_CLOSE.revoked, "access-expired", "error"),
        });
      } catch (error) {
        const category = previewErrorFromUnknown(error)?.category ?? "access-expired";
        fail(CLOSE_FOR[category] ?? PREVIEW_TUNNEL_CLOSE.revoked, category);
        return;
      }
      leaseTimer = setTimeout(
        () => fail(PREVIEW_TUNNEL_CLOSE.revoked, "access-expired", "error"),
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

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (state === "closed" || state === "closing") return;
      if (isBinary) {
        // Application bytes are only accepted after OPEN_OK; never buffered
        // before authorization.
        const socket = upstream;
        if (state !== "open" || !socket || clientEnded) {
          fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");
          return;
        }
        if (!socket.write(data)) {
          ws.pause();
          socket.once("drain", () => ws.resume());
        }
        return;
      }
      const frame = parsePreviewTunnelClientFrame(data.toString("utf8"));
      if (!frame) {
        fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");
        return;
      }
      switch (frame.type) {
        case "hello":
          if (state !== "authenticating") fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");
          else hello(frame.attachmentId, frame.credential);
          return;
        case "open":
          if (state !== "ready") fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");
          else void open();
          return;
        case "eof":
          if (state !== "open" || clientEnded) {
            fail(PREVIEW_TUNNEL_CLOSE.protocol, "invalid-request");
            return;
          }
          clientEnded = true;
          upstream?.end();
          if (upstreamEnded) ws.close(PREVIEW_TUNNEL_CLOSE.normal);
          return;
        case "cancel":
          state = "closing";
          upstream?.destroy();
          ws.close(PREVIEW_TUNNEL_CLOSE.normal);
          return;
      }
    });
    ws.start();
  }

  /** Close every tunnel (shutdown or credential rotation). */
  closeAll(code: number = PREVIEW_TUNNEL_CLOSE.revoked): void {
    for (const ws of Array.from(this.sockets)) ws.close(code, "revoked");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeAll(1001);
  }
}

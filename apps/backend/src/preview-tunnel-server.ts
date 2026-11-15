import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { PREVIEW_TUNNEL_CLOSE, PREVIEW_TUNNEL_PATH } from "@orkestrator/protocol/preview-access";
import { PREVIEW_TUNNEL_SUBPROTOCOL_V2 } from "@orkestrator/protocol/preview-tunnel-mux";
import {
  acceptPreviewWebSocket,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

import type { PreviewRuntime } from "./core/preview-runtime.js";
import { PreviewAdmission } from "./preview-admission.js";
import type { PreviewMetrics } from "./preview-metrics.js";
import { acceptPreviewTunnelMux } from "./preview-tunnel-mux-server.js";
import type { PreviewUpstreamOptions } from "./preview-upstream.js";

export interface PreviewTunnelServerOptions {
  runtime: PreviewRuntime;
  metrics: PreviewMetrics;
  upstream?: Partial<PreviewUpstreamOptions>;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\nconnection: close\r\n\r\n${message}`,
  );
  setTimeout(() => socket.destroy(), 1_000).unref?.();
}

/**
 * Desktop preview tunnel. A client carries many upstream TCP connections over
 * one authenticated WebSocket (`preview-tunnel-mux-server.ts`). The
 * attachment credential authorizes exactly one service at one endpoint
 * generation; the client never names a host, port, container, or path. Bytes
 * are relayed in bounded frames with real socket backpressure in both
 * directions and are never replayed after a disconnect.
 */
export class PreviewTunnelServer {
  private readonly sockets = new Set<PreviewWebSocket>();
  /** Upstream connections, across every session. */
  private readonly admission: PreviewAdmission;
  /** Sessions; their upstream connections take `admission` slots. */
  private readonly sessions: PreviewAdmission;
  private readonly upstream: PreviewUpstreamOptions;
  private pendingHandshakes = 0;
  private closed = false;

  constructor(private readonly options: PreviewTunnelServerOptions) {
    const limits = options.runtime.limits;
    this.admission = new PreviewAdmission("tunnel", {
      perService: limits.tunnelsPerService,
      perBackend: limits.tunnelsPerBackend,
    });
    this.sessions = new PreviewAdmission("tunnel", {
      perService: limits.tunnelsPerService,
      perBackend: limits.tunnelsPerBackend,
    });
    this.upstream = {
      connectTimeoutMs: limits.connectTimeoutMs,
      relayConnect: (target, signal) => options.runtime.relayConnect(target, signal),
      ...options.upstream,
    };
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
      sessions: this.sessions.stats().active,
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
    if (!offered.includes(PREVIEW_TUNNEL_SUBPROTOCOL_V2)) {
      rejectUpgrade(socket, 426, "Upgrade Required");
      return true;
    }
    if (this.pendingHandshakes >= this.options.runtime.limits.tunnelHandshakesPending) {
      this.options.metrics.increment("tunnel.rejected", "capacity-exceeded");
      rejectUpgrade(socket, 503, "Service Unavailable");
      return true;
    }
    const ws = acceptPreviewWebSocket(request, socket, head, {
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL_V2,
      maxPayload: this.options.runtime.limits.tunnelFrameMaxBytes,
    });
    if (!ws) return true;
    this.pendingHandshakes += 1;
    let counted = true;
    const endHandshake = () => {
      if (!counted) return;
      counted = false;
      this.pendingHandshakes -= 1;
    };
    this.sockets.add(ws);
    acceptPreviewTunnelMux(ws, {
      runtime: this.options.runtime,
      metrics: this.options.metrics,
      streams: this.admission,
      sessions: this.sessions,
      upstream: this.upstream,
      helloTimeoutMs: this.options.helloTimeoutMs,
      pingIntervalMs: this.options.pingIntervalMs,
      aggregateQueuedBytes: () => this.aggregateQueuedBytes(),
      endHandshake,
      onClosed: () => this.sockets.delete(ws),
    });
    return true;
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

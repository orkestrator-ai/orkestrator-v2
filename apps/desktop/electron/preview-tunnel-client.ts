import { Duplex } from "node:stream";

import {
  encodePreviewTunnelFrame,
  parsePreviewTunnelServerFrame,
  PREVIEW_TUNNEL_CLOSE,
  PREVIEW_TUNNEL_SUBPROTOCOL,
} from "@orkestrator/protocol/preview-access";
import {
  PREVIEW_LIMITS,
  previewFailure,
  type PreviewErrorCategory,
} from "@orkestrator/protocol/preview-services";
import {
  connectPreviewWebSocket,
  PreviewWebSocketHandshakeError,
  type PreviewWebSocket,
} from "@orkestrator/protocol/preview-websocket";

export interface PreviewTunnelOpenOptions {
  /** `ws(s)://<gateway>/__orkestrator/preview/tunnel` */
  url: string;
  attachmentId: string;
  credential: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  ca?: string;
}

const CATEGORY_FOR_CLOSE: Record<number, PreviewErrorCategory> = {
  [PREVIEW_TUNNEL_CLOSE.unauthenticated]: "access-expired",
  [PREVIEW_TUNNEL_CLOSE.forbidden]: "forbidden",
  [PREVIEW_TUNNEL_CLOSE.revoked]: "access-expired",
  [PREVIEW_TUNNEL_CLOSE.generationChanged]: "generation-changed",
  [PREVIEW_TUNNEL_CLOSE.capacity]: "capacity-exceeded",
  [PREVIEW_TUNNEL_CLOSE.timeout]: "connect-timeout",
};

/**
 * One tunnel connection as a Duplex byte stream. Writes are split into
 * bounded frames and respect WebSocket backpressure; reads pause the socket
 * when the consumer is not reading. `end()` half-closes (EOF); `destroy()`
 * cancels. Nothing is buffered before the backend confirms `OPEN_OK`.
 */
export class PreviewTunnelStream extends Duplex {
  private closedByPeer = false;

  constructor(private readonly ws: PreviewWebSocket) {
    super({ allowHalfOpen: true });
    ws.on("message", (data, binary) => {
      if (binary) {
        if (!this.push(data)) ws.pause();
        return;
      }
      const frame = parsePreviewTunnelServerFrame(data.toString("utf8"));
      if (frame?.type === "eof") this.push(null);
      else if (frame?.type === "error")
        this.destroy(previewFailure(frame.error.category, frame.error));
    });
    ws.on("close", (code) => {
      this.closedByPeer = true;
      if (code === PREVIEW_TUNNEL_CLOSE.normal || code === 1005) {
        // Both directions ended. Let buffered bytes drain to the reader; the
        // stream auto-destroys once it has ended and finished.
        this.push(null);
        if (!this.writableEnded) this.end();
        return;
      }
      this.destroy(previewFailure(CATEGORY_FOR_CLOSE[code] ?? "backend-unavailable"));
    });
    ws.on("drain", () => this.emit("tunnel-drain"));
  }

  override _read(): void {
    this.ws.resume();
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.ws.isOpen) {
      callback(previewFailure("backend-unavailable", { message: "The preview tunnel closed." }));
      return;
    }
    let flushed = true;
    for (let offset = 0; offset < chunk.length; offset += PREVIEW_LIMITS.tunnelFrameMaxBytes) {
      flushed =
        this.ws.send(chunk.subarray(offset, offset + PREVIEW_LIMITS.tunnelFrameMaxBytes), true) &&
        flushed;
    }
    if (flushed) callback();
    else this.once("tunnel-drain", () => callback());
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (this.ws.isOpen) this.ws.send(encodePreviewTunnelFrame({ type: "eof" }), false);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.closedByPeer && this.ws.isOpen) {
      this.ws.send(encodePreviewTunnelFrame({ type: "cancel" }), false);
      this.ws.close(PREVIEW_TUNNEL_CLOSE.normal);
    }
    callback(error);
  }
}

/**
 * Open an authorized tunnel connection: WebSocket handshake, HELLO with the
 * attachment credential, OPEN (no destination fields), then OPEN_OK. HELLO
 * and OPEN are pipelined; application bytes wait for OPEN_OK.
 */
export async function openPreviewTunnel(
  options: PreviewTunnelOpenOptions,
): Promise<PreviewTunnelStream> {
  let ws: PreviewWebSocket;
  try {
    ws = await connectPreviewWebSocket({
      url: options.url,
      protocol: PREVIEW_TUNNEL_SUBPROTOCOL,
      maxPayload: PREVIEW_LIMITS.tunnelFrameMaxBytes,
      connectTimeoutMs: options.connectTimeoutMs ?? PREVIEW_LIMITS.connectTimeoutMs,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? PREVIEW_LIMITS.connectTimeoutMs,
      ca: options.ca,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof PreviewWebSocketHandshakeError && error.status === 503) {
      throw previewFailure("capacity-exceeded");
    }
    throw previewFailure("backend-unavailable", {
      message: "The preview tunnel could not be reached.",
    });
  }
  return new Promise<PreviewTunnelStream>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      ws.off("message", onMessage);
      ws.off("close", onClose);
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      if (error) {
        ws.terminate();
        reject(error);
        return;
      }
      const stream = new PreviewTunnelStream(ws);
      resolve(stream);
    };
    const onMessage = (data: Buffer, binary: boolean) => {
      if (binary) return finish(previewFailure("internal", { message: "Unexpected tunnel data." }));
      const frame = parsePreviewTunnelServerFrame(data.toString("utf8"));
      if (!frame) return finish(previewFailure("internal", { message: "Malformed tunnel frame." }));
      if (frame.type === "ready") return;
      if (frame.type === "open-ok") return finish(null);
      if (frame.type === "open-failed" || frame.type === "error") {
        return finish(previewFailure(frame.error.category, { message: frame.error.message }));
      }
    };
    const onClose = (code: number) =>
      finish(previewFailure(CATEGORY_FOR_CLOSE[code] ?? "backend-unavailable"));
    const onAbort = () =>
      finish(previewFailure("access-expired", { message: "The preview request was cancelled." }));
    const timer = setTimeout(
      () => finish(previewFailure("connect-timeout")),
      (options.handshakeTimeoutMs ?? PREVIEW_LIMITS.connectTimeoutMs) * 2,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.start();
    ws.send(
      encodePreviewTunnelFrame({
        type: "hello",
        version: 1,
        attachmentId: options.attachmentId,
        credential: options.credential,
      }),
      false,
    );
    ws.send(encodePreviewTunnelFrame({ type: "open" }), false);
  });
}

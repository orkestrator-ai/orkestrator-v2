import { PREVIEW_TUNNEL_CLOSE } from "@orkestrator/protocol/preview-access";
import {
  PREVIEW_LIMITS,
  previewFailure,
  type PreviewErrorCategory,
} from "@orkestrator/protocol/preview-services";
import {
  connectPreviewWebSocket,
  PreviewWebSocketHandshakeError,
  type PreviewWebSocket,
} from "@orkestrator/protocol/node/preview-websocket";

export interface PreviewTunnelOpenOptions {
  /** `ws(s)://<gateway>/__orkestrator/preview/tunnel` */
  url: string;
  attachmentId: string;
  credential: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  ca?: string;
  /** Client heartbeat; defaults to `PREVIEW_TUNNEL_CLIENT_PING_MS`. */
  pingIntervalMs?: number;
}

export const CATEGORY_FOR_CLOSE: Record<number, PreviewErrorCategory> = {
  [PREVIEW_TUNNEL_CLOSE.unauthenticated]: "access-expired",
  [PREVIEW_TUNNEL_CLOSE.forbidden]: "forbidden",
  [PREVIEW_TUNNEL_CLOSE.revoked]: "access-expired",
  [PREVIEW_TUNNEL_CLOSE.generationChanged]: "generation-changed",
  [PREVIEW_TUNNEL_CLOSE.capacity]: "capacity-exceeded",
  [PREVIEW_TUNNEL_CLOSE.timeout]: "connect-timeout",
};

/**
 * The tunnel WebSocket handshake, offering `protocol`. A backend that is busy
 * answers 503 (capacity); any other refusal, including a backend that does
 * not speak the offered subprotocol, is `backend-unavailable`.
 */
export async function connectPreviewTunnelSocket(
  options: PreviewTunnelOpenOptions,
  protocol: string,
): Promise<PreviewWebSocket> {
  try {
    return await connectPreviewWebSocket({
      url: options.url,
      protocol,
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
}

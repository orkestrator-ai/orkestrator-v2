/**
 * Desktop tunnel wire contract v2: many upstream connections ("streams") over
 * one authenticated WebSocket per attachment.
 *
 * v1 (`preview-access.ts`) pays a WebSocket handshake plus HELLO and OPEN for
 * every upstream connection. v2 pays them once per session:
 *
 * 1. A v2 backend advertises `multiplexSubprotocol` in the attachment's
 *    tunnel descriptor. The client then offers `PREVIEW_TUNNEL_SUBPROTOCOL_V2`
 *    first and `PREVIEW_TUNNEL_SUBPROTOCOL` second; the server answers v2. A
 *    server that answers v1 anyway gets v1 on that socket.
 * 2. Client sends HELLO {version: 2, attachmentId, credential}. Server
 *    answers READY or closes with 4401/4403/4410, as in v1.
 * 3. Client sends OPEN {stream} with a new stream id, strictly greater than
 *    every id it used before on this session. Server answers OPEN_OK {stream}
 *    or OPEN_FAILED {stream, error}; a failed OPEN leaves the session up.
 * 4. Binary messages carry a 4-byte big-endian stream id, then at most
 *    `tunnelFrameMaxBytes - 4` bytes of that stream's data. Text frames are
 *    JSON control frames naming their stream.
 * 5. Flow control is per stream and per direction: each side may have at most
 *    `windowBytes` sent and not yet credited. The receiver returns CREDIT
 *    {stream, bytes} once its consumer has taken the bytes, so a stream whose
 *    reader stopped (paused media) stalls itself and no other stream.
 * 6. EOF {stream} half-closes one direction. CANCEL {stream} from the client
 *    tears the stream down. CLOSED {stream} from the server says it released
 *    the stream; the client sends nothing further on it. Either side ignores
 *    frames for a stream it has already released.
 * 7. Revocation, lease expiry and shutdown close the WebSocket, and with it
 *    every stream, with the v1 close codes. Nothing is replayed.
 *
 * Any malformed frame, a reused or out-of-order stream id, data beyond the
 * granted credit, or more than `maxStreams` open streams closes the session
 * with 4400.
 */
import { PREVIEW_TUNNEL_SUBPROTOCOL, PREVIEW_TUNNEL_SUBPROTOCOL_V2 } from "./preview-access.js";
import {
  isOpaquePreviewId,
  isPreviewErrorCategory,
  PREVIEW_LIMITS,
  previewError,
  type PreviewError,
} from "./preview-services.js";

export { PREVIEW_TUNNEL_SUBPROTOCOL_V2 };
export const PREVIEW_TUNNEL_MUX_VERSION = 2;

/** Offer order: v2 first, v1 for a backend that predates multiplexing. */
export const PREVIEW_TUNNEL_OFFERED_SUBPROTOCOLS = [
  PREVIEW_TUNNEL_SUBPROTOCOL_V2,
  PREVIEW_TUNNEL_SUBPROTOCOL,
] as const;

export const PREVIEW_TUNNEL_MUX = {
  /** Concurrently open streams per session; a client opens another session beyond it. */
  maxStreams: 32,
  /** Per-stream, per-direction bytes in flight before the receiver credits them. */
  windowBytes: 256 * 1024,
  /** Bytes of stream id before each binary payload. */
  headerBytes: 4,
} as const;

/** Largest stream payload in one binary message. */
export const PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES =
  PREVIEW_LIMITS.tunnelFrameMaxBytes - PREVIEW_TUNNEL_MUX.headerBytes;

const MAX_STREAM_ID = 0xffff_ffff;

export type PreviewTunnelMuxClientFrame =
  | {
      type: "hello";
      version: typeof PREVIEW_TUNNEL_MUX_VERSION;
      attachmentId: string;
      credential: string;
    }
  | { type: "open"; stream: number }
  | { type: "eof"; stream: number }
  | { type: "cancel"; stream: number }
  | { type: "credit"; stream: number; bytes: number };

export type PreviewTunnelMuxServerFrame =
  | { type: "ready"; serviceId: string; endpointGeneration: number; expiresAt: string }
  | { type: "open-ok"; stream: number }
  | { type: "open-failed"; stream: number; error: PreviewError }
  | { type: "eof"; stream: number }
  | { type: "closed"; stream: number }
  | { type: "credit"; stream: number; bytes: number }
  /** Without `stream`, the whole session is ending; a close frame follows. */
  | { type: "error"; stream?: number; error: PreviewError };

const CREDENTIAL = /^[A-Za-z0-9_-]{32,128}$/;

export function isPreviewTunnelStreamId(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_STREAM_ID
  );
}

function isCredit(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= PREVIEW_TUNNEL_MUX.windowBytes
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseControl(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > PREVIEW_LIMITS.controlFrameMaxBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isError(value: unknown): value is PreviewError {
  return (
    !!value &&
    typeof value === "object" &&
    isPreviewErrorCategory((value as PreviewError).category) &&
    typeof (value as PreviewError).message === "string" &&
    (value as PreviewError).message.length <= 1_000
  );
}

/** Strict: unknown types, extra fields (a host or port) and oversize frames are rejected. */
export function parsePreviewTunnelMuxClientFrame(text: string): PreviewTunnelMuxClientFrame | null {
  const frame = parseControl(text);
  if (!frame) return null;
  switch (frame.type) {
    case "hello":
      return exactKeys(frame, ["type", "version", "attachmentId", "credential"]) &&
        frame.version === PREVIEW_TUNNEL_MUX_VERSION &&
        isOpaquePreviewId(frame.attachmentId) &&
        typeof frame.credential === "string" &&
        CREDENTIAL.test(frame.credential)
        ? {
            type: "hello",
            version: PREVIEW_TUNNEL_MUX_VERSION,
            attachmentId: frame.attachmentId,
            credential: frame.credential,
          }
        : null;
    case "open":
    case "eof":
    case "cancel":
      return exactKeys(frame, ["type", "stream"]) && isPreviewTunnelStreamId(frame.stream)
        ? { type: frame.type, stream: frame.stream }
        : null;
    case "credit":
      return exactKeys(frame, ["type", "stream", "bytes"]) &&
        isPreviewTunnelStreamId(frame.stream) &&
        isCredit(frame.bytes)
        ? { type: "credit", stream: frame.stream, bytes: frame.bytes }
        : null;
    default:
      return null;
  }
}

export function parsePreviewTunnelMuxServerFrame(text: string): PreviewTunnelMuxServerFrame | null {
  const frame = parseControl(text);
  if (!frame) return null;
  switch (frame.type) {
    case "ready":
      return typeof frame.serviceId === "string" &&
        Number.isSafeInteger(frame.endpointGeneration) &&
        typeof frame.expiresAt === "string"
        ? {
            type: "ready",
            serviceId: frame.serviceId,
            endpointGeneration: frame.endpointGeneration as number,
            expiresAt: frame.expiresAt,
          }
        : null;
    case "open-ok":
    case "eof":
    case "closed":
      return isPreviewTunnelStreamId(frame.stream)
        ? { type: frame.type, stream: frame.stream }
        : null;
    case "credit":
      return isPreviewTunnelStreamId(frame.stream) && isCredit(frame.bytes)
        ? { type: "credit", stream: frame.stream, bytes: frame.bytes }
        : null;
    case "open-failed":
      return isPreviewTunnelStreamId(frame.stream) && isError(frame.error)
        ? {
            type: "open-failed",
            stream: frame.stream,
            error: previewError(frame.error.category, { message: frame.error.message }),
          }
        : null;
    case "error": {
      if (!isError(frame.error)) return null;
      const error = previewError(frame.error.category, { message: frame.error.message });
      if (frame.stream === undefined) return { type: "error", error };
      return isPreviewTunnelStreamId(frame.stream)
        ? { type: "error", stream: frame.stream, error }
        : null;
    }
    default:
      return null;
  }
}

export function encodePreviewTunnelMuxFrame(
  frame: PreviewTunnelMuxClientFrame | PreviewTunnelMuxServerFrame,
): string {
  return JSON.stringify(frame);
}

/** One binary message: the stream id, then at most `PREVIEW_TUNNEL_MUX_DATA_MAX_BYTES` of data. */
export function encodePreviewTunnelMuxData(stream: number, data: Uint8Array): Buffer {
  const message = Buffer.allocUnsafe(PREVIEW_TUNNEL_MUX.headerBytes + data.length);
  message.writeUInt32BE(stream, 0);
  message.set(data, PREVIEW_TUNNEL_MUX.headerBytes);
  return message;
}

/** Null for a message too short to name a stream, naming stream 0, or carrying no data. */
export function decodePreviewTunnelMuxData(
  message: Buffer,
): { stream: number; data: Buffer } | null {
  if (message.length <= PREVIEW_TUNNEL_MUX.headerBytes) return null;
  const stream = message.readUInt32BE(0);
  if (stream === 0) return null;
  return { stream, data: message.subarray(PREVIEW_TUNNEL_MUX.headerBytes) };
}

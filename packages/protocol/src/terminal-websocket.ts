/** Version 1 of the multiplexed gateway terminal protocol. */
export const TERMINAL_WEBSOCKET_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_WEBSOCKET_SUBPROTOCOL = "orkestrator-terminal.v1";
export const TERMINAL_WEBSOCKET_PATH = "/__orkestrator/terminal";

/** Control frames are deliberately small and never contain terminal bytes. */
export const TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES = 16 * 1024;
/** Includes the fixed header and raw terminal bytes. */
export const TERMINAL_WEBSOCKET_MAX_BINARY_BYTES = 256 * 1024;
export const TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES = 16;

/**
 * Outbound buffering is bounded both globally and per channel. The channel
 * soft limit is intentionally lower than the socket limit so one noisy
 * terminal is desynchronized before it can monopolize the connection.
 */
export const TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES = 2 * 1024 * 1024;
export const TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES = 8 * 1024 * 1024;
export const TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES = 512 * 1024;
export const TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES = 2 * 1024 * 1024;

export const TERMINAL_WEBSOCKET_CLOSE = {
  normal: 1000,
  unsupportedData: 1003,
  policyViolation: 1008,
  messageTooLarge: 1009,
  internalError: 1011,
  unsupportedVersion: 4001,
  authenticationRequired: 4003,
  protocolError: 4004,
  slowConsumer: 4008,
} as const;

export const TERMINAL_BINARY_FRAME_TYPE = {
  input: 1,
  output: 2,
} as const;

export type TerminalBinaryFrameType =
  (typeof TERMINAL_BINARY_FRAME_TYPE)[keyof typeof TERMINAL_BINARY_FRAME_TYPE];

export interface TerminalBinaryFrame {
  type: TerminalBinaryFrameType;
  /** Server-allocated, connection-local channel identifier. */
  channelId: number;
  /** Backend terminal generation. */
  generation: number;
  /** Input sequence for input frames; terminal output revision for output. */
  revision: number;
  bytes: Uint8Array;
}

export type TerminalWebSocketClientControlFrame =
  | {
      type: "authenticate";
      version: typeof TERMINAL_WEBSOCKET_PROTOCOL_VERSION;
      /** Required only when the HTTP upgrade did not carry an auth cookie. */
      token?: string;
    }
  | {
      type: "subscribe";
      requestId: number;
      sessionId: string;
      knownGeneration?: number;
      knownRevision?: number;
    }
  | { type: "unsubscribe"; channelId: number }
  | { type: "resize"; channelId: number; cols: number; rows: number }
  | { type: "ack"; channelId: number; generation: number; revision: number };

export type TerminalWebSocketServerControlFrame =
  | {
      type: "ready";
      version: typeof TERMINAL_WEBSOCKET_PROTOCOL_VERSION;
      socketId: string;
    }
  | {
      type: "subscribed";
      requestId: number;
      sessionId: string;
      channelId: number;
      generation: number;
      revision: number;
      recovery: "current" | "delta" | "snapshot-required";
    }
  | { type: "unsubscribed"; channelId: number }
  | {
      type: "lifecycle";
      channelId: number;
      state: "running" | "exited";
      generation: number;
      revision: number;
      exitCode?: number | null;
    }
  | {
      type: "desync";
      channelId: number;
      generation: number;
      revision: number;
      reason: "revision-gap" | "generation-changed" | "slow-consumer" | "reconnect";
    }
  | {
      type: "error";
      code:
        | "authentication-required"
        | "unsupported-version"
        | "malformed-frame"
        | "frame-too-large"
        | "unknown-channel"
        | "subscription-denied"
        | "terminal-unavailable"
        | "internal-error";
      message: string;
      requestId?: number;
      channelId?: number;
      fatal?: boolean;
    };

function assertUnsignedInteger(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be an unsigned integer no greater than ${max}`);
  }
}

/** Encode a raw terminal frame. All multi-byte integers use network byte order. */
export function encodeTerminalBinaryFrame(frame: TerminalBinaryFrame): Uint8Array {
  if (
    frame.type !== TERMINAL_BINARY_FRAME_TYPE.input
    && frame.type !== TERMINAL_BINARY_FRAME_TYPE.output
  ) {
    throw new RangeError("Unknown terminal binary frame type");
  }
  assertUnsignedInteger(frame.channelId, 0xffff, "channelId");
  assertUnsignedInteger(frame.generation, 0xffff_ffff, "generation");
  assertUnsignedInteger(frame.revision, Number.MAX_SAFE_INTEGER, "revision");
  const frameBytes = TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES + frame.bytes.byteLength;
  if (frameBytes > TERMINAL_WEBSOCKET_MAX_BINARY_BYTES) {
    throw new RangeError("Terminal binary frame exceeds the maximum size");
  }

  const encoded = new Uint8Array(frameBytes);
  const view = new DataView(encoded.buffer);
  view.setUint8(0, frame.type);
  // Byte 1 is reserved for flags and must stay zero in protocol v1.
  view.setUint16(2, frame.channelId, false);
  view.setUint32(4, frame.generation, false);
  view.setBigUint64(8, BigInt(frame.revision), false);
  encoded.set(frame.bytes, TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
  return encoded;
}

/** Decode and validate a complete v1 raw terminal frame. */
export function decodeTerminalBinaryFrame(data: ArrayBuffer | Uint8Array): TerminalBinaryFrame {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES) {
    throw new RangeError("Terminal binary frame is shorter than its header");
  }
  if (bytes.byteLength > TERMINAL_WEBSOCKET_MAX_BINARY_BYTES) {
    throw new RangeError("Terminal binary frame exceeds the maximum size");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = view.getUint8(0);
  if (
    type !== TERMINAL_BINARY_FRAME_TYPE.input
    && type !== TERMINAL_BINARY_FRAME_TYPE.output
  ) {
    throw new RangeError("Unknown terminal binary frame type");
  }
  if (view.getUint8(1) !== 0) {
    throw new RangeError("Terminal binary frame uses unsupported flags");
  }
  const revision = view.getBigUint64(8, false);
  if (revision > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Terminal binary frame revision exceeds the safe integer range");
  }
  return {
    type,
    channelId: view.getUint16(2, false),
    generation: view.getUint32(4, false),
    revision: Number(revision),
    bytes: bytes.slice(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES),
  };
}

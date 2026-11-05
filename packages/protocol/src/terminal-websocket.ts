/** Version 1 of the multiplexed gateway terminal protocol. */
export const TERMINAL_WEBSOCKET_PROTOCOL_VERSION = 1 as const;
export const TERMINAL_WEBSOCKET_SUBPROTOCOL = "orkestrator-terminal.v1";
/**
 * Version 1 with one difference: the server answers input that succeeded with
 * cumulative `input-results` frames rather than one `operation-result` each.
 */
export const TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL = "orkestrator-terminal.v1.input-results";
/**
 * What a client offers, preferred first. An older server selects the v1 entry,
 * and a client offering only v1 keeps one `operation-result` per input.
 */
export const TERMINAL_WEBSOCKET_CLIENT_SUBPROTOCOLS = [
  TERMINAL_WEBSOCKET_INPUT_RESULTS_SUBPROTOCOL,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
];
export const TERMINAL_WEBSOCKET_PATH = "/__orkestrator/terminal";

/** Control frames are deliberately small and never contain terminal bytes. */
export const TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES = 16 * 1024;
export const TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES = 1024;
export const TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES = 12 * 1024;
export const TERMINAL_WEBSOCKET_MAX_IDENTIFIER_BYTES = 512;
export const TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES = 4 * 1024;
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

type TerminalSubscriptionCursor =
  | { knownGeneration: number; knownRevision: number }
  | { knownGeneration?: never; knownRevision?: never };

export type TerminalWebSocketClientControlFrame =
  | {
      type: "authenticate";
      version: typeof TERMINAL_WEBSOCKET_PROTOCOL_VERSION;
      /** Required only when the HTTP upgrade did not carry an auth cookie. */
      token?: string;
    }
  | ({
      type: "subscribe";
      requestId: number;
      sessionId: string;
    } & TerminalSubscriptionCursor)
  | { type: "unsubscribe"; channelId: number }
  | {
      type: "resize";
      channelId: number;
      /** Connection-local operation identifier used to correlate completion. */
      operationId: number;
      cols: number;
      rows: number;
    }
  | { type: "ack"; channelId: number; generation: number; revision: number }
  /**
   * Liveness probe, answered by a `pong` carrying the same nonce. Send it only
   * to a server whose `ready` frame listed the `ping` feature: an older server
   * treats an unknown frame type as a fatal protocol error.
   */
  | { type: "ping"; nonce: number };

/**
 * Optional behaviour a server advertises in its `ready` frame. A client must
 * ignore names it does not know, so a server can add one without a version bump.
 */
export const TERMINAL_WEBSOCKET_FEATURES = ["ping"] as const;
export type TerminalWebSocketFeature = (typeof TERMINAL_WEBSOCKET_FEATURES)[number];
const MAX_ADVERTISED_FEATURES = 32;

type TerminalSubscribedFrameBase = {
  type: "subscribed";
  requestId: number;
  sessionId: string;
  channelId: number;
  /** Server cursor captured before retained/concurrent output is flushed. */
  targetGeneration: number;
  targetRevision: number;
};

/**
 * `base*` is the cursor the client had already applied before subscribing.
 * `target*` is informational and MUST NOT advance the client's applied cursor;
 * replayed output frames (or an authoritative snapshot) do that.
 */
export type TerminalSubscribedFrame =
  | (TerminalSubscribedFrameBase & {
      recovery: "current" | "delta";
      baseGeneration: number;
      baseRevision: number;
    })
  | (TerminalSubscribedFrameBase & {
      recovery: "snapshot-required";
      baseGeneration: null;
      baseRevision: null;
    });

export type TerminalWebSocketServerControlFrame =
  | {
      type: "ready";
      version: typeof TERMINAL_WEBSOCKET_PROTOCOL_VERSION;
      socketId: string;
      /** Absent from servers that predate it; unknown names are dropped on parse. */
      features?: TerminalWebSocketFeature[];
    }
  | TerminalSubscribedFrame
  | { type: "pong"; nonce: number }
  | { type: "unsubscribed"; channelId: number }
  /**
   * Every input on this channel up to and including `throughOperationId` that
   * has not already had a failed `operation-result` succeeded. Input on one
   * channel completes in id order and a failure is queued before any later
   * result, so this can never cover an input still in flight or about to fail.
   * Sent only on the input-results subprotocol.
   */
  | { type: "input-results"; channelId: number; throughOperationId: number }
  | {
      type: "operation-result";
      channelId: number;
      operationId: number;
      operation: "input" | "resize";
      ok: true;
    }
  | {
      type: "operation-result";
      channelId: number;
      operationId: number;
      operation: "input" | "resize";
      ok: false;
      message: string;
    }
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

export type TerminalWebSocketControlFrameErrorCode =
  "frame-too-large" | "malformed-frame" | "unsupported-version";

/** A wire-validation failure that maps directly to a protocol error code. */
export class TerminalWebSocketControlFrameError extends Error {
  readonly code: TerminalWebSocketControlFrameErrorCode;

  constructor(code: TerminalWebSocketControlFrameErrorCode, message: string) {
    super(message);
    this.name = "TerminalWebSocketControlFrameError";
    this.code = code;
  }
}

type JsonObject = Record<string, unknown>;

const utf8Encoder = new TextEncoder();

function malformed(message: string): never {
  throw new TerminalWebSocketControlFrameError("malformed-frame", message);
}

function tooLarge(): never {
  throw new TerminalWebSocketControlFrameError(
    "frame-too-large",
    "Terminal WebSocket control frame exceeds the maximum size",
  );
}

function parseControlObject(text: string): JsonObject {
  if (typeof text !== "string") {
    return malformed("Terminal WebSocket control frame must be text");
  }
  // UTF-8 never encodes a string to fewer bytes than it has UTF-16 code units,
  // so this rejects an oversized frame without first encoding it. Measuring by
  // encoding alone would let an attacker force an allocation proportional to
  // whatever they sent, just to discover it was over the limit.
  if (text.length > TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES) tooLarge();
  if (utf8Encoder.encode(text).byteLength > TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES) tooLarge();
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    return malformed("Terminal WebSocket control frame is not valid JSON");
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    return malformed("Terminal WebSocket control frame must be a JSON object");
  }
  return decoded as JsonObject;
}

function readString(
  object: JsonObject,
  key: string,
  maxBytes: number,
  options: { optional?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  const value = object[key];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") return malformed(`${key} must be a string`);
  const byteLength = utf8Encoder.encode(value).byteLength;
  if ((!options.allowEmpty && byteLength === 0) || byteLength > maxBytes) {
    return malformed(`${key} must contain 1 to ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function readBoolean(object: JsonObject, key: string, optional = false): boolean | undefined {
  const value = object[key];
  if (value === undefined && optional) return undefined;
  if (typeof value !== "boolean") return malformed(`${key} must be a boolean`);
  return value;
}

function readInteger(
  object: JsonObject,
  key: string,
  minimum: number,
  maximum: number,
  optional = false,
): number | undefined {
  const value = object[key];
  if (value === undefined && optional) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return malformed(`${key} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function readLiteral<T extends string>(object: JsonObject, key: string, values: readonly T[]): T {
  const value = object[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    return malformed(`${key} has an unsupported value`);
  }
  return value as T;
}

function readVersion(object: JsonObject): typeof TERMINAL_WEBSOCKET_PROTOCOL_VERSION {
  const version = object.version;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) {
    return malformed("version must be an unsigned integer");
  }
  if (version !== TERMINAL_WEBSOCKET_PROTOCOL_VERSION) {
    throw new TerminalWebSocketControlFrameError(
      "unsupported-version",
      "Terminal WebSocket protocol version is unsupported",
    );
  }
  return TERMINAL_WEBSOCKET_PROTOCOL_VERSION;
}

const readChannelId = (object: JsonObject): number =>
  readInteger(object, "channelId", 0, 0xffff) as number;
const readGeneration = (object: JsonObject, key = "generation"): number =>
  readInteger(object, key, 0, 0xffff_ffff) as number;
const readRevision = (object: JsonObject, key = "revision"): number =>
  readInteger(object, key, 0, Number.MAX_SAFE_INTEGER) as number;
const readRequestId = (object: JsonObject): number =>
  readInteger(object, "requestId", 0, Number.MAX_SAFE_INTEGER) as number;
const readNonce = (object: JsonObject): number =>
  readInteger(object, "nonce", 0, Number.MAX_SAFE_INTEGER) as number;

function readFeatures(object: JsonObject): TerminalWebSocketFeature[] | undefined {
  const value = object.features;
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ADVERTISED_FEATURES) {
    return malformed("features must be an array of at most 32 names");
  }
  const features: TerminalWebSocketFeature[] = [];
  for (const name of value) {
    if (typeof name !== "string") return malformed("features must contain only names");
    if (
      (TERMINAL_WEBSOCKET_FEATURES as readonly string[]).includes(name) &&
      !features.includes(name as TerminalWebSocketFeature)
    ) {
      features.push(name as TerminalWebSocketFeature);
    }
  }
  return features;
}

/** Parse and validate one complete client-to-server JSON control frame. */
export function parseTerminalWebSocketClientControlFrame(
  text: string,
): TerminalWebSocketClientControlFrame {
  const object = parseControlObject(text);
  const type = readLiteral(object, "type", [
    "authenticate",
    "subscribe",
    "unsubscribe",
    "resize",
    "ack",
    "ping",
  ]);
  switch (type) {
    case "authenticate": {
      const token = readString(object, "token", TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES, {
        optional: true,
      });
      return {
        type,
        version: readVersion(object),
        ...(token === undefined ? {} : { token }),
      };
    }
    case "subscribe": {
      const requestId = readRequestId(object);
      const sessionId = readString(
        object,
        "sessionId",
        TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES,
      ) as string;
      const hasGeneration = object.knownGeneration !== undefined;
      const hasRevision = object.knownRevision !== undefined;
      if (hasGeneration !== hasRevision) {
        return malformed("knownGeneration and knownRevision must be supplied together");
      }
      if (!hasGeneration) return { type, requestId, sessionId };
      return {
        type,
        requestId,
        sessionId,
        knownGeneration: readGeneration(object, "knownGeneration"),
        knownRevision: readRevision(object, "knownRevision"),
      };
    }
    case "unsubscribe":
      return { type, channelId: readChannelId(object) };
    case "resize":
      return {
        type,
        channelId: readChannelId(object),
        operationId: readInteger(object, "operationId", 0, Number.MAX_SAFE_INTEGER) as number,
        cols: readInteger(object, "cols", 1, 0xffff) as number,
        rows: readInteger(object, "rows", 1, 0xffff) as number,
      };
    case "ack":
      return {
        type,
        channelId: readChannelId(object),
        generation: readGeneration(object),
        revision: readRevision(object),
      };
    case "ping":
      return { type, nonce: readNonce(object) };
  }
}

const ERROR_CODES = [
  "authentication-required",
  "unsupported-version",
  "malformed-frame",
  "frame-too-large",
  "unknown-channel",
  "subscription-denied",
  "terminal-unavailable",
  "internal-error",
] as const;

/** Parse and validate one complete server-to-client JSON control frame. */
export function parseTerminalWebSocketServerControlFrame(
  text: string,
): TerminalWebSocketServerControlFrame {
  const object = parseControlObject(text);
  const type = readLiteral(object, "type", [
    "ready",
    "subscribed",
    "unsubscribed",
    "input-results",
    "operation-result",
    "lifecycle",
    "desync",
    "error",
    "pong",
  ]);
  switch (type) {
    case "ready": {
      const features = readFeatures(object);
      return {
        type,
        version: readVersion(object),
        socketId: readString(object, "socketId", TERMINAL_WEBSOCKET_MAX_IDENTIFIER_BYTES) as string,
        ...(features === undefined ? {} : { features }),
      };
    }
    case "pong":
      return { type, nonce: readNonce(object) };
    case "subscribed": {
      const common: TerminalSubscribedFrameBase = {
        type,
        requestId: readRequestId(object),
        sessionId: readString(
          object,
          "sessionId",
          TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES,
        ) as string,
        channelId: readChannelId(object),
        targetGeneration: readGeneration(object, "targetGeneration"),
        targetRevision: readRevision(object, "targetRevision"),
      };
      const recovery = readLiteral(object, "recovery", ["current", "delta", "snapshot-required"]);
      if (recovery === "snapshot-required") {
        if (object.baseGeneration !== null || object.baseRevision !== null) {
          return malformed("snapshot-required subscriptions must use null base cursors");
        }
        return { ...common, recovery, baseGeneration: null, baseRevision: null };
      }
      const frame: TerminalSubscribedFrame = {
        ...common,
        recovery,
        baseGeneration: readGeneration(object, "baseGeneration"),
        baseRevision: readRevision(object, "baseRevision"),
      };
      if (frame.baseGeneration !== frame.targetGeneration) {
        return malformed(`${recovery} subscriptions must keep one generation`);
      }
      if (recovery === "current" && frame.baseRevision !== frame.targetRevision) {
        return malformed("current subscriptions must use identical base and target cursors");
      }
      if (recovery === "delta" && frame.baseRevision >= frame.targetRevision) {
        return malformed("delta subscriptions must advance beyond the base cursor");
      }
      return frame;
    }
    case "unsubscribed":
      return { type, channelId: readChannelId(object) };
    case "input-results":
      return {
        type,
        channelId: readChannelId(object),
        throughOperationId: readInteger(
          object,
          "throughOperationId",
          0,
          Number.MAX_SAFE_INTEGER,
        ) as number,
      };
    case "operation-result": {
      const common = {
        type,
        channelId: readChannelId(object),
        operationId: readInteger(object, "operationId", 0, Number.MAX_SAFE_INTEGER) as number,
        operation: readLiteral(object, "operation", ["input", "resize"]),
      };
      const ok = readBoolean(object, "ok") as boolean;
      if (ok) return { ...common, ok };
      return {
        ...common,
        ok,
        message: readString(object, "message", TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES, {
          allowEmpty: true,
        }) as string,
      };
    }
    case "lifecycle": {
      const exitCodeValue = object.exitCode;
      let exitCode: number | null | undefined;
      if (exitCodeValue === null) exitCode = null;
      else exitCode = readInteger(object, "exitCode", -0x8000_0000, 0x7fff_ffff, true);
      return {
        type,
        channelId: readChannelId(object),
        state: readLiteral(object, "state", ["running", "exited"]),
        generation: readGeneration(object),
        revision: readRevision(object),
        ...(exitCode === undefined ? {} : { exitCode }),
      };
    }
    case "desync":
      return {
        type,
        channelId: readChannelId(object),
        generation: readGeneration(object),
        revision: readRevision(object),
        reason: readLiteral(object, "reason", [
          "revision-gap",
          "generation-changed",
          "slow-consumer",
          "reconnect",
        ]),
      };
    case "error": {
      const requestId = readInteger(object, "requestId", 0, Number.MAX_SAFE_INTEGER, true);
      const channelId = readInteger(object, "channelId", 0, 0xffff, true);
      const fatal = readBoolean(object, "fatal", true);
      return {
        type,
        code: readLiteral(object, "code", ERROR_CODES),
        message: readString(object, "message", TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES, {
          allowEmpty: true,
        }) as string,
        ...(requestId === undefined ? {} : { requestId }),
        ...(channelId === undefined ? {} : { channelId }),
        ...(fatal === undefined ? {} : { fatal }),
      };
    }
  }
}

function assertUnsignedInteger(value: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} must be an unsigned integer no greater than ${max}`);
  }
}

/** Encode a raw terminal frame. All multi-byte integers use network byte order. */
export function encodeTerminalBinaryFrame(frame: TerminalBinaryFrame): Uint8Array<ArrayBuffer> {
  if (
    frame.type !== TERMINAL_BINARY_FRAME_TYPE.input &&
    frame.type !== TERMINAL_BINARY_FRAME_TYPE.output
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
  if (type !== TERMINAL_BINARY_FRAME_TYPE.input && type !== TERMINAL_BINARY_FRAME_TYPE.output) {
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

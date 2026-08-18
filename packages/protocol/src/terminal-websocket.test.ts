import { describe, expect, test } from "bun:test";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  parseTerminalWebSocketClientControlFrame,
  parseTerminalWebSocketServerControlFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
  TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_CLOSE,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
  TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES,
  TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES,
  TERMINAL_WEBSOCKET_MAX_IDENTIFIER_BYTES,
  TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES,
  TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES,
  TERMINAL_WEBSOCKET_PATH,
  TERMINAL_WEBSOCKET_PROTOCOL_VERSION,
  TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
  TERMINAL_WEBSOCKET_SUBPROTOCOL,
  TerminalWebSocketControlFrameError,
  type TerminalWebSocketClientControlFrame,
} from "@orkestrator/protocol/terminal-websocket";

const encodeJson = (value: unknown): string => JSON.stringify(value);

function expectControlError(
  parse: (text: string) => unknown,
  value: string | object,
  code: TerminalWebSocketControlFrameError["code"],
): void {
  try {
    parse(typeof value === "string" ? value : encodeJson(value));
    throw new Error("Expected control-frame parsing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TerminalWebSocketControlFrameError);
    expect((error as TerminalWebSocketControlFrameError).code).toBe(code);
  }
}

describe("terminal WebSocket client control protocol", () => {
  test("parses every client frame and ignores unknown fields", () => {
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "authenticate",
          version: 1,
          token: "secret-token",
          future: true,
        }),
      ),
    ).toEqual({ type: "authenticate", version: 1, token: "secret-token" });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "authenticate",
          version: 1,
        }),
      ),
    ).toEqual({ type: "authenticate", version: 1 });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "subscribe",
          requestId: 0,
          sessionId: "session-a",
        }),
      ),
    ).toEqual({ type: "subscribe", requestId: 0, sessionId: "session-a" });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "subscribe",
          requestId: Number.MAX_SAFE_INTEGER,
          sessionId: "session-a",
          knownGeneration: 0xffff_ffff,
          knownRevision: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toEqual({
      type: "subscribe",
      requestId: Number.MAX_SAFE_INTEGER,
      sessionId: "session-a",
      knownGeneration: 0xffff_ffff,
      knownRevision: Number.MAX_SAFE_INTEGER,
    });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "unsubscribe",
          channelId: 0xffff,
        }),
      ),
    ).toEqual({ type: "unsubscribe", channelId: 0xffff });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "resize",
          channelId: 0,
          operationId: 3,
          cols: 1,
          rows: 0xffff,
        }),
      ),
    ).toEqual({ type: "resize", channelId: 0, operationId: 3, cols: 1, rows: 0xffff });
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "ack",
          channelId: 4,
          generation: 7,
          revision: 9,
        }),
      ),
    ).toEqual({ type: "ack", channelId: 4, generation: 7, revision: 9 });
  });

  test("makes a subscribe recovery cursor both-or-neither in types and at runtime", () => {
    const withoutCursor = {
      type: "subscribe",
      requestId: 1,
      sessionId: "session-a",
    } satisfies TerminalWebSocketClientControlFrame;
    const withCursor = {
      ...withoutCursor,
      knownGeneration: 2,
      knownRevision: 3,
    } satisfies TerminalWebSocketClientControlFrame;
    expect(withoutCursor.type).toBe("subscribe");
    expect(withCursor.knownRevision).toBe(3);

    // @ts-expect-error recovery cursors are an atomic generation/revision pair
    const partialCursor: TerminalWebSocketClientControlFrame = {
      ...withoutCursor,
      knownGeneration: 2,
    };
    expect(Reflect.get(partialCursor, "knownGeneration")).toBe(2);

    for (const partial of [{ knownGeneration: 2 }, { knownRevision: 3 }]) {
      expectControlError(
        parseTerminalWebSocketClientControlFrame,
        {
          ...withoutCursor,
          ...partial,
        },
        "malformed-frame",
      );
    }
  });

  test("distinguishes a post-upgrade version mismatch", () => {
    expectControlError(
      parseTerminalWebSocketClientControlFrame,
      {
        type: "authenticate",
        version: 2,
      },
      "unsupported-version",
    );
    for (const version of [undefined, null, "1", -1, 1.5]) {
      expectControlError(
        parseTerminalWebSocketClientControlFrame,
        {
          type: "authenticate",
          ...(version === undefined ? {} : { version }),
        },
        "malformed-frame",
      );
    }
  });

  test("enforces common shape, JSON, and UTF-8 byte limits", () => {
    for (const invalid of ["", "{", "null", "[]", "1", "true"]) {
      expectControlError(parseTerminalWebSocketClientControlFrame, invalid, "malformed-frame");
    }
    expectControlError(
      parseTerminalWebSocketClientControlFrame,
      { type: "future" },
      "malformed-frame",
    );
    expectControlError(
      parseTerminalWebSocketClientControlFrame,
      `{"type":"authenticate","version":1,"padding":"${"é".repeat(TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES)}"}`,
      "frame-too-large",
    );
  });

  test("enforces client string limits", () => {
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "authenticate",
          version: 1,
          token: "t".repeat(TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES),
        }),
      ),
    ).toHaveProperty("token");
    expectControlError(
      parseTerminalWebSocketClientControlFrame,
      {
        type: "authenticate",
        version: 1,
        token: "t".repeat(TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES + 1),
      },
      "malformed-frame",
    );
    for (const sessionId of ["", "s".repeat(TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES + 1)]) {
      expectControlError(
        parseTerminalWebSocketClientControlFrame,
        {
          type: "subscribe",
          requestId: 1,
          sessionId,
        },
        "malformed-frame",
      );
    }
  });

  test("enforces client numeric and scalar field limits", () => {
    const cases = [
      { type: "subscribe", requestId: -1, sessionId: "s" },
      { type: "subscribe", requestId: 1.5, sessionId: "s" },
      { type: "subscribe", requestId: Number.MAX_SAFE_INTEGER + 1, sessionId: "s" },
      {
        type: "subscribe",
        requestId: 1,
        sessionId: "s",
        knownGeneration: 0x1_0000_0000,
        knownRevision: 1,
      },
      {
        type: "subscribe",
        requestId: 1,
        sessionId: "s",
        knownGeneration: 1,
        knownRevision: Number.MAX_SAFE_INTEGER + 1,
      },
      { type: "unsubscribe", channelId: -1 },
      { type: "unsubscribe", channelId: 0x1_0000 },
      { type: "resize", channelId: 1, operationId: 1, cols: 0, rows: 10 },
      { type: "resize", channelId: 1, operationId: 1, cols: 10, rows: 0x1_0000 },
      { type: "resize", channelId: 1, cols: 10, rows: 10 },
      { type: "resize", channelId: 1, operationId: -1, cols: 10, rows: 10 },
      { type: "ack", channelId: 1, generation: -1, revision: 1 },
      { type: "ack", channelId: 1, generation: 1, revision: -1 },
      { type: "ack", channelId: "1", generation: 1, revision: 1 },
    ];
    for (const frame of cases) {
      expectControlError(parseTerminalWebSocketClientControlFrame, frame, "malformed-frame");
    }
  });
});

describe("terminal WebSocket server control protocol", () => {
  test("parses ready and replay-safe subscribed frames", () => {
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "ready",
          version: 1,
          socketId: "socket-a",
        }),
      ),
    ).toEqual({ type: "ready", version: 1, socketId: "socket-a" });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "subscribed",
          requestId: 1,
          sessionId: "session-a",
          channelId: 2,
          baseGeneration: 3,
          baseRevision: 4,
          targetGeneration: 3,
          targetRevision: 8,
          recovery: "delta",
        }),
      ),
    ).toEqual({
      type: "subscribed",
      requestId: 1,
      sessionId: "session-a",
      channelId: 2,
      baseGeneration: 3,
      baseRevision: 4,
      targetGeneration: 3,
      targetRevision: 8,
      recovery: "delta",
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "subscribed",
          requestId: 1,
          sessionId: "session-a",
          channelId: 2,
          baseGeneration: 3,
          baseRevision: 8,
          targetGeneration: 3,
          targetRevision: 8,
          recovery: "current",
        }),
      ),
    ).toHaveProperty("recovery", "current");
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "subscribed",
          requestId: 2,
          sessionId: "session-b",
          channelId: 3,
          baseGeneration: null,
          baseRevision: null,
          targetGeneration: 9,
          targetRevision: 10,
          recovery: "snapshot-required",
        }),
      ),
    ).toEqual({
      type: "subscribed",
      requestId: 2,
      sessionId: "session-b",
      channelId: 3,
      baseGeneration: null,
      baseRevision: null,
      targetGeneration: 9,
      targetRevision: 10,
      recovery: "snapshot-required",
    });
  });

  test("rejects ambiguous subscribed cursor combinations", () => {
    const base = {
      type: "subscribed",
      requestId: 1,
      sessionId: "session-a",
      channelId: 2,
      targetGeneration: 3,
      targetRevision: 8,
    };
    for (const frame of [
      { ...base, recovery: "delta", baseGeneration: null, baseRevision: null },
      { ...base, recovery: "current", baseGeneration: 3 },
      { ...base, recovery: "current", baseGeneration: 3, baseRevision: 7 },
      { ...base, recovery: "delta", baseGeneration: 4, baseRevision: 7 },
      { ...base, recovery: "delta", baseGeneration: 3, baseRevision: 8 },
      { ...base, recovery: "delta", baseGeneration: 3, baseRevision: 9 },
      { ...base, recovery: "snapshot-required", baseGeneration: 3, baseRevision: 8 },
      { ...base, recovery: "snapshot-required", baseGeneration: null, baseRevision: 8 },
    ]) {
      expectControlError(parseTerminalWebSocketServerControlFrame, frame, "malformed-frame");
    }
  });

  test("parses every other server frame and optional field", () => {
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "unsubscribed",
          channelId: 1,
        }),
      ),
    ).toEqual({ type: "unsubscribed", channelId: 1 });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "operation-result",
          channelId: 1,
          operationId: 7,
          operation: "input",
          ok: true,
        }),
      ),
    ).toEqual({
      type: "operation-result",
      channelId: 1,
      operationId: 7,
      operation: "input",
      ok: true,
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "operation-result",
          channelId: 1,
          operationId: 8,
          operation: "resize",
          ok: false,
          message: "backend unavailable",
        }),
      ),
    ).toEqual({
      type: "operation-result",
      channelId: 1,
      operationId: 8,
      operation: "resize",
      ok: false,
      message: "backend unavailable",
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "lifecycle",
          channelId: 2,
          state: "running",
          generation: 3,
          revision: 4,
        }),
      ),
    ).toEqual({ type: "lifecycle", channelId: 2, state: "running", generation: 3, revision: 4 });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "lifecycle",
          channelId: 2,
          state: "exited",
          generation: 3,
          revision: 4,
          exitCode: null,
        }),
      ),
    ).toEqual({
      type: "lifecycle",
      channelId: 2,
      state: "exited",
      generation: 3,
      revision: 4,
      exitCode: null,
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "lifecycle",
          channelId: 2,
          state: "exited",
          generation: 3,
          revision: 4,
          exitCode: -2_147_483_648,
        }),
      ),
    ).toHaveProperty("exitCode", -2_147_483_648);
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "desync",
          channelId: 4,
          generation: 5,
          revision: 6,
          reason: "slow-consumer",
        }),
      ),
    ).toEqual({
      type: "desync",
      channelId: 4,
      generation: 5,
      revision: 6,
      reason: "slow-consumer",
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "error",
          code: "unknown-channel",
          message: "gone",
          requestId: 7,
          channelId: 8,
          fatal: false,
          future: "ignored",
        }),
      ),
    ).toEqual({
      type: "error",
      code: "unknown-channel",
      message: "gone",
      requestId: 7,
      channelId: 8,
      fatal: false,
    });
    expect(
      parseTerminalWebSocketServerControlFrame(
        encodeJson({
          type: "error",
          code: "internal-error",
          message: "",
        }),
      ),
    ).toEqual({ type: "error", code: "internal-error", message: "" });
  });

  test("enforces server versions, literals, identifiers, messages, and numbers", () => {
    expectControlError(
      parseTerminalWebSocketServerControlFrame,
      {
        type: "ready",
        version: 2,
        socketId: "socket-a",
      },
      "unsupported-version",
    );
    const invalid = [
      { type: "ready", version: 1, socketId: "" },
      {
        type: "ready",
        version: 1,
        socketId: "s".repeat(TERMINAL_WEBSOCKET_MAX_IDENTIFIER_BYTES + 1),
      },
      { type: "unsubscribed", channelId: 65_536 },
      { type: "operation-result", channelId: 1, operationId: 1, operation: "write", ok: true },
      { type: "operation-result", channelId: 1, operationId: -1, operation: "input", ok: true },
      { type: "operation-result", channelId: 1, operationId: 1, operation: "input", ok: 1 },
      { type: "operation-result", channelId: 1, operationId: 1, operation: "input", ok: false },
      {
        type: "operation-result",
        channelId: 1,
        operationId: 1,
        operation: "input",
        ok: false,
        message: "x".repeat(TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES + 1),
      },
      { type: "lifecycle", channelId: 1, state: "paused", generation: 1, revision: 1 },
      {
        type: "lifecycle",
        channelId: 1,
        state: "exited",
        generation: 1,
        revision: 1,
        exitCode: 2_147_483_648,
      },
      { type: "desync", channelId: 1, generation: 1, revision: 1, reason: "other" },
      { type: "error", code: "other", message: "bad" },
      {
        type: "error",
        code: "internal-error",
        message: "x".repeat(TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES + 1),
      },
      { type: "error", code: "internal-error", message: "bad", fatal: 1 },
    ];
    for (const frame of invalid) {
      expectControlError(parseTerminalWebSocketServerControlFrame, frame, "malformed-frame");
    }
  });
});

describe("terminal WebSocket control protocol field validation", () => {
  test("requires a non-empty string token when one is supplied", () => {
    for (const token of ["", 1, null, {}]) {
      expectControlError(
        parseTerminalWebSocketClientControlFrame,
        {
          type: "authenticate",
          version: 1,
          token,
        },
        "malformed-frame",
      );
    }
    expect(
      parseTerminalWebSocketClientControlFrame(
        encodeJson({
          type: "authenticate",
          version: 1,
        }),
      ),
    ).toEqual({ type: "authenticate", version: 1 });
  });

  test("rejects an unrecognized subscribed recovery mode", () => {
    for (const recovery of ["resume", "", 1, null]) {
      expectControlError(
        parseTerminalWebSocketServerControlFrame,
        {
          type: "subscribed",
          requestId: 1,
          sessionId: "s",
          channelId: 1,
          targetGeneration: 2,
          targetRevision: 9,
          baseGeneration: 2,
          baseRevision: 9,
          recovery,
        },
        "malformed-frame",
      );
    }
  });

  test("validates the optional identifiers on a server error frame", () => {
    for (const partial of [
      { requestId: -1 },
      { requestId: 1.5 },
      { requestId: Number.MAX_SAFE_INTEGER + 1 },
      { channelId: -1 },
      { channelId: 0x1_0000 },
      { channelId: "1" },
    ]) {
      expectControlError(
        parseTerminalWebSocketServerControlFrame,
        {
          type: "error",
          code: "internal-error",
          message: "boom",
          ...partial,
        },
        "malformed-frame",
      );
    }
  });

  test("validates the version on a server ready frame", () => {
    for (const version of [undefined, null, "1", -1, 1.5]) {
      expectControlError(
        parseTerminalWebSocketServerControlFrame,
        {
          type: "ready",
          socketId: "socket-1",
          ...(version === undefined ? {} : { version }),
        },
        "malformed-frame",
      );
    }
    expectControlError(
      parseTerminalWebSocketServerControlFrame,
      {
        type: "ready",
        socketId: "socket-1",
        version: 2,
      },
      "unsupported-version",
    );
  });
});

describe("terminal WebSocket control protocol shared boundary", () => {
  const parsers = [
    ["client", parseTerminalWebSocketClientControlFrame],
    ["server", parseTerminalWebSocketServerControlFrame],
  ] as const;

  test("rejects non-text frames handed straight off a socket", () => {
    for (const [, parse] of parsers) {
      for (const value of [undefined, null, 42, new Uint8Array([1, 2, 3]), new ArrayBuffer(4)]) {
        expectControlError(parse as (text: string) => unknown, value as never, "malformed-frame");
      }
    }
  });

  test("enforces shape, JSON, and size limits on both directions", () => {
    for (const [, parse] of parsers) {
      for (const invalid of ["", "{", "null", "[]", "1", "true", '"text"']) {
        expectControlError(parse, invalid, "malformed-frame");
      }
      expectControlError(
        parse,
        `{"type":"ready","version":1,"socketId":"${"é".repeat(TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES)}"}`,
        "frame-too-large",
      );
    }
  });

  test("rejects an oversized frame without encoding it first", () => {
    // A frame far beyond the limit must be refused on its code-unit length, so
    // an attacker cannot force an allocation proportional to what they sent.
    const oversized = `{"type":"ready","version":1,"socketId":"${"a".repeat(4 * 1024 * 1024)}"}`;
    for (const [, parse] of parsers) {
      expectControlError(parse, oversized, "frame-too-large");
    }
  });

  test("accepts a frame at exactly the control byte limit", () => {
    const base = { type: "ready", version: 1, socketId: "socket-1", padding: "" };
    const padding = TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES - encodeJson(base).length;
    const frame = encodeJson({ ...base, padding: "p".repeat(padding) });
    expect(frame.length).toBe(TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES);
    expect(parseTerminalWebSocketServerControlFrame(frame)).toEqual({
      type: "ready",
      version: 1,
      socketId: "socket-1",
    });

    const oneOver = encodeJson({ ...base, padding: "p".repeat(padding + 1) });
    expectControlError(parseTerminalWebSocketServerControlFrame, oneOver, "frame-too-large");
  });
});

describe("terminal WebSocket protocol constants", () => {
  test("pins the negotiated identity of version 1", () => {
    expect(TERMINAL_WEBSOCKET_PROTOCOL_VERSION).toBe(1);
    expect(TERMINAL_WEBSOCKET_SUBPROTOCOL).toBe("orkestrator-terminal.v1");
    expect(TERMINAL_WEBSOCKET_PATH).toBe("/__orkestrator/terminal");
  });

  test("pins every close code the specification assigns", () => {
    expect(TERMINAL_WEBSOCKET_CLOSE).toEqual({
      normal: 1000,
      unsupportedData: 1003,
      policyViolation: 1008,
      messageTooLarge: 1009,
      internalError: 1011,
      unsupportedVersion: 4001,
      authenticationRequired: 4003,
      protocolError: 4004,
      slowConsumer: 4008,
    });
  });

  test("keeps a channel bounded well inside the socket it shares", () => {
    // One noisy terminal must desynchronize before it can monopolize the socket,
    // which only holds while the channel soft limit is the first to be crossed.
    expect(TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES).toBeLessThan(
      TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES,
    );
    expect(TERMINAL_WEBSOCKET_CHANNEL_SOFT_BUFFER_BYTES).toBeLessThan(
      TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
    );
    expect(TERMINAL_WEBSOCKET_CHANNEL_HARD_BUFFER_BYTES).toBeLessThanOrEqual(
      TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES,
    );
    expect(TERMINAL_WEBSOCKET_SOCKET_SOFT_BUFFER_BYTES).toBeLessThan(
      TERMINAL_WEBSOCKET_SOCKET_HARD_BUFFER_BYTES,
    );
  });

  test("keeps every control field inside one control frame", () => {
    for (const limit of [
      TERMINAL_WEBSOCKET_MAX_SESSION_ID_BYTES,
      TERMINAL_WEBSOCKET_MAX_TOKEN_BYTES,
      TERMINAL_WEBSOCKET_MAX_IDENTIFIER_BYTES,
      TERMINAL_WEBSOCKET_MAX_ERROR_MESSAGE_BYTES,
    ]) {
      expect(limit).toBeLessThan(TERMINAL_WEBSOCKET_MAX_CONTROL_BYTES);
    }
    expect(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES).toBeLessThan(
      TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
    );
  });
});

describe("terminal WebSocket binary protocol", () => {
  test("round trips input and output frames including zero-length payloads", () => {
    for (const type of [TERMINAL_BINARY_FRAME_TYPE.input, TERMINAL_BINARY_FRAME_TYPE.output]) {
      const encoded = encodeTerminalBinaryFrame({
        type,
        channelId: 513,
        generation: 17,
        revision: 9_007_199_254_740_000,
        bytes:
          type === TERMINAL_BINARY_FRAME_TYPE.input
            ? new Uint8Array()
            : new Uint8Array([0, 27, 91, 65, 255]),
      });
      expect(decodeTerminalBinaryFrame(encoded)).toEqual({
        type,
        channelId: 513,
        generation: 17,
        revision: 9_007_199_254_740_000,
        bytes:
          type === TERMINAL_BINARY_FRAME_TYPE.input
            ? new Uint8Array()
            : new Uint8Array([0, 27, 91, 65, 255]),
      });
    }
  });

  test("uses an exact 16-byte big-endian header", () => {
    const encoded = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 0x1234,
      generation: 0x5678_9abc,
      revision: 0x12_3456_789a,
      bytes: new Uint8Array([0xfe]),
    });
    expect([...encoded]).toEqual([
      2, 0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0, 0, 0, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xfe,
    ]);
  });

  test("accepts ArrayBuffer and non-zero-offset Uint8Array inputs", () => {
    const encoded = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 2,
      generation: 3,
      revision: 4,
      bytes: new Uint8Array([5, 6]),
    });
    const arrayBuffer = new Uint8Array(encoded).buffer as ArrayBuffer;
    expect(decodeTerminalBinaryFrame(arrayBuffer).bytes).toEqual(new Uint8Array([5, 6]));

    const container = new Uint8Array(encoded.byteLength + 7);
    container.set(encoded, 3);
    const offsetView = container.subarray(3, 3 + encoded.byteLength);
    expect(decodeTerminalBinaryFrame(offsetView)).toEqual({
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 2,
      generation: 3,
      revision: 4,
      bytes: new Uint8Array([5, 6]),
    });
  });

  test("copies payload bytes on encode and decode", () => {
    const source = new Uint8Array([10, 11]);
    const encoded = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 1,
      generation: 1,
      revision: 1,
      bytes: source,
    });
    source[0] = 99;
    expect(encoded[TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES]).toBe(10);

    const decoded = decodeTerminalBinaryFrame(encoded);
    encoded[TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES + 1] = 88;
    expect(decoded.bytes).toEqual(new Uint8Array([10, 11]));
  });

  test("accepts the exact maximum frame size", () => {
    const encoded = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 0xffff,
      generation: 0xffff_ffff,
      revision: Number.MAX_SAFE_INTEGER,
      bytes: new Uint8Array(
        TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
      ),
    });
    expect(encoded.byteLength).toBe(TERMINAL_WEBSOCKET_MAX_BINARY_BYTES);
    expect(decodeTerminalBinaryFrame(encoded).revision).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("rejects invalid encoder frame types", () => {
    expect(() =>
      encodeTerminalBinaryFrame({
        type: 99,
        channelId: 1,
        generation: 1,
        revision: 1,
        bytes: new Uint8Array(),
      } as never),
    ).toThrow("Unknown");
  });

  test("enforces every encoder integer bound", () => {
    const base = {
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 1,
      generation: 1,
      revision: 1,
      bytes: new Uint8Array(),
    } as const;
    for (const channelId of [-1, 1.5, Number.NaN, 65_536]) {
      expect(() => encodeTerminalBinaryFrame({ ...base, channelId })).toThrow("channelId");
    }
    for (const generation of [-1, 1.5, Number.POSITIVE_INFINITY, 0x1_0000_0000]) {
      expect(() => encodeTerminalBinaryFrame({ ...base, generation })).toThrow("generation");
    }
    for (const revision of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => encodeTerminalBinaryFrame({ ...base, revision })).toThrow("revision");
    }
  });

  test("rejects truncated, oversized, unknown, flagged, and unsafe-revision frames", () => {
    expect(() => decodeTerminalBinaryFrame(new Uint8Array(15))).toThrow("shorter");
    expect(() =>
      decodeTerminalBinaryFrame(new Uint8Array(TERMINAL_WEBSOCKET_MAX_BINARY_BYTES + 1)),
    ).toThrow("maximum");

    const unknown = new Uint8Array(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
    unknown[0] = 99;
    expect(() => decodeTerminalBinaryFrame(unknown)).toThrow("Unknown");

    const flagged = new Uint8Array(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
    flagged[0] = TERMINAL_BINARY_FRAME_TYPE.input;
    flagged[1] = 1;
    expect(() => decodeTerminalBinaryFrame(flagged)).toThrow("flags");

    const unsafeRevision = new Uint8Array(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
    unsafeRevision[0] = TERMINAL_BINARY_FRAME_TYPE.output;
    new DataView(unsafeRevision.buffer).setBigUint64(
      8,
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      false,
    );
    expect(() => decodeTerminalBinaryFrame(unsafeRevision)).toThrow("safe integer");
  });

  test("rejects payloads one byte above the maximum", () => {
    expect(() =>
      encodeTerminalBinaryFrame({
        type: TERMINAL_BINARY_FRAME_TYPE.input,
        channelId: 1,
        generation: 1,
        revision: 1,
        bytes: new Uint8Array(
          TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES + 1,
        ),
      }),
    ).toThrow("maximum");
  });
});

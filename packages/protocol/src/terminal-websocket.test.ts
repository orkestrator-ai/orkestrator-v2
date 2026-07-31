import { describe, expect, test } from "bun:test";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  TERMINAL_BINARY_FRAME_TYPE,
  TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES,
  TERMINAL_WEBSOCKET_MAX_BINARY_BYTES,
} from "./terminal-websocket";

describe("terminal WebSocket binary protocol", () => {
  test("round trips raw bytes and cursor metadata", () => {
    const encoded = encodeTerminalBinaryFrame({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 513,
      generation: 17,
      revision: 9_007_199_254_740_000,
      bytes: new Uint8Array([0, 27, 91, 65, 255]),
    });

    expect(encoded.byteLength).toBe(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES + 5);
    expect(decodeTerminalBinaryFrame(encoded)).toEqual({
      type: TERMINAL_BINARY_FRAME_TYPE.output,
      channelId: 513,
      generation: 17,
      revision: 9_007_199_254_740_000,
      bytes: new Uint8Array([0, 27, 91, 65, 255]),
    });
  });

  test("rejects truncated, oversized, unknown, and flagged frames", () => {
    expect(() => decodeTerminalBinaryFrame(new Uint8Array(15))).toThrow("shorter");
    expect(() => decodeTerminalBinaryFrame(
      new Uint8Array(TERMINAL_WEBSOCKET_MAX_BINARY_BYTES + 1),
    )).toThrow("maximum");

    const unknown = new Uint8Array(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
    unknown[0] = 99;
    expect(() => decodeTerminalBinaryFrame(unknown)).toThrow("Unknown");

    const flagged = new Uint8Array(TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES);
    flagged[0] = TERMINAL_BINARY_FRAME_TYPE.input;
    flagged[1] = 1;
    expect(() => decodeTerminalBinaryFrame(flagged)).toThrow("flags");
  });

  test("enforces encoder integer and size bounds", () => {
    const base = {
      type: TERMINAL_BINARY_FRAME_TYPE.input,
      channelId: 1,
      generation: 1,
      revision: 1,
      bytes: new Uint8Array(),
    } as const;
    expect(() => encodeTerminalBinaryFrame({ ...base, channelId: 65_536 })).toThrow("channelId");
    expect(() => encodeTerminalBinaryFrame({ ...base, generation: -1 })).toThrow("generation");
    expect(() => encodeTerminalBinaryFrame({
      ...base,
      bytes: new Uint8Array(
        TERMINAL_WEBSOCKET_MAX_BINARY_BYTES - TERMINAL_WEBSOCKET_BINARY_HEADER_BYTES + 1,
      ),
    })).toThrow("maximum");
  });
});

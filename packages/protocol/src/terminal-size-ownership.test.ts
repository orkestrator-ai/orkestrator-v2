import { describe, expect, test } from "bun:test";
import {
  parseTerminalSizeClientId,
  TERMINAL_SIZE_CLIENT_ID_MAX_CHARS,
} from "./terminal-size-ownership";

describe("parseTerminalSizeClientId", () => {
  test("accepts an opaque id of URL-safe characters", () => {
    expect(parseTerminalSizeClientId("6f1c2b4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f")).toBe(
      "6f1c2b4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f",
    );
    expect(parseTerminalSizeClientId("node:window.1_a")).toBe("node:window.1_a");
    expect(parseTerminalSizeClientId("x".repeat(TERMINAL_SIZE_CLIENT_ID_MAX_CHARS))).toHaveLength(
      TERMINAL_SIZE_CLIENT_ID_MAX_CHARS,
    );
  });

  test("reads anything else as no id instead of throwing", () => {
    for (const value of [
      undefined,
      null,
      42,
      {},
      "",
      "with space",
      "new\nline",
      "x".repeat(TERMINAL_SIZE_CLIENT_ID_MAX_CHARS + 1),
    ]) {
      expect(parseTerminalSizeClientId(value)).toBeNull();
    }
  });
});

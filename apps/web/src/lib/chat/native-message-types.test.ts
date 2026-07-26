import { describe, expect, test } from "bun:test";

import type { NativeBasePart } from "./native-message-types";

function roundTripPart(part: NativeBasePart): NativeBasePart {
  return JSON.parse(JSON.stringify(part)) as NativeBasePart;
}

describe("NativeBasePart timestamp contract", () => {
  test("preserves a provider part timestamp through JSON serialization", () => {
    const part: NativeBasePart = {
      content: "Streamed response",
      createdAt: "2026-07-26T12:34:56.789Z",
    };

    expect(roundTripPart(part)).toEqual(part);
  });

  test("allows providers to omit the part timestamp", () => {
    const part: NativeBasePart = {
      content: "Response without provider timing",
    };

    expect(roundTripPart(part)).toEqual({
      content: "Response without provider timing",
    });
    expect("createdAt" in roundTripPart(part)).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import type { NormalizedPart } from "./index";

function roundTripPart(part: NormalizedPart): NormalizedPart {
  return JSON.parse(JSON.stringify(part)) as NormalizedPart;
}

describe("NormalizedPart timestamp contract", () => {
  test("preserves a content-block timestamp through JSON serialization", () => {
    const part: NormalizedPart = {
      type: "thinking",
      content: "Considering the request",
      timestamp: "2026-07-26T12:34:56.789Z",
    };

    expect(roundTripPart(part)).toEqual(part);
  });

  test("allows content blocks to omit the timestamp", () => {
    const part: NormalizedPart = {
      type: "text",
      content: "Final response",
    };

    expect(roundTripPart(part)).toEqual({
      type: "text",
      content: "Final response",
    });
    expect("timestamp" in roundTripPart(part)).toBe(false);
  });
});

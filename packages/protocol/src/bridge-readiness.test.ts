import { describe, expect, test } from "bun:test";
import { isAwaitBridgeReadyResult } from "./bridge-readiness";

describe("isAwaitBridgeReadyResult", () => {
  test("accepts ready and structured failure outcomes", () => {
    expect(isAwaitBridgeReadyResult({
      status: "ready",
      port: 4321,
      authToken: "token",
    })).toBe(true);
    expect(isAwaitBridgeReadyResult({
      status: "timed-out",
      error: { message: "still starting", retryable: true, retryAfterMs: 500 },
    })).toBe(true);
  });

  test("rejects message-only errors and invalid endpoints", () => {
    expect(isAwaitBridgeReadyResult({ status: "failed", error: "nope" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 0, authToken: "x" })).toBe(false);
  });
});

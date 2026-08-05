import { describe, expect, test } from "bun:test";
import {
  isAgentBridgeKind,
  isAwaitBridgeReadyResult,
  isStructuredCommandError,
} from "./bridge-readiness";

describe("isAgentBridgeKind", () => {
  test("accepts exactly the supported bridge kinds", () => {
    expect(["claude", "codex", "opencode"].every(isAgentBridgeKind)).toBe(true);
    expect(isAgentBridgeKind("other")).toBe(false);
    expect(isAgentBridgeKind(null)).toBe(false);
  });
});

describe("isStructuredCommandError", () => {
  test("accepts optional non-negative safe retry delays", () => {
    expect(isStructuredCommandError({ message: "no", retryable: false })).toBe(true);
    expect(isStructuredCommandError({
      message: "later",
      retryable: true,
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    })).toBe(true);
  });

  test("rejects malformed errors and retry delays", () => {
    for (const value of [
      null,
      [],
      { message: 1, retryable: true },
      { message: "x", retryable: "yes" },
      { message: "x", retryable: true, retryAfterMs: -1 },
      { message: "x", retryable: true, retryAfterMs: 1.5 },
      { message: "x", retryable: true, retryAfterMs: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(isStructuredCommandError(value)).toBe(false);
    }
  });
});

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
    expect(isAwaitBridgeReadyResult({
      status: "failed",
      error: { message: "could not start", retryable: false },
    })).toBe(true);
  });

  test("rejects message-only errors and invalid endpoints", () => {
    expect(isAwaitBridgeReadyResult(null)).toBe(false);
    expect(isAwaitBridgeReadyResult([])).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "failed", error: "nope" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 0, authToken: "x" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 65_536, authToken: "x" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 1.5, authToken: "x" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 1, authToken: "" })).toBe(false);
    expect(isAwaitBridgeReadyResult({ status: "unknown", error: {} })).toBe(false);
  });

  test("accepts both TCP port boundaries", () => {
    expect(isAwaitBridgeReadyResult({ status: "ready", port: 1, authToken: "x" })).toBe(true);
    expect(isAwaitBridgeReadyResult({
      status: "ready",
      port: 65_535,
      authToken: "x",
    })).toBe(true);
  });
});

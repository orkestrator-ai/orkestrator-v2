import { describe, expect, test } from "bun:test";
import {
  RetryableNewEnvironmentConnectionError,
  classifyNewEnvironmentConnectionStartupError,
  getNewEnvironmentConnectionRetryDecision,
  isRetryableNewEnvironmentConnectionError,
} from "./new-environment-connection-retry";

const NOW = Date.parse("2026-07-28T18:30:00.000Z");

function decide(
  overrides: Partial<Parameters<typeof getNewEnvironmentConnectionRetryDecision>[0]> = {},
) {
  return getNewEnvironmentConnectionRetryDecision({
    createdAt: new Date(NOW - 5_000).toISOString(),
    attempt: 0,
    retryWindowStartedAt: null,
    setupPendingObserved: false,
    now: NOW,
    ...overrides,
  });
}

describe("getNewEnvironmentConnectionRetryDecision", () => {
  test("starts a first-attempt window and returns the complete bounded backoff", () => {
    expect(decide({ attempt: 0 })).toEqual({
      delayMs: 500,
      retryWindowStartedAt: NOW,
    });
    expect(decide({ attempt: 1 })).toEqual({
      delayMs: 1_000,
      retryWindowStartedAt: NOW,
    });
    expect(decide({ attempt: 2 })).toEqual({
      delayMs: 2_000,
      retryWindowStartedAt: NOW,
    });
    expect(decide({ attempt: 3 })).toEqual({
      delayMs: 4_000,
      retryWindowStartedAt: NOW,
    });
    expect(decide({ attempt: 4 })).toBeNull();
  });

  test("rejects negative, fractional, and non-finite attempt numbers", () => {
    expect(decide({ attempt: -1 })).toBeNull();
    expect(decide({ attempt: 0.5 })).toBeNull();
    expect(decide({ attempt: Number.NaN })).toBeNull();
    expect(decide({ attempt: Number.POSITIVE_INFINITY })).toBeNull();
  });

  test("accepts the exact creation-age boundary but rejects older environments", () => {
    expect(
      decide({ createdAt: new Date(NOW - 60_000).toISOString() }),
    ).not.toBeNull();
    expect(
      decide({ createdAt: new Date(NOW - 60_001).toISOString() }),
    ).toBeNull();
  });

  test("fails closed for absent, invalid, and future creation timestamps", () => {
    expect(decide({ createdAt: undefined })).toBeNull();
    expect(decide({ createdAt: "not-a-date" })).toBeNull();
    expect(decide({ createdAt: new Date(NOW + 1).toISOString() })).toBeNull();
  });

  test("starts a fresh retry window after setup even when setup exceeded a minute", () => {
    expect(
      decide({
        createdAt: new Date(NOW - 5 * 60_000).toISOString(),
        setupPendingObserved: true,
      }),
    ).toEqual({
      delayMs: 500,
      retryWindowStartedAt: NOW,
    });
  });

  test("keeps an established window independent of environment creation age", () => {
    expect(
      decide({
        createdAt: new Date(NOW - 5 * 60_000).toISOString(),
        attempt: 2,
        retryWindowStartedAt: NOW - 2_000,
      }),
    ).toEqual({
      delayMs: 2_000,
      retryWindowStartedAt: NOW - 2_000,
    });
  });

  test("rejects expired, future, and non-finite retry windows", () => {
    expect(decide({ retryWindowStartedAt: NOW - 60_000 })).not.toBeNull();
    expect(decide({ retryWindowStartedAt: NOW - 60_001 })).toBeNull();
    expect(decide({ retryWindowStartedAt: NOW + 1 })).toBeNull();
    expect(decide({ retryWindowStartedAt: Number.NaN })).toBeNull();
  });
});

describe("RetryableNewEnvironmentConnectionError", () => {
  test("preserves Error and string messages and identifies only marked errors", () => {
    const cause = new Error("bridge is still starting");
    const marked = new RetryableNewEnvironmentConnectionError(cause);
    expect(marked.message).toBe(cause.message);
    expect(marked.cause).toBe(cause);
    expect(isRetryableNewEnvironmentConnectionError(marked)).toBe(true);

    expect(new RetryableNewEnvironmentConnectionError("try again").message).toBe("try again");
    expect(new RetryableNewEnvironmentConnectionError(null).message).toBe(
      "Agent bridge is still starting",
    );
    expect(isRetryableNewEnvironmentConnectionError(cause)).toBe(false);
    expect(isRetryableNewEnvironmentConnectionError(null)).toBe(false);
  });

  test("classifies transient startup messages and gateway statuses", () => {
    for (const message of [
      "bridge is still starting",
      "bridge not ready",
      "bridge never became ready",
      "Server on port 49152 did not become healthy",
      "codex server exited before becoming healthy (code 1, signal null)",
      "bridge delayed by setup",
      "Container is not running",
      "Container is restarting",
      "Local environment worktree is not available",
      "service temporarily unavailable",
      "connection refused",
      "request timed out",
      "ECONNRESET",
      "fetch failed",
      "network error",
      "socket hang up",
    ]) {
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(new Error(message)),
        ),
      ).toBe(true);
    }
    for (const status of [425, 429, 502, 503, 504]) {
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError({ status }),
        ),
      ).toBe(true);
    }
  });

  test("leaves permanent errors unmarked and normalizes non-Error values", () => {
    const permanent = new Error("permission denied");
    expect(classifyNewEnvironmentConnectionStartupError(permanent)).toBe(permanent);
    expect(
      isRetryableNewEnvironmentConnectionError(
        classifyNewEnvironmentConnectionStartupError({ status: 401 }),
      ),
    ).toBe(false);
    expect(classifyNewEnvironmentConnectionStartupError("invalid configuration").message)
      .toBe("invalid configuration");
    expect(classifyNewEnvironmentConnectionStartupError(null).message)
      .toBe("Agent bridge startup failed");
  });
});

import { describe, expect, test } from "bun:test";
import {
  RetryableNewEnvironmentConnectionError,
  classifyNewEnvironmentConnectionStartupError,
  getNewEnvironmentConnectionRetryDecision,
  isRetryableNewEnvironmentConnectionError,
} from "./new-environment-connection-retry";
import { GatewayHttpError } from "./native/gateway-http-error";

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
      retryWindowExpiresAt: NOW + 60_000,
    });
    expect(decide({ attempt: 1 })).toEqual({
      delayMs: 1_000,
      retryWindowStartedAt: NOW,
      retryWindowExpiresAt: NOW + 60_000,
    });
    expect(decide({ attempt: 2 })).toEqual({
      delayMs: 2_000,
      retryWindowStartedAt: NOW,
      retryWindowExpiresAt: NOW + 60_000,
    });
    expect(decide({ attempt: 3 })).toEqual({
      delayMs: 4_000,
      retryWindowStartedAt: NOW,
      retryWindowExpiresAt: NOW + 60_000,
    });
    for (let attempt = 4; attempt < 10; attempt += 1) {
      expect(decide({ attempt })).toEqual({
        delayMs: 8_000,
        retryWindowStartedAt: NOW,
        retryWindowExpiresAt: NOW + 60_000,
      });
    }
    expect(decide({ attempt: 10 })).toBeNull();
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
      retryWindowExpiresAt: NOW + 60_000,
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
      retryWindowExpiresAt: NOW + 58_000,
    });
  });

  test("rejects windows that are expired, invalid, or too close to expiry for the delay", () => {
    expect(
      decide({
        attempt: 0,
        retryWindowStartedAt: NOW - 59_500,
      }),
    ).toEqual({
      delayMs: 500,
      retryWindowStartedAt: NOW - 59_500,
      retryWindowExpiresAt: NOW + 500,
    });
    expect(decide({ retryWindowStartedAt: NOW - 59_501 })).toBeNull();
    expect(decide({ retryWindowStartedAt: NOW - 60_000 })).toBeNull();
    expect(decide({ retryWindowStartedAt: NOW - 60_001 })).toBeNull();
    expect(decide({ retryWindowStartedAt: NOW + 1 })).toBeNull();
    expect(decide({ retryWindowStartedAt: Number.NaN })).toBeNull();
  });

  test("keeps the complete schedule within the window after request latency and delayed callbacks", () => {
    const requestLatencyMs = 200;
    const callbackLagMs = [0, 0, 0, 0, 500, 500, 500, 500, 0, 0];
    let now = NOW;
    // Components establish the window before starting the first request, so
    // the initial request's latency counts against the same deadline.
    let retryWindowStartedAt: number | null = NOW;
    const observedDelays: number[] = [];

    for (let attempt = 0; attempt < 10; attempt += 1) {
      // Model time spent waiting for the failed status/start request before the
      // retry decision is made.
      now += requestLatencyMs;
      const decision = decide({
        attempt,
        retryWindowStartedAt,
        now,
      });
      expect(decision).not.toBeNull();
      retryWindowStartedAt = decision!.retryWindowStartedAt;
      observedDelays.push(decision!.delayMs);

      // The first four 8-second callbacks are delivered 500ms late, as can
      // happen when the renderer is backgrounded or its timers are throttled.
      now += decision!.delayMs + callbackLagMs[attempt]!;
    }

    now += requestLatencyMs;
    expect(now - NOW).toBe(59_700);
    expect(now - retryWindowStartedAt!).toBe(59_700);
    expect(
      decide({
        attempt: 10,
        retryWindowStartedAt,
        now,
      }),
    ).toBeNull();
    expect(observedDelays).toEqual([
      500,
      1_000,
      2_000,
      4_000,
      8_000,
      8_000,
      8_000,
      8_000,
      8_000,
      8_000,
    ]);
  });

  test("cuts off an unexhausted schedule when its next delay would cross the deadline", () => {
    const retryWindowStartedAt = NOW;

    expect(
      decide({
        attempt: 8,
        retryWindowStartedAt,
        now: NOW + 52_000,
      }),
    ).not.toBeNull();
    expect(
      decide({
        attempt: 8,
        retryWindowStartedAt,
        now: NOW + 52_001,
      }),
    ).toBeNull();
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

  /*
   * Synthetic `{ status }` literals prove the branch works but not that it is
   * reachable. These use the error the gateway transport actually throws, which
   * is the only place in the renderer a retryable HTTP status originates: the
   * Electron transport rejects with a bare `Error`, and a backend command that
   * fails comes back as HTTP 500 carrying its own message.
   */
  test("retries the gateway's real error object for infrastructure statuses", () => {
    for (const status of [425, 429, 502, 503, 504]) {
      const error = new GatewayHttpError(
        status,
        `Gateway command failed with HTTP ${status}`,
      );
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(error),
        ),
      ).toBe(true);
    }
  });

  test("leaves the gateway's non-retryable statuses alone", () => {
    // 500 is how a *backend command* failure reaches the renderer, so its own
    // message — not the envelope status — has to decide retryability.
    const permanent = new GatewayHttpError(500, "permission denied");
    expect(classifyNewEnvironmentConnectionStartupError(permanent)).toBe(permanent);

    const transient = new GatewayHttpError(500, "Container is not running");
    expect(
      isRetryableNewEnvironmentConnectionError(
        classifyNewEnvironmentConnectionStartupError(transient),
      ),
    ).toBe(true);

    for (const status of [400, 401, 403, 404, 500]) {
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(
            new GatewayHttpError(status, "invalid configuration"),
          ),
        ),
      ).toBe(false);
    }
  });

  /*
   * The veto is a deliberate trade-off, so pin what it costs as well as what it
   * buys. A health-wrapper message whose appended child log happens to contain
   * transport wording is *not* retried, even though that wording would retry on
   * its own — the wrapper cannot tell a slow bridge from a broken one.
   */
  test("the generic-wrapper veto also suppresses genuinely transient causes", () => {
    const vetoed = new Error(
      "Server on port 49152 did not become healthy\nECONNREFUSED 127.0.0.1:49152",
    );
    expect(classifyNewEnvironmentConnectionStartupError(vetoed)).toBe(vetoed);

    // The same cause without the wrapper still retries, which is what makes the
    // wrapper — not the transport wording — the thing being vetoed.
    expect(
      isRetryableNewEnvironmentConnectionError(
        classifyNewEnvironmentConnectionStartupError(
          new Error("ECONNREFUSED 127.0.0.1:49152"),
        ),
      ),
    ).toBe(true);

    // An explicit infrastructure status outranks the veto: it comes from the
    // envelope rather than from the child's log.
    expect(
      isRetryableNewEnvironmentConnectionError(
        classifyNewEnvironmentConnectionStartupError(
          new GatewayHttpError(503, "Server on port 49152 did not become healthy"),
        ),
      ),
    ).toBe(true);
  });

  test("does not infer retryability from generic health wrappers", () => {
    for (const message of [
      "Server on port 49152 did not become healthy",
      "codex server exited before becoming healthy (code 1, signal null)",
      [
        "Server on port 49152 did not become healthy",
        "permission denied while loading configuration",
      ].join("\n"),
      [
        "claude server exited before becoming healthy (code 1, signal null)",
        "authentication failed",
      ].join("\n"),
      [
        "Server on port 49152 did not become healthy",
        "bridge dependency is temporarily unavailable",
      ].join("\n"),
    ]) {
      const error = new Error(message);
      expect(classifyNewEnvironmentConnectionStartupError(error)).toBe(error);
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(error),
        ),
      ).toBe(false);
    }
  });

  test("requires explicit lifecycle-race wording rather than near matches", () => {
    for (const message of [
      "Container was not running",
      "Container is running",
      "Container will restart later",
      "Local environment worktree was not available",
      "Local environment worktree is available",
      "The worktree is not yet provisioned",
    ]) {
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(new Error(message)),
        ),
      ).toBe(false);
    }

    for (const message of [
      "Container is not running",
      "Container is restarting",
      "Local environment worktree is not available",
    ]) {
      expect(
        isRetryableNewEnvironmentConnectionError(
          classifyNewEnvironmentConnectionStartupError(new Error(message)),
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

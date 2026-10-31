import { describe, expect, test } from "bun:test";

import { toTurnError } from "../app-server/event-reducer.js";
import {
  CODEX_SERVER_OVERLOADED_MESSAGE,
  DEFAULT_CAPACITY_RETRY_POLICY,
  capacityRetriesExhaustedError,
  capacityRetryContinuationText,
  capacityRetryDelayMs,
  capacityRetryWaitingText,
  isModelCapacityError,
  parseCapacityRetryContinuation,
} from "./capacity-retry.js";

describe("isModelCapacityError", () => {
  test("accepts app-server's serverOverloaded refusal", () => {
    expect(
      isModelCapacityError(
        toTurnError({
          message: CODEX_SERVER_OVERLOADED_MESSAGE,
          codexErrorInfo: "serverOverloaded",
        }),
      ),
    ).toBe(true);
  });

  test("accepts the exact refusal text only when app-server sent no code", () => {
    expect(isModelCapacityError({ message: ` ${CODEX_SERVER_OVERLOADED_MESSAGE}\n` })).toBe(true);
    expect(isModelCapacityError({ message: CODEX_SERVER_OVERLOADED_MESSAGE, code: "other" })).toBe(
      false,
    );
    expect(isModelCapacityError({ message: "The model is at capacity right now" })).toBe(false);
  });

  test.each([
    "usageLimitExceeded",
    "rateLimitExceeded",
    "sessionBudgetExceeded",
    "flexUnavailable",
    "unauthorized",
    "badRequest",
    "contextWindowExceeded",
    "internalServerError",
    "responseTooManyFailedAttempts",
  ])("refuses %s", (code) => {
    expect(isModelCapacityError({ message: CODEX_SERVER_OVERLOADED_MESSAGE, code })).toBe(false);
  });

  test("refuses a 401 or 403 even under the overload code", () => {
    for (const httpStatusCode of [401, 403]) {
      expect(isModelCapacityError({ message: "x", code: "serverOverloaded", httpStatusCode })).toBe(
        false,
      );
    }
  });

  test("refuses a missing error", () => {
    expect(isModelCapacityError(undefined)).toBe(false);
  });
});

describe("capacityRetryDelayMs", () => {
  const policy = DEFAULT_CAPACITY_RETRY_POLICY;

  test("grows exponentially and is capped before jitter", () => {
    const nominal = [2, 3, 4, 5, 6].map((attempt) =>
      capacityRetryDelayMs(policy, attempt, () => 1),
    );
    expect(nominal).toEqual([2_000, 6_000, 18_000, 54_000, 60_000]);
  });

  test("never waits less than half the nominal wait", () => {
    expect(capacityRetryDelayMs(policy, 3, () => 0)).toBe(3_000);
    expect(capacityRetryDelayMs(policy, 3, () => 0.5)).toBe(4_500);
    // A broken random source is clamped, not trusted.
    expect(capacityRetryDelayMs(policy, 3, () => 7)).toBe(6_000);
    expect(capacityRetryDelayMs(policy, 3, () => -1)).toBe(3_000);
  });

  test("the default series stays under two minutes in all", () => {
    let total = 0;
    for (let attempt = 2; attempt <= policy.maxAttempts; attempt += 1) {
      total += capacityRetryDelayMs(policy, attempt, () => 1);
    }
    expect(total).toBe(80_000);
  });
});

describe("transcript and continuation text", () => {
  test("the waiting card names the wait and the attempt", () => {
    expect(capacityRetryWaitingText(8_400, 2, 5)).toBe(
      "Model at capacity, retrying in 8 s (attempt 2 of 5)",
    );
    expect(capacityRetryWaitingText(120, 2, 5)).toContain("retrying in 1 s");
  });

  test("a continuation round-trips through its marker", () => {
    const text = capacityRetryContinuationText(3, 5);
    expect(parseCapacityRetryContinuation(text)).toEqual({ attempt: 3, maxAttempts: 5 });
    expect(text).toContain("not by the user");
    expect(parseCapacityRetryContinuation("Please continue")).toBeUndefined();
    expect(parseCapacityRetryContinuation("[Orkestrator automatic retry] hello")).toBeUndefined();
  });

  test("the exhausted error keeps the provider's message and code", () => {
    expect(
      capacityRetriesExhaustedError(
        { message: CODEX_SERVER_OVERLOADED_MESSAGE, code: "serverOverloaded" },
        5,
      ),
    ).toEqual({
      message: `${CODEX_SERVER_OVERLOADED_MESSAGE} Automatic retries exhausted after 5 attempts.`,
      code: "serverOverloaded",
    });
  });
});

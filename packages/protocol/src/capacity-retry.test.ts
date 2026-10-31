import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CAPACITY_RETRY_POLICY,
  capacityRetryDelayMs,
  formatRetryDelay,
  namesLimitOrLogin,
} from "./capacity-retry.js";

describe("namesLimitOrLogin", () => {
  test.each([
    "You've hit your usage limit",
    "usage_not_included",
    "API rate limit reached",
    "rate_limit_error",
    "Too Many Requests",
    "Quota exceeded. Check your plan and billing details.",
    "insufficient_quota",
    "Ask a team admin to purchase more credits",
    "subscription:free-usage-exhausted",
    "401 Unauthorized",
    "Please log in again",
    "sign-in required",
    "Invalid API key",
  ])("rules out %s", (text) => {
    expect(namesLimitOrLogin(text)).toBe(true);
  });

  test.each([
    "Selected model is at capacity. Please try a different model.",
    "Overloaded",
    '{"type":"overloaded_error"}',
    "Service Unavailable",
    "Grok is temporarily overloaded. Please try again in a moment.",
    "PING timed out",
    "Error",
  ])("leaves %s to the provider's own classifier", (text) => {
    expect(namesLimitOrLogin(text)).toBe(false);
  });
});

describe("capacityRetryDelayMs", () => {
  test("the default policy's nominal waits and ceiling", () => {
    const nominal = [2, 3, 4, 5].map((attempt) =>
      capacityRetryDelayMs(DEFAULT_CAPACITY_RETRY_POLICY, attempt, () => 1),
    );
    expect(nominal).toEqual([2_000, 6_000, 18_000, 54_000]);
    expect(capacityRetryDelayMs(DEFAULT_CAPACITY_RETRY_POLICY, 6, () => 1)).toBe(60_000);
  });

  test("jitter stays between half and all of the nominal wait", () => {
    const policy = DEFAULT_CAPACITY_RETRY_POLICY;
    expect(capacityRetryDelayMs(policy, 3, () => 0)).toBe(3_000);
    expect(capacityRetryDelayMs(policy, 3, () => 7)).toBe(6_000);
    expect(capacityRetryDelayMs(policy, 3, () => -1)).toBe(3_000);
  });

  test("a sub-second wait still reads as one second", () => {
    expect(formatRetryDelay(120)).toBe("1 s");
    expect(formatRetryDelay(8_400)).toBe("8 s");
  });
});

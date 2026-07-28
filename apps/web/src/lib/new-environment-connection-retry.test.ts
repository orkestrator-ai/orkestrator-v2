import { describe, expect, test } from "bun:test";
import { getNewEnvironmentConnectionRetryDelay } from "./new-environment-connection-retry";

const NOW = Date.parse("2026-07-28T18:30:00.000Z");

describe("getNewEnvironmentConnectionRetryDelay", () => {
  test("backs off for a newly created environment", () => {
    const createdAt = new Date(NOW - 5_000).toISOString();

    expect(getNewEnvironmentConnectionRetryDelay(createdAt, 0, NOW)).toBe(500);
    expect(getNewEnvironmentConnectionRetryDelay(createdAt, 1, NOW)).toBe(1_000);
    expect(getNewEnvironmentConnectionRetryDelay(createdAt, 2, NOW)).toBe(2_000);
    expect(getNewEnvironmentConnectionRetryDelay(createdAt, 3, NOW)).toBe(4_000);
    expect(getNewEnvironmentConnectionRetryDelay(createdAt, 4, NOW)).toBeNull();
  });

  test("does not delay errors for existing or invalid environments", () => {
    expect(
      getNewEnvironmentConnectionRetryDelay(
        new Date(NOW - 60_001).toISOString(),
        0,
        NOW,
      ),
    ).toBeNull();
    expect(getNewEnvironmentConnectionRetryDelay("not-a-date", 0, NOW)).toBeNull();
    expect(
      getNewEnvironmentConnectionRetryDelay(
        new Date(NOW + 1).toISOString(),
        0,
        NOW,
      ),
    ).toBeNull();
  });
});

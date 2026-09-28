import { describe, expect, mock, spyOn, test } from "bun:test";
import { queryControlOverrides } from "./session-manager-test-harness.js";
import { readClaudePlanUsage } from "./session-manager.js";

/**
 * `readClaudePlanUsage` drives the experimental structured-usage accessor on a
 * probe query, exactly as the settings pane does without a live session. The
 * distinctions that matter are between "the account has no metered limits",
 * "the CLI has no usage API" and "the read failed".
 */
describe("readClaudePlanUsage", () => {
  test("throws when the CLI exposes no experimental usage accessor", async () => {
    await expect(readClaudePlanUsage()).rejects.toThrow(/plan usage API is unavailable/);
  });

  test("throws when the accessor answers without an authoritative snapshot", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({ rate_limits_available: true, rate_limits: null }),
    );
    await expect(readClaudePlanUsage()).rejects.toThrow(/did not report plan usage/);
  });

  test("returns an authoritative empty window list when the account is unmetered", async () => {
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = mock(
      async () => ({ rate_limits_available: false, rate_limits: null }),
    );
    await expect(readClaudePlanUsage()).resolves.toEqual([]);
  });

  test("maps the structured windows to slugged account windows", async () => {
    const getStructuredUsage = mock(async () => ({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 31, resets_at: "2026-09-11T18:32:00.000Z" },
        seven_day: { utilization: 12 },
      },
    }));
    queryControlOverrides.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET =
      getStructuredUsage;
    const timeoutSpy = spyOn(globalThis, "setTimeout");
    let windows: Awaited<ReturnType<typeof readClaudePlanUsage>>;
    try {
      windows = await readClaudePlanUsage();
      expect(timeoutSpy.mock.calls.some(([, delay]) => delay === 10_000)).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
    expect(getStructuredUsage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(windows).toEqual([
      {
        window: "five-hour",
        label: "Five Hour",
        usedPercent: 31,
        resetsAt: "2026-09-11T18:32:00.000Z",
      },
      { window: "weekly", label: "Weekly", usedPercent: 12 },
    ]);
  });
});

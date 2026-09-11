import { describe, expect, test } from "bun:test";
import { rateLimitWindowsFromRead } from "./app-server-engine.js";

describe("rateLimitWindowsFromRead", () => {
  test("maps both windows and converts epoch seconds to ISO", () => {
    const windows = rateLimitWindowsFromRead({
      rateLimits: {
        limitName: "pro",
        primary: { usedPercent: 40, resetsAt: 1_800_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 12.5, resetsAt: 1_800_100_000, windowDurationMins: 10_080 },
      },
    });
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      slot: "primary",
      label: "pro",
      usedPercent: 40,
      windowMinutes: 300,
    });
    expect(windows[0]?.resetsAt).toBe(new Date(1_800_000_000_000).toISOString());
    expect(windows[1]).toMatchObject({ slot: "secondary", label: "Secondary", usedPercent: 12.5 });
  });

  test("clamps an over-quota percentage and falls back to slot labels", () => {
    const windows = rateLimitWindowsFromRead({
      rateLimits: {
        primary: { usedPercent: 140 },
        secondary: { usedPercent: 200 },
      },
    });
    expect(windows[0]?.usedPercent).toBe(100);
    expect(windows[0]?.label).toBe("Primary");
  });

  test("returns nothing when the read carried no windows", () => {
    expect(rateLimitWindowsFromRead(undefined)).toEqual([]);
    expect(rateLimitWindowsFromRead({ error: "Unavailable" })).toEqual([]);
    expect(rateLimitWindowsFromRead({ rateLimits: {} })).toEqual([]);
  });
});

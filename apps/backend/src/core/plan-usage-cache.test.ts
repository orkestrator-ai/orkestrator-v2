import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  contextUsageWithPlanUsage,
  createPlanUsageCache,
  sharedPlanUsageCache,
} from "./plan-usage-cache.js";

// `contextUsageWithPlanUsage` always writes the process-wide singleton, which
// the HTTP bridge suites also read. Reset it around every test so a cached
// window from one test cannot be observed by another.
beforeEach(() => {
  sharedPlanUsageCache.clear();
});

afterEach(() => {
  sharedPlanUsageCache.clear();
});

describe("createPlanUsageCache", () => {
  test("serves a stored snapshot until its time-to-live passes", () => {
    let clock = 1_700_000_000_000;
    const cache = createPlanUsageCache(() => clock);
    cache.store(
      "claude",
      { platform: "claude", status: "ok", windows: [], fetchedAt: "2026-09-11T18:00:00.000Z" },
      CACHE_TTL_MS,
    );
    clock += CACHE_TTL_MS - 1;
    expect(cache.peek("claude")?.status).toBe("ok");
    clock += 2;
    expect(cache.peek("claude")).toBeUndefined();
  });

  test("keeps only Cursor's plan rows out of a session's mixed report", () => {
    const cache = createPlanUsageCache(() => 1_700_000_000_000);
    cache.recordSessionWindows("cursor", [
      { window: "session", label: "This session", spendUsd: 0.4 },
      { window: "cursor-internal-auto", label: "Cursor Models", usedPercent: 40 },
    ]);
    expect(cache.peek("cursor")?.windows).toEqual([
      { window: "cursor-internal-auto", label: "Cursor Models", usedPercent: 40 },
    ]);
  });

  test("ignores a session whose rows are all session spend", () => {
    const cache = createPlanUsageCache(() => 1_700_000_000_000);
    cache.recordSessionWindows("cursor", [{ window: "session", spendUsd: 0.4 }]);
    expect(cache.peek("cursor")).toBeUndefined();
  });

  test("merges a sparse session update instead of replacing the provider snapshot", () => {
    const cache = createPlanUsageCache(() => 1_700_000_000_000);
    cache.store(
      "claude",
      {
        platform: "claude",
        status: "ok",
        windows: [
          { window: "five_hour", label: "5-hour limit", usedPercent: 10 },
          { window: "seven_day", label: "Weekly limit", usedPercent: 60 },
        ],
        fetchedAt: "2026-09-11T18:00:00.000Z",
      },
      CACHE_TTL_MS,
    );
    cache.recordSessionWindows("claude", [
      { window: "five_hour", label: "5-hour limit", usedPercent: 42 },
    ]);
    expect(cache.peek("claude")?.windows).toEqual([
      { window: "five_hour", label: "5-hour limit", usedPercent: 42 },
      { window: "seven_day", label: "Weekly limit", usedPercent: 60 },
    ]);
  });
});

describe("contextUsageWithPlanUsage", () => {
  test("keeps a Codex session's account rows and returns the usage unchanged", () => {
    const usage = contextUsageWithPlanUsage("codex", {
      usedTokens: 10,
      account: [{ window: "primary", label: "Usage limit", usedPercent: 44 }],
    });
    expect(usage?.usedTokens).toBe(10);
    expect(sharedPlanUsageCache.peek("codex")?.windows).toEqual([
      { window: "primary", label: "Usage limit", usedPercent: 44 },
    ]);
  });

  test("reads Claude's plan windows from the rate limits a session reports", () => {
    contextUsageWithPlanUsage("claude", {
      usedTokens: 10,
      rateLimits: [{ label: "5-hour limit", usedPercent: 21, windowMinutes: 300 }],
    });
    expect(sharedPlanUsageCache.peek("claude")?.windows).toEqual([
      { window: "five_hour", label: "5-hour limit", usedPercent: 21, windowMinutes: 300 },
    ]);
  });

  test("maps a Claude session label onto the id the OAuth read emits", () => {
    contextUsageWithPlanUsage("claude", {
      usedTokens: 1,
      rateLimits: [{ label: "Weekly limit", usedPercent: 5 }],
    });
    expect(sharedPlanUsageCache.peek("claude")?.windows[0]?.window).toBe("seven_day");
  });

  test("does not apply Claude's ids to another platform's rate limits", () => {
    contextUsageWithPlanUsage("codex", {
      usedTokens: 1,
      rateLimits: [{ label: "Weekly limit", usedPercent: 5 }],
    });
    expect(sharedPlanUsageCache.peek("codex")?.windows[0]?.window).toBe("weekly-limit");
  });

  test("leaves the cache alone for a payload with no quota in it", () => {
    contextUsageWithPlanUsage("pi", { usedTokens: 10 });
    expect(sharedPlanUsageCache.peek("pi" as "claude")).toBeUndefined();
  });
});

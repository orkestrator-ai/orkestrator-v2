import { beforeEach, describe, expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  contextUsageWithPlanUsage,
  createPlanUsageCache,
  okSnapshot,
  PlanUsageState,
} from "./plan-usage-cache.js";
import { claudePlanWindowFromKind } from "@orkestrator/protocol/plan-usage";
import { claudePlanWindows } from "./plan-usage.js";

let planUsage: PlanUsageState;

beforeEach(() => {
  planUsage = new PlanUsageState();
});

describe("createPlanUsageCache", () => {
  test("session reports replace stale windows instead of refreshing unreported quotas", () => {
    const cache = createPlanUsageCache(() => 1_700_000_000_000);
    const fresh = okSnapshot(
      "claude",
      [
        { window: "five_hour", usedPercent: 10 },
        { window: "seven_day", usedPercent: 60 },
      ],
      new Date(0).toISOString(),
    );
    cache.store("claude", fresh, CACHE_TTL_MS);
    cache.store("claude", { ...fresh, stale: true, message: "HTTP 429" }, CACHE_TTL_MS);
    expect(cache.lastOk("claude")).toBe(fresh);
    // Even an unchanged incoming window is a new authoritative session report.
    cache.recordSessionWindows("claude", [{ window: "five_hour", usedPercent: 10 }]);
    const merged = cache.peek("claude");
    expect(merged?.windows).toEqual([{ window: "five_hour", usedPercent: 10 }]);
    expect(merged?.stale).toBeUndefined();
    expect(merged?.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(cache.lastOk("claude")).toBe(merged);
    cache.invalidate("claude");
    expect(cache.peek("claude")).toBeUndefined();
    expect(cache.lastOk("claude")).toBeUndefined();
  });

  test("patches defined fields and preserves matched window metadata and plan", () => {
    const cache = createPlanUsageCache(() => 1_700_000_000_000);
    const original = {
      window: "five_hour",
      label: "5-hour limit",
      usedPercent: 10,
      resetsAt: "2026-10-01T00:00:00.000Z",
      windowMinutes: 300,
      limitUsd: 100,
    };
    cache.store(
      "claude",
      okSnapshot("claude", [original], new Date(0).toISOString(), "max"),
      CACHE_TTL_MS,
    );
    cache.recordSessionWindows("claude", [
      {
        window: "five_hour",
        usedPercent: 42,
        resetsAt: undefined,
        windowMinutes: undefined,
        label: undefined,
      },
    ]);
    expect(cache.peek("claude")?.windows).toEqual([{ ...original, usedPercent: 42 }]);
    expect(cache.peek("claude")?.plan).toBe("max");
    cache.recordSessionWindows("claude", [
      { window: "five_hour", resetsAt: "2026-10-02T00:00:00.000Z", windowMinutes: 600 },
    ]);
    expect(cache.peek("claude")?.windows).toEqual([
      { ...original, usedPercent: 42, resetsAt: "2026-10-02T00:00:00.000Z", windowMinutes: 600 },
    ]);
    expect(original.usedPercent).toBe(10);
  });
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
  test("folds usage-report windows into OAuth rows and preserves a sparse row's reset", () => {
    const windows = claudePlanWindows({
      five_hour: { utilization: 10, resets_at: "2026-10-01T00:00:00Z" },
      seven_day: { utilization: 20 },
      seven_day_opus: { utilization: 30 },
    });
    planUsage.cache.store(
      "claude",
      okSnapshot("claude", windows, new Date(0).toISOString()),
      CACHE_TTL_MS,
    );
    contextUsageWithPlanUsage(planUsage, "claude", {
      usedTokens: 1,
      rateLimits: ["session", "weekly_all", "weekly_scoped"].map((kind, index) => ({
        label: claudePlanWindowFromKind(kind, "Opus")!.label,
        usedPercent: 40 + index,
      })),
    });
    expect(planUsage.cache.peek("claude")?.windows).toEqual(
      windows.map((row, index) => ({
        ...row,
        usedPercent: 40 + index,
      })),
    );
  });

  test("uses slug identities for unknown labels, including an empty slug", () => {
    contextUsageWithPlanUsage(planUsage, "claude", {
      usedTokens: 1,
      rateLimits: [
        { label: " New Quota! ", usedPercent: 5 },
        { label: "???", usedPercent: 6 },
      ],
    });
    expect(planUsage.cache.peek("claude")?.windows.map((row) => row.window)).toEqual([
      "new-quota",
      "window",
    ]);
  });
  test("an old bridge cannot report quota into the newly active account", () => {
    planUsage.setActiveAccount("claude", "account-b");
    contextUsageWithPlanUsage(
      planUsage,
      "claude",
      { usedTokens: 1, account: [{ window: "five_hour", usedPercent: 95 }] },
      "account-a",
    );
    expect(planUsage.cache.peek("claude")).toBeUndefined();
    contextUsageWithPlanUsage(
      planUsage,
      "claude",
      { usedTokens: 1, account: [{ window: "five_hour", usedPercent: 5 }] },
      "account-b",
    );
    expect(planUsage.cache.peek("claude")?.windows[0]?.usedPercent).toBe(5);
    planUsage.setActiveAccount("claude", "default");
  });
  test("keeps a Codex session's account rows and returns the usage unchanged", () => {
    const usage = contextUsageWithPlanUsage(planUsage, "codex", {
      usedTokens: 10,
      account: [{ window: "primary", label: "Usage limit", usedPercent: 44 }],
    });
    expect(usage?.usedTokens).toBe(10);
    expect(planUsage.cache.peek("codex")?.windows).toEqual([
      { window: "primary", label: "Usage limit", usedPercent: 44 },
    ]);
  });

  test("reads Claude's plan windows from the rate limits a session reports", () => {
    contextUsageWithPlanUsage(planUsage, "claude", {
      usedTokens: 10,
      rateLimits: [{ label: "5-hour limit", usedPercent: 21, windowMinutes: 300 }],
    });
    expect(planUsage.cache.peek("claude")?.windows).toEqual([
      { window: "five_hour", label: "5-hour limit", usedPercent: 21, windowMinutes: 300 },
    ]);
  });

  test("maps a Claude session label onto the id the OAuth read emits", () => {
    contextUsageWithPlanUsage(planUsage, "claude", {
      usedTokens: 1,
      rateLimits: [{ label: "Weekly limit", usedPercent: 5 }],
    });
    expect(planUsage.cache.peek("claude")?.windows[0]?.window).toBe("seven_day");
  });

  test("folds an older bridge's Claude labels into the canonical rows", () => {
    const sharedWindow = "2026-10-06T10:00:00.000Z";
    planUsage.cache.store(
      "claude",
      okSnapshot(
        "claude",
        [
          { window: "five_hour", label: "5-hour limit", usedPercent: 10, windowMinutes: 300 },
          { window: "seven_day", label: "Weekly limit", usedPercent: 5, windowMinutes: 10_080 },
          { window: "seven_day_fable", label: "Weekly Fable limit", usedPercent: 0 },
        ],
        new Date(0).toISOString(),
      ),
      60_000,
    );
    contextUsageWithPlanUsage(planUsage, "claude", {
      usedTokens: 1,
      rateLimits: [
        { label: "Five Hour", usedPercent: 11 },
        { label: "Weekly", usedPercent: 6, resetsAt: sharedWindow },
        { label: "Weekly (Fable)", usedPercent: 1 },
      ],
    });
    expect(planUsage.cache.peek("claude")?.windows).toEqual([
      { window: "five_hour", label: "5-hour limit", usedPercent: 11, windowMinutes: 300 },
      {
        window: "seven_day",
        label: "Weekly limit",
        usedPercent: 6,
        resetsAt: sharedWindow,
        windowMinutes: 10_080,
      },
      {
        window: "seven_day_fable",
        label: "Weekly Fable limit",
        usedPercent: 1,
        windowMinutes: 10_080,
      },
    ]);
  });

  test("does not apply Claude's ids to another platform's rate limits", () => {
    contextUsageWithPlanUsage(planUsage, "codex", {
      usedTokens: 1,
      rateLimits: [{ label: "Weekly limit", usedPercent: 5 }],
    });
    expect(planUsage.cache.peek("codex")?.windows[0]?.window).toBe("weekly-limit");
  });

  test("leaves the cache alone for a payload with no quota in it", () => {
    contextUsageWithPlanUsage(planUsage, "pi", { usedTokens: 10 });
    expect(planUsage.cache.peek("pi" as "claude")).toBeUndefined();
  });
});

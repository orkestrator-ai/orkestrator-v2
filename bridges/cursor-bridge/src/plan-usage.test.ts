import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accountWindowsFromPlanUsage,
  CURSOR_PLAN_WINDOW,
  mergeAccountWindows,
  peekPlanAccountWindows,
  resetPlanAccountWindowsForTests,
  seedPlanAccountWindowsForTests,
} from "./plan-usage.js";
import { publicContextUsage } from "./public.js";
import { newSessionState } from "./agent-session.js";

beforeEach(() => {
  resetPlanAccountWindowsForTests();
});

afterEach(() => {
  resetPlanAccountWindowsForTests();
});

describe("accountWindowsFromPlanUsage", () => {
  test("maps provider-reported pool percentages onto generic account windows", () => {
    expect(
      accountWindowsFromPlanUsage({
        billingCycleStart: Date.UTC(2026, 7, 1),
        billingCycleEnd: Date.UTC(2026, 8, 1),
        planUsage: {
          autoPercentUsed: 0,
          apiPercentUsed: 46.444,
          totalPercentUsed: 15.48,
          includedSpend: 23_222,
          limit: 40_000,
        },
      }),
    ).toEqual([
      {
        window: CURSOR_PLAN_WINDOW.auto,
        label: "Cursor Models",
        usedPercent: 0,
        resetsAt: "2026-09-01T00:00:00.000Z",
        windowMinutes: 44_640,
      },
      {
        window: CURSOR_PLAN_WINDOW.api,
        label: "Other Models",
        usedPercent: 46.444,
        resetsAt: "2026-09-01T00:00:00.000Z",
        windowMinutes: 44_640,
      },
    ]);
  });

  test("falls back to the overall quota percentage when pool buckets are absent", () => {
    expect(
      accountWindowsFromPlanUsage({
        planUsage: { totalPercentUsed: 42 },
      }),
    ).toEqual([
      {
        window: CURSOR_PLAN_WINDOW.total,
        label: "Cursor quota",
        usedPercent: 42,
      },
    ]);
  });

  test("does not invent a percentage from included spend versus limit", () => {
    expect(
      accountWindowsFromPlanUsage({
        planUsage: { includedSpend: 23_222, remaining: 16_778, limit: 40_000 },
      }),
    ).toEqual([]);
  });

  test("omits the period duration when Cursor does not report a valid cycle start", () => {
    expect(
      accountWindowsFromPlanUsage({
        billingCycleStart: "invalid",
        billingCycleEnd: Date.UTC(2026, 8, 1),
        planUsage: { autoPercentUsed: 12 },
      }),
    ).toEqual([
      {
        window: CURSOR_PLAN_WINDOW.auto,
        label: "Cursor Models",
        usedPercent: 12,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  test("omits the period duration when the cycle does not end after it starts", () => {
    for (const billingCycleStart of [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)]) {
      expect(
        accountWindowsFromPlanUsage({
          billingCycleStart,
          billingCycleEnd: Date.UTC(2026, 8, 1),
          planUsage: { autoPercentUsed: 12 },
        }),
      ).toEqual([
        {
          window: CURSOR_PLAN_WINDOW.auto,
          label: "Cursor Models",
          usedPercent: 12,
          resetsAt: "2026-09-01T00:00:00.000Z",
        },
      ]);
    }
  });

  test("returns nothing when planUsage is missing", () => {
    expect(accountWindowsFromPlanUsage({ billingCycleEnd: Date.UTC(2026, 8, 1) })).toEqual([]);
    expect(accountWindowsFromPlanUsage(undefined)).toEqual([]);
  });
});

describe("mergeAccountWindows", () => {
  test("keeps the session agent total beside plan-quota bars", () => {
    expect(
      mergeAccountWindows(
        [{ window: "agent", label: "Agent total", tokens: 3_000, spendUsd: 1.25 }],
        [
          { window: CURSOR_PLAN_WINDOW.auto, label: "Cursor Models", usedPercent: 12 },
          { window: CURSOR_PLAN_WINDOW.api, label: "Other Models", usedPercent: 46 },
        ],
      ),
    ).toEqual([
      { window: CURSOR_PLAN_WINDOW.auto, label: "Cursor Models", usedPercent: 12 },
      { window: CURSOR_PLAN_WINDOW.api, label: "Other Models", usedPercent: 46 },
      { window: "agent", label: "Agent total", tokens: 3_000, spendUsd: 1.25 },
    ]);
  });

  test("retains persisted plan windows when the live cache is empty", () => {
    expect(
      mergeAccountWindows(
        [
          { window: CURSOR_PLAN_WINDOW.auto, label: "Cursor Models", usedPercent: 10 },
          { window: "agent", label: "Agent total", tokens: 100 },
        ],
        undefined,
      ),
    ).toEqual([
      { window: CURSOR_PLAN_WINDOW.auto, label: "Cursor Models", usedPercent: 10 },
      { window: "agent", label: "Agent total", tokens: 100 },
    ]);
  });
});

describe("publicContextUsage", () => {
  test("publishes cached plan-quota windows on the shared account list", () => {
    seedPlanAccountWindowsForTests([
      { window: CURSOR_PLAN_WINDOW.api, label: "Other Models", usedPercent: 46.444 },
    ]);
    const state = newSessionState();
    state.usage = {
      turn: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
      account: [{ window: "agent", label: "Agent total", tokens: 3_000 }],
      updatedAt: new Date(1).toISOString(),
    };

    expect(publicContextUsage(state)?.account).toEqual([
      { window: CURSOR_PLAN_WINDOW.api, label: "Other Models", usedPercent: 46.444 },
      { window: "agent", label: "Agent total", tokens: 3_000 },
    ]);
    expect(peekPlanAccountWindows()?.[0]?.usedPercent).toBe(46.444);
  });
});

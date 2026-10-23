import { expect, test } from "bun:test";
import {
  USAGE_HISTORY_RETENTION_DAYS,
  addUsageTotals,
  emptyUsageTotals,
  isUsageDayKey,
  normalizeUsageHistoryQuery,
  shiftUsageDay,
  usageCount,
  usageDayKey,
  usageDayRange,
} from "./usage-history.js";

test("day keys follow the local calendar, not UTC", () => {
  // 23:30 local on the 20th is the 21st in UTC; the bucket is the day a user
  // would call it.
  expect(usageDayKey(new Date(2026, 9, 20, 23, 30))).toBe("2026-10-20");
  expect(usageDayKey(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  expect(isUsageDayKey("2026-10-20")).toBe(true);
  expect(isUsageDayKey("2026-10")).toBe(false);
});

test("shifting days crosses months, years and a leap day", () => {
  expect(shiftUsageDay("2026-03-01", 1)).toBe("2026-02-28");
  expect(shiftUsageDay("2024-03-01", 1)).toBe("2024-02-29");
  expect(shiftUsageDay("2026-01-01", 1)).toBe("2025-12-31");
  expect(shiftUsageDay("2026-01-01", -1)).toBe("2026-01-02");
});

test("a range lists every day inclusively and stays bounded", () => {
  expect(usageDayRange("2026-10-18", "2026-10-20")).toEqual([
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
  ]);
  expect(usageDayRange("2026-10-20", "2026-10-20")).toEqual(["2026-10-20"]);
  expect(usageDayRange("2026-10-21", "2026-10-20")).toEqual([]);
  expect(usageDayRange("1970-01-01", "2026-10-20").length).toBe(USAGE_HISTORY_RETENTION_DAYS + 1);
});

test("counts refuse anything that is not a real positive number", () => {
  expect(usageCount(5)).toBe(5);
  expect(usageCount(-5)).toBe(0);
  expect(usageCount(Number.NaN)).toBe(0);
  expect(usageCount(Number.POSITIVE_INFINITY)).toBe(0);
  expect(usageCount("5")).toBe(0);
  expect(usageCount(undefined)).toBe(0);
});

test("totals add field by field", () => {
  const target = emptyUsageTotals();
  addUsageTotals(target, { ...emptyUsageTotals(), totalTokens: 10, costUsd: 1, turns: 1 });
  addUsageTotals(target, { ...emptyUsageTotals(), totalTokens: 5, unpricedTokens: 5, turns: 1 });
  expect(target).toMatchObject({ totalTokens: 15, costUsd: 1, unpricedTokens: 5, turns: 2 });
});

test("a query is clamped and keeps only the filters it understands", () => {
  expect(normalizeUsageHistoryQuery({})).toEqual({ days: 30 });
  expect(normalizeUsageHistoryQuery({ days: 0 })).toEqual({ days: 1 });
  expect(normalizeUsageHistoryQuery({ days: 10_000 })).toEqual({
    days: USAGE_HISTORY_RETENTION_DAYS,
  });
  expect(normalizeUsageHistoryQuery({ days: 7, platform: "claude" })).toEqual({
    days: 7,
    platform: "claude",
  });
  expect(normalizeUsageHistoryQuery({ platform: "nope", environmentId: "  " })).toEqual({
    days: 30,
  });
});

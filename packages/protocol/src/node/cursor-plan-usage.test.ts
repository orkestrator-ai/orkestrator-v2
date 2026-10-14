import { describe, expect, test } from "bun:test";
import {
  accountWindowsFromPlanUsage,
  CURSOR_EXCHANGE_PATH,
  CURSOR_FALLBACK_TOKEN_LIFETIME_MS,
  CURSOR_PLAN_WINDOW,
  cursorDashboardPath,
  cursorExchangeAccessToken,
  cursorExchangeExpiryMs,
  isPlanQuotaWindow,
} from "./cursor-plan-usage.js";

/** A JWT whose only meaningful claim is the expiry this test needs. */
function tokenExpiringAt(epochSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: epochSeconds })).toString("base64url");
  return `header.${payload}.signature`;
}

describe("accountWindowsFromPlanUsage", () => {
  test("maps provider-reported pool percentages onto generic account windows", () => {
    expect(
      accountWindowsFromPlanUsage({
        billingCycleStart: Date.UTC(2026, 7, 1),
        billingCycleEnd: Date.UTC(2026, 8, 1),
        planUsage: { autoPercentUsed: 0, apiPercentUsed: 46.444 },
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

  test("falls back to the overall quota and never invents a percentage from spend", () => {
    expect(accountWindowsFromPlanUsage({ planUsage: { totalPercentUsed: 42 } })).toEqual([
      { window: CURSOR_PLAN_WINDOW.total, label: "Cursor quota", usedPercent: 42 },
    ]);
    expect(
      accountWindowsFromPlanUsage({ planUsage: { includedSpend: 23_222, limit: 40_000 } }),
    ).toEqual([]);
  });
});

describe("isPlanQuotaWindow", () => {
  test("accepts only provider plan rows, not session spend", () => {
    expect(isPlanQuotaWindow(CURSOR_PLAN_WINDOW.auto)).toBe(true);
    expect(isPlanQuotaWindow(CURSOR_PLAN_WINDOW.api)).toBe(true);
    expect(isPlanQuotaWindow(CURSOR_PLAN_WINDOW.total)).toBe(true);
    expect(isPlanQuotaWindow("session")).toBe(false);
    expect(isPlanQuotaWindow("agent")).toBe(false);
  });
});

describe("cursorExchangeAccessToken", () => {
  test("accepts each spelling of the exchanged token", () => {
    expect(cursorExchangeAccessToken({ accessToken: "a" })).toBe("a");
    expect(cursorExchangeAccessToken({ access_token: "b" })).toBe("b");
    expect(cursorExchangeAccessToken({ token: "c" })).toBe("c");
  });

  test("rejects an empty or missing token", () => {
    expect(cursorExchangeAccessToken({ accessToken: "" })).toBeUndefined();
    expect(cursorExchangeAccessToken(undefined)).toBeUndefined();
    expect(cursorExchangeAccessToken("nope")).toBeUndefined();
  });
});

describe("cursorExchangeExpiryMs", () => {
  const now = 1_700_000_000_000;

  test("takes the JWT expiry when the token carries one", () => {
    const token = tokenExpiringAt(1_700_000_500);
    expect(cursorExchangeExpiryMs({}, token, now)).toBe(1_700_000_500_000);
  });

  test("accepts expiresAt and an expiresIn delta", () => {
    expect(cursorExchangeExpiryMs({ expiresAt: now + 60_000 }, "opaque", now)).toBe(now + 60_000);
    expect(cursorExchangeExpiryMs({ expiresIn: 60 }, "opaque", now)).toBe(now + 60_000);
    expect(cursorExchangeExpiryMs({ expires_in: "60" }, "opaque", now)).toBe(now + 60_000);
  });

  test("falls back to the conservative lifetime with no usable expiry", () => {
    expect(cursorExchangeExpiryMs({}, "opaque", now)).toBe(now + CURSOR_FALLBACK_TOKEN_LIFETIME_MS);
  });
});

describe("Cursor request paths", () => {
  test("spells the exchange and dashboard endpoints once", () => {
    expect(CURSOR_EXCHANGE_PATH).toBe("/auth/exchange_user_api_key");
    expect(cursorDashboardPath("GetCurrentPeriodUsage")).toBe(
      "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    );
  });
});

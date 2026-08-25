import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DEBUG_LOG_RETENTION_DAYS,
  MAX_DEBUG_LOG_RETENTION_DAYS,
  MIN_DEBUG_LOG_RETENTION_DAYS,
  isValidDebugLogRetentionDays,
  normalizeDebugLogRetentionDays,
} from "./debug-logging";

describe("debug log retention", () => {
  test("accepts whole-day retention within the supported range", () => {
    expect(isValidDebugLogRetentionDays(MIN_DEBUG_LOG_RETENTION_DAYS)).toBe(true);
    expect(isValidDebugLogRetentionDays(MAX_DEBUG_LOG_RETENTION_DAYS)).toBe(true);
    expect(isValidDebugLogRetentionDays(0)).toBe(false);
    expect(isValidDebugLogRetentionDays(1.5)).toBe(false);
    expect(isValidDebugLogRetentionDays("7")).toBe(false);
  });

  test("uses the default for missing or invalid persisted values", () => {
    expect(normalizeDebugLogRetentionDays(undefined)).toBe(DEFAULT_DEBUG_LOG_RETENTION_DAYS);
    expect(normalizeDebugLogRetentionDays(-1)).toBe(DEFAULT_DEBUG_LOG_RETENTION_DAYS);
    expect(normalizeDebugLogRetentionDays(30)).toBe(30);
  });
});

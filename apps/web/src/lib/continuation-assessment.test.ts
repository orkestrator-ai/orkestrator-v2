import { describe, expect, test } from "bun:test";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import {
  assessContinuation,
  formatIdleDuration,
  formatLifetime,
  type ContinuationEvidence,
} from "./continuation-assessment";

const RESPONSE_AT = "2026-11-19T10:00:00.000Z";
const RESPONSE_MS = Date.parse(RESPONSE_AT);
const MINUTE = 60_000;

function turn(overrides: Partial<NativeAgentTurnUsage> = {}): NativeAgentTurnUsage {
  return {
    turnId: "t1",
    at: RESPONSE_AT,
    cacheAccessNotBefore: new Date(RESPONSE_MS - MINUTE).toISOString(),
    modelId: "claude-sonnet",
    cacheReadTokens: 40_000,
    cacheWriteTokens: 2_000,
    ...overrides,
  };
}

function assess(overrides: Partial<ContinuationEvidence> = {}) {
  return assessContinuation({
    provider: "claude",
    turns: [turn()],
    contextTokens: 120_000,
    nowMs: RESPONSE_MS + 2 * MINUTE,
    ...overrides,
  });
}

describe("assessContinuation", () => {
  test("a Claude response with cache use inside five minutes is likely warm", () => {
    const result = assess();
    expect(result.cache).toBe("likely-warm");
    expect(result.reason).toBe("within-minimum-lifetime");
    expect(result.idleMs).toBe(2 * MINUTE);
    expect(result.largeContext).toBe(true);
  });

  test("between Claude's five-minute and one-hour lifetimes the cache is unknown", () => {
    const result = assess({ nowMs: RESPONSE_MS + 20 * MINUTE });
    expect(result.cache).toBe("unknown");
    expect(result.reason).toBe("past-minimum-lifetime");
  });

  test("past the longest lifetime the cache is likely expired", () => {
    expect(assess({ nowMs: RESPONSE_MS + 60 * MINUTE }).cache).toBe("likely-expired");
    expect(assess({ provider: "codex", nowMs: RESPONSE_MS + 25 * 60 * MINUTE }).reason).toBe(
      "past-maximum-lifetime",
    );
  });

  test("an expired verdict does not depend on the last response's cache report", () => {
    const result = assess({
      turns: [turn({ cacheReadTokens: undefined, cacheWriteTokens: undefined })],
      nowMs: RESPONSE_MS + 2 * 60 * MINUTE,
    });
    expect(result.cache).toBe("likely-expired");
  });

  test("the verdict is anchored to the cache-access bound", () => {
    const first = assess({ nowMs: RESPONSE_MS + 3 * MINUTE });
    const later = assess({ nowMs: RESPONSE_MS + 4 * MINUTE });
    expect(first.cache).toBe("likely-warm");
    // Evaluating again does not extend the lifetime.
    expect(later.cache).toBe("unknown");
    expect(later.idleMs).toBe(4 * MINUTE);
  });

  test("recent completion alone cannot establish cache freshness", () => {
    const longTurn = turn({
      cacheAccessNotBefore: new Date(RESPONSE_MS - 12 * MINUTE).toISOString(),
    });
    for (const newest of [longTurn, turn({ cacheAccessNotBefore: undefined })]) {
      expect(assess({ turns: [newest] })).toMatchObject({
        cache: "unknown",
        reason: "cache-access-time-unknown",
        idleMs: 2 * MINUTE,
      });
    }
  });

  test("usage under a different model does not predict a warm cache", () => {
    expect(assess({ selectedModelId: "claude-opus" })).toMatchObject({
      cache: "unknown",
      reason: "model-mismatch",
    });
    expect(assess({ selectedModelId: "sonnet", resolvedModelId: "claude-sonnet" }).cache).toBe(
      "likely-warm",
    );
  });

  test("session-wide history alone never makes the cache warm", () => {
    const result = assess({ turns: [turn({ cacheReadTokens: 0, cacheWriteTokens: 0 })] });
    expect(result.cache).toBe("unknown");
    expect(result.reason).toBe("no-cache-activity");
    expect(
      assess({ turns: [turn({ cacheReadTokens: undefined, cacheWriteTokens: undefined })] }).reason,
    ).toBe("no-cache-report");
  });

  test("only the newest turn counts", () => {
    const result = assess({
      turns: [turn({ turnId: "old" }), turn({ turnId: "new", at: undefined })],
    });
    expect(result.reason).toBe("undated-response");
    expect(result.idleMs).toBeUndefined();
  });

  test("platforms without a published lifetime stay unknown but still report idle time", () => {
    for (const provider of ["opencode", "pi", "cursor", "grok"] as const) {
      const result = assess({ provider });
      expect(result.cache).toBe("unknown");
      expect(result.reason).toBe("lifetime-unknown");
      expect(result.idleMs).toBe(2 * MINUTE);
    }
    expect(assess({ provider: undefined }).reason).toBe("lifetime-unknown");
  });

  test("missing, unreadable or future timestamps are unknown", () => {
    expect(assess({ turns: [] }).reason).toBe("no-response");
    expect(assess({ turns: undefined }).reason).toBe("no-response");
    expect(assess({ turns: [turn({ at: "not a date" })] }).reason).toBe("clock-mismatch");
    expect(assess({ nowMs: RESPONSE_MS - 5 * MINUTE }).reason).toBe("clock-mismatch");
    expect(assess({ nowMs: Number.NaN }).reason).toBe("clock-mismatch");
  });

  test("small clock skew is tolerated as no idle time", () => {
    const result = assess({ nowMs: RESPONSE_MS - 10_000 });
    expect(result.cache).toBe("likely-warm");
    expect(result.idleMs).toBe(0);
  });

  test("a running response is not judged", () => {
    const result = assess({ running: true });
    expect(result.cache).toBe("unknown");
    expect(result.reason).toBe("response-running");
    expect(result.idleMs).toBeUndefined();
  });

  test("unmeasured or empty context is left out", () => {
    expect(assess({ contextTokens: undefined }).contextTokens).toBeUndefined();
    expect(assess({ contextTokens: 0 }).contextTokens).toBeUndefined();
    expect(assess({ contextTokens: Number.NaN }).largeContext).toBe(false);
    expect(assess({ contextTokens: 99_999 }).largeContext).toBe(false);
  });
});

describe("formatting", () => {
  test("idle durations are coarse", () => {
    expect(formatIdleDuration(45_000)).toBe("45s");
    expect(formatIdleDuration(12 * MINUTE + 30_000)).toBe("12m");
    expect(formatIdleDuration(60 * MINUTE)).toBe("1h");
    expect(formatIdleDuration(185 * MINUTE)).toBe("3h 5m");
    expect(formatIdleDuration(52 * 60 * MINUTE)).toBe("2d 4h");
    expect(formatIdleDuration(-5)).toBe("0s");
  });

  test("lifetimes read as minutes or hours", () => {
    expect(formatLifetime(5 * MINUTE)).toBe("5 minutes");
    expect(formatLifetime(60 * MINUTE)).toBe("1 hour");
    expect(formatLifetime(24 * 60 * MINUTE)).toBe("24 hours");
  });
});

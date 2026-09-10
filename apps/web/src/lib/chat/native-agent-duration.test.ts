import { describe, expect, test } from "bun:test";
import {
  formatAgentDurationMs,
  formatNativeAgentElapsed,
  nativeAgentElapsedMs,
} from "./native-agent-duration";

describe("formatAgentDurationMs", () => {
  test("keeps sub-second settled runtimes in milliseconds", () => {
    expect(formatAgentDurationMs(28)).toBe("28ms");
    expect(formatAgentDurationMs(0)).toBe("0ms");
  });

  test("uses tenths of a second below ten seconds", () => {
    expect(formatAgentDurationMs(1_240)).toBe("1.2s");
    expect(formatAgentDurationMs(9_000)).toBe("9s");
  });

  test("uses the shared elapsed formatter from ten seconds", () => {
    expect(formatAgentDurationMs(10_000)).toBe("10s");
    expect(formatAgentDurationMs(125_000)).toBe("2m 5s");
  });

  test("carries an hour unit for a task that outlived its turn", () => {
    // A background task is the child that routinely runs for hours, and the
    // minute-only formatter would report the second of these as "185m 3s".
    expect(formatAgentDurationMs(3_600_000)).toBe("1h 0m 0s");
    expect(formatAgentDurationMs(11_103_000)).toBe("3h 5m 3s");
  });
});

describe("nativeAgentElapsedMs", () => {
  const startedAt = "2026-03-21T10:00:00.000Z";
  const now = Date.parse(startedAt) + 125_000;

  test("ticks an active agent from the backend launch timestamp", () => {
    expect(
      nativeAgentElapsedMs({
        status: "active",
        startedAt,
        durationMs: 28,
        now,
      }),
    ).toBe(125_000);
  });

  test("does not invent an active runtime without a backend launch clock", () => {
    expect(
      nativeAgentElapsedMs({
        status: "active",
        durationMs: 28,
        now,
      }),
    ).toBeUndefined();
  });

  test("ignores a malformed launch timestamp rather than using vendor spawn duration", () => {
    expect(
      nativeAgentElapsedMs({
        status: "active",
        startedAt: "not-a-date",
        durationMs: 28,
        now,
      }),
    ).toBeUndefined();
  });

  test("uses the backend-stamped duration once the agent has settled", () => {
    expect(
      nativeAgentElapsedMs({
        status: "finished",
        startedAt,
        durationMs: 1_240,
        now,
      }),
    ).toBe(1_240);
    expect(
      nativeAgentElapsedMs({
        status: "failed",
        startedAt,
        durationMs: 900,
        now,
      }),
    ).toBe(900);
  });

  test("does not invent a settled duration when the backend omitted one", () => {
    expect(
      nativeAgentElapsedMs({
        status: "finished",
        startedAt,
        now,
      }),
    ).toBeUndefined();
  });
});

describe("formatNativeAgentElapsed", () => {
  test("formats an active runtime in whole seconds", () => {
    expect(formatNativeAgentElapsed({ status: "active", elapsedMs: 125_000 })).toBe("2m 5s");
    expect(formatNativeAgentElapsed({ status: "active", elapsedMs: 28 })).toBe("0s");
  });

  test("carries an hour unit while a long-running task is still ticking", () => {
    expect(formatNativeAgentElapsed({ status: "active", elapsedMs: 11_103_400 })).toBe("3h 5m 3s");
  });

  test("formats a settled runtime with millisecond precision under one second", () => {
    expect(formatNativeAgentElapsed({ status: "finished", elapsedMs: 1_240 })).toBe("1.2s");
    expect(formatNativeAgentElapsed({ status: "failed", elapsedMs: 28 })).toBe("28ms");
  });

  test("returns nothing when no elapsed value is available", () => {
    expect(formatNativeAgentElapsed({ status: "active" })).toBeUndefined();
    expect(formatNativeAgentElapsed({ status: "finished" })).toBeUndefined();
  });
});

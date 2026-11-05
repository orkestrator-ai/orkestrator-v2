import { expect, test } from "bun:test";
import {
  agentAccountSwitchEffect,
  classifyUsageLimitError,
  exhaustedUsageWindows,
  turnFailureKind,
  USAGE_LIMIT_ERROR_CODE,
  usageLimitFailure,
  usageWindowView,
} from "./agent-usage-limits.js";

test("provider usage-limit failures are recognised, with the reset when given", () => {
  expect(classifyUsageLimitError("Claude AI usage limit reached|1761840000")).toEqual({});
  expect(classifyUsageLimitError("You've hit your limit · resets 3pm (Europe/London)")).toEqual({
    resetHint: "3pm (Europe/London)",
  });
  expect(
    classifyUsageLimitError("You've hit your usage limit. Upgrade to Pro or try again at 3:05 PM."),
  ).toEqual({ resetHint: "3:05 PM" });
  expect(classifyUsageLimitError("usageLimitExceeded")).toEqual({});
  expect(classifyUsageLimitError("Grok request failed: USAGE_EXHAUSTED")).toEqual({});
  expect(classifyUsageLimitError("Go limit reached")).toEqual({});
  expect(classifyUsageLimitError("insufficient_quota: You exceeded your current quota")).toEqual(
    {},
  );
});

test("other failures are not usage limits", () => {
  for (const text of [
    "Context limit reached; compact the conversation",
    "prompt is too long: 210000 tokens > 200000 maximum",
    "429 Too Many Requests",
    "Overloaded",
    "OAuth session expired and could not be refreshed",
    "",
    undefined,
  ]) {
    expect(classifyUsageLimitError(text)).toBeNull();
  }
});

test("a window counts as used up only until it resets", () => {
  const now = Date.parse("2026-10-30T10:00:00Z");
  const windows = [
    { window: "five_hour", usedPercent: 100, resetsAt: "2026-10-30T12:00:00Z" },
    { window: "seven_day", usedPercent: 100, resetsAt: "2026-10-30T09:00:00Z" },
    { window: "opus", usedPercent: 40 },
  ];
  expect(exhaustedUsageWindows(windows, now)).toEqual([
    {
      window: "five_hour",
      usedPercent: 100,
      remainingPercent: 0,
      resetsAt: "2026-10-30T12:00:00Z",
    },
  ]);
  // A reset that has passed reads as empty again.
  expect(usageWindowView(windows[1]!, now)).toEqual({
    window: "seven_day",
    usedPercent: 0,
    remainingPercent: 100,
  });
  expect(usageWindowView(windows[2]!, now)).toEqual({
    window: "opus",
    usedPercent: 40,
    remainingPercent: 60,
  });
});

test("the switch effect says it is machine-wide and needs no restart", () => {
  const effect = agentAccountSwitchEffect("codex");
  expect(effect).toContain("Machine-wide");
  expect(effect).toContain("next turn");
  expect(effect).toContain("No restart");
});

test("a failed turn is a usage limit by the provider's signal or, failing that, by its text", () => {
  expect(usageLimitFailure({ failureKind: "usage-limit", error: "Your plan is paused." })).toEqual({
    signal: "provider",
  });
  expect(
    usageLimitFailure({ failureKind: "usage-limit", error: "You've hit your limit · resets 3pm" }),
  ).toEqual({ signal: "provider", resetHint: "3pm" });
  // An older bridge or record sends no kind: the text decides.
  expect(usageLimitFailure({ error: "You've hit your limit · resets 3pm" })).toEqual({
    signal: "text",
    resetHint: "3pm",
  });
  expect(usageLimitFailure({ error: "Overloaded" })).toBeNull();
  // An unknown kind is not a usage limit.
  expect(usageLimitFailure({ failureKind: "rate-limit", error: "Overloaded" })).toBeNull();
  expect(turnFailureKind("usage-limit")).toBe(USAGE_LIMIT_ERROR_CODE);
  expect(turnFailureKind("usageLimitExceeded")).toBeUndefined();
});

import { expect, test } from "bun:test";
import { nativeTerminalMessages } from "./native-terminal-messages.js";

test("terminal rows use a stable real turn time, falling back to the epoch when unavailable", () => {
  const turnStartedAt = Date.parse("2026-10-27T12:00:00.000Z");
  const input = { error: "Authentication failed", turnStartedAt };
  const rows = nativeTerminalMessages(input);
  expect(rows[0]?.createdAt).toBe("2026-10-27T12:00:00.000Z");
  expect(nativeTerminalMessages(input)).toEqual(rows);
  const fallback = nativeTerminalMessages({ error: input.error });
  expect(fallback[0]?.createdAt).toBe("1970-01-01T00:00:00.000Z");
  expect(fallback[0]?.id).toBe(rows[0]?.id);
});

test("the session error's row carries the bridge's structured failure reason", () => {
  const rows = nativeTerminalMessages({
    notices: [{ kind: "stopped", message: "Stopped by the user" }],
    error: "Claude ended the turn on an API error.",
    failureReason: "billing",
  });
  expect(rows.map((row) => row.failure)).toEqual([undefined, { reason: "billing" }]);
  expect(nativeTerminalMessages({ error: "x" })[0]).not.toHaveProperty("failure");
});

test("a usage limit's row carries the earliest reset of a window the provider reported used up", () => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");
  const [row] = nativeTerminalMessages({
    error: "You've hit your limit",
    failureReason: "usage-limit",
    rateLimits: [
      { label: "Weekly", usedPercent: 100, resetsAt: "2026-11-21T00:00:00.000Z" },
      { label: "5-hour", usedPercent: 100, resetsAt: "2026-11-19T12:00:00.000Z" },
      { label: "Spare", usedPercent: 40, resetsAt: "2026-11-19T11:00:00.000Z" },
      { label: "Past", usedPercent: 100, resetsAt: "2026-11-19T09:00:00.000Z" },
    ],
    now,
  });
  expect(row?.failure).toEqual({ reason: "usage-limit", resetsAt: "2026-11-19T12:00:00.000Z" });
  // A window time is attached only to a usage limit.
  const [other] = nativeTerminalMessages({
    error: "Overloaded",
    failureReason: "provider-unavailable",
    rateLimits: [{ label: "5-hour", usedPercent: 100, resetsAt: "2026-11-19T12:00:00.000Z" }],
    now,
  });
  expect(other?.failure).toEqual({ reason: "provider-unavailable" });
});

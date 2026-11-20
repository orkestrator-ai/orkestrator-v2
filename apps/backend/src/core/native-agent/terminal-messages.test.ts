import { expect, test } from "bun:test";
import { providerFailureRetryRequestId } from "@orkestrator/protocol/provider-failures";
import { nativeTerminalMessages } from "./terminal-messages.js";

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

test("a usage limit prefers the rejecting window and omits an ambiguous reset", () => {
  const now = Date.parse("2026-11-19T10:00:00.000Z");
  const input = {
    error: "You've hit your limit",
    failureReason: "usage-limit" as const,
    rateLimits: [
      { label: "Weekly", usedPercent: 100, resetsAt: "2026-11-21T00:00:00.000Z" },
      { label: "5-hour", usedPercent: 100, resetsAt: "2026-11-19T12:00:00.000Z" },
      { label: "Spare", usedPercent: 40, resetsAt: "2026-11-19T11:00:00.000Z" },
      { label: "Past", usedPercent: 100, resetsAt: "2026-11-19T09:00:00.000Z" },
    ],
    now,
  };
  expect(nativeTerminalMessages(input)[0]?.failure).toEqual({ reason: "usage-limit" });
  const [row] = nativeTerminalMessages({
    ...input,
    failedTurn: {
      id: "turn-1",
      occurredAt: new Date(now).toISOString(),
      resetsAt: "2026-11-21T00:00:00.000Z",
    },
  });
  expect(row?.failure).toEqual({ reason: "usage-limit", resetsAt: "2026-11-21T00:00:00.000Z" });
  // A window time is attached only to a usage limit.
  const [other] = nativeTerminalMessages({
    error: "Overloaded",
    failureReason: "provider-unavailable",
    rateLimits: [{ label: "5-hour", usedPercent: 100, resetsAt: "2026-11-19T12:00:00.000Z" }],
    now,
  });
  expect(other?.failure).toEqual({ reason: "provider-unavailable" });
});

test("byte-identical failure text yields one stable retry ID per occurrence", () => {
  const failure = (id: string, occurredAt: string) =>
    nativeTerminalMessages({ error: "API error", failedTurn: { id, occurredAt } })[0]!;
  const first = failure("turn-1", "2026-11-19T10:00:00.000Z");
  const second = failure("turn-2", "2026-11-19T10:00:01.000Z");
  expect(failure("turn-1", first.createdAt)).toEqual(first);
  expect(second.id).not.toBe(first.id);
  expect(second.createdAt).not.toBe(first.createdAt);
  expect(providerFailureRetryRequestId(second.id, second.createdAt)).not.toBe(
    providerFailureRetryRequestId(first.id, first.createdAt),
  );
});

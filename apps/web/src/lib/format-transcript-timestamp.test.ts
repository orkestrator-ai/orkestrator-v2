import { afterEach, describe, expect, test } from "bun:test";
import { formatTranscriptTimestamp } from "./format-transcript-timestamp";

const TIME = { hour: "2-digit", minute: "2-digit" } as const;

/** A local wall-clock time, so the tests hold in any host time zone. */
function local(year: number, month: number, day: number, hour = 10, minute = 30): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

describe("formatTranscriptTimestamp", () => {
  const originalTime = Date.prototype.toLocaleTimeString;
  afterEach(() => {
    Date.prototype.toLocaleTimeString = originalTime;
  });

  test("shows only the time for a block from today", () => {
    const now = local(2026, 11, 10, 18, 0);
    const createdAt = local(2026, 11, 10, 0, 1);
    expect(formatTranscriptTimestamp(createdAt.toISOString(), now)).toBe(
      createdAt.toLocaleTimeString(undefined, TIME),
    );
  });

  test("adds the month and day for a block from an earlier day this year", () => {
    const now = local(2026, 11, 10, 0, 5);
    const createdAt = local(2026, 11, 9, 23, 59);
    const day = createdAt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const label = formatTranscriptTimestamp(createdAt.toISOString(), now);
    expect(label).toBe(`${day}, ${createdAt.toLocaleTimeString(undefined, TIME)}`);
    expect(label).not.toContain("2026");
  });

  test("adds the year for a block from another year", () => {
    const now = local(2026, 1, 2);
    const createdAt = local(2025, 12, 31);
    const day = createdAt.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const label = formatTranscriptTimestamp(createdAt.toISOString(), now);
    expect(label).toBe(`${day}, ${createdAt.toLocaleTimeString(undefined, TIME)}`);
    expect(label).toContain("2025");
  });

  test("dates a block from a later day too, such as one from a skewed clock", () => {
    const now = local(2026, 11, 10);
    const createdAt = local(2026, 11, 11);
    expect(formatTranscriptTimestamp(createdAt.toISOString(), now)).not.toBe(
      createdAt.toLocaleTimeString(undefined, TIME),
    );
  });

  test("returns an empty label for an unparseable timestamp", () => {
    expect(formatTranscriptTimestamp("not a date", local(2026, 11, 10))).toBe("");
  });

  test("returns an empty label when the platform formatter throws", () => {
    Date.prototype.toLocaleTimeString = function failingFormatter() {
      throw new RangeError("formatter unavailable");
    };
    expect(formatTranscriptTimestamp(local(2026, 11, 10).toISOString(), local(2026, 11, 10))).toBe(
      "",
    );
  });
});

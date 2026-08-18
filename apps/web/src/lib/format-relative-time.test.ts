import { describe, expect, test } from "bun:test";
import { formatRelativeTime, formatRelativeTimeFromUnixSeconds } from "./format-relative-time";

const NOW = new Date("2026-07-27T12:00:00.000Z");

/** `NOW` minus `seconds`, as the ISO string the session APIs actually return. */
function agoIso(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe("formatRelativeTime", () => {
  test("reports anything under a minute as just now", () => {
    expect(formatRelativeTime(agoIso(0), NOW)).toBe("just now");
    expect(formatRelativeTime(agoIso(59), NOW)).toBe("just now");
  });

  test("switches unit exactly on each threshold, not one tick early", () => {
    expect(formatRelativeTime(agoIso(60), NOW)).toBe("1m ago");
    expect(formatRelativeTime(agoIso(60 * 60 - 1), NOW)).toBe("59m ago");
    expect(formatRelativeTime(agoIso(60 * 60), NOW)).toBe("1h ago");
    expect(formatRelativeTime(agoIso(24 * 60 * 60 - 1), NOW)).toBe("23h ago");
    expect(formatRelativeTime(agoIso(24 * 60 * 60), NOW)).toBe("1d ago");
    expect(formatRelativeTime(agoIso(7 * 24 * 60 * 60 - 1), NOW)).toBe("6d ago");
  });

  test("falls back to a locale date once the age passes a week", () => {
    const weekOld = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(weekOld.toISOString(), NOW)).toBe(weekOld.toLocaleDateString());
  });

  test("clamps a future timestamp instead of rendering a negative age", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe("just now");
  });

  test("reports unknown for missing or unparseable input", () => {
    // The resume pickers render whatever the server sent; before this helper a
    // malformed timestamp surfaced to the user as "NaNm ago".
    expect(formatRelativeTime(null, NOW)).toBe("unknown");
    expect(formatRelativeTime(undefined, NOW)).toBe("unknown");
    expect(formatRelativeTime("", NOW)).toBe("unknown");
    expect(formatRelativeTime("not a date", NOW)).toBe("unknown");
    expect(formatRelativeTime(Number.NaN, NOW)).toBe("unknown");
  });

  test("accepts Date and epoch-millisecond inputs as well as strings", () => {
    const fiveMinutesAgo = NOW.getTime() - 5 * 60 * 1000;
    expect(formatRelativeTime(new Date(fiveMinutesAgo), NOW)).toBe("5m ago");
    expect(formatRelativeTime(fiveMinutesAgo, NOW)).toBe("5m ago");
  });
});

describe("formatRelativeTimeFromUnixSeconds", () => {
  test("converts seconds to milliseconds before formatting", () => {
    const secondsSinceEpoch = Math.floor(NOW.getTime() / 1000) - 2 * 60 * 60;
    expect(formatRelativeTimeFromUnixSeconds(secondsSinceEpoch, NOW)).toBe("2h ago");
  });

  test("treats a missing or zero timestamp as unknown", () => {
    // tmux reports 0 for a session it has no activity record for; multiplying
    // that up would date it to 1970 rather than admitting it is unknown.
    expect(formatRelativeTimeFromUnixSeconds(0, NOW)).toBe("unknown");
    expect(formatRelativeTimeFromUnixSeconds(null, NOW)).toBe("unknown");
    expect(formatRelativeTimeFromUnixSeconds(undefined, NOW)).toBe("unknown");
  });
});

import { describe, expect, test } from "bun:test";
import {
  formatInstantInZone,
  instantsForWallTime,
  isValidTimeZone,
  nextCronFire,
  parseCronExpression,
  resolveOneShotTime,
  resolveWallTime,
  ScheduleTimeError,
  timeZoneOffsetMs,
} from "./schedule-time.js";

const LONDON = "Europe/London";
const NEW_YORK = "America/New_York";

function fires(expression: string, zone: string, fromIso: string, count: number): string[] {
  const cron = parseCronExpression(expression);
  const result: string[] = [];
  let cursor = Date.parse(fromIso);
  for (let index = 0; index < count; index += 1) {
    const next = nextCronFire(cron, zone, cursor);
    if (next === null) break;
    result.push(new Date(next).toISOString());
    cursor = next;
  }
  return result;
}

describe("time zones", () => {
  test("offsets follow GMT and BST", () => {
    expect(timeZoneOffsetMs(Date.parse("2026-07-01T12:00:00Z"), LONDON)).toBe(3_600_000);
    expect(timeZoneOffsetMs(Date.parse("2026-12-01T12:00:00Z"), LONDON)).toBe(0);
    expect(isValidTimeZone(LONDON)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  test("a skipped wall time has no instant and resolves forward by the gap", () => {
    const wall = { year: 2026, month: 3, day: 29, hour: 1, minute: 30 };
    expect(instantsForWallTime(wall, LONDON)).toEqual([]);
    expect(new Date(resolveWallTime(wall, LONDON)).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(formatInstantInZone(resolveWallTime(wall, LONDON), LONDON)).toBe("2026-03-29 02:30 BST");
  });

  test("a repeated wall time has two instants and resolves to the first", () => {
    const wall = { year: 2026, month: 10, day: 25, hour: 1, minute: 30 };
    expect(instantsForWallTime(wall, LONDON).map((ms) => new Date(ms).toISOString())).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:30:00.000Z",
    ]);
    expect(new Date(resolveWallTime(wall, LONDON)).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("cron parsing", () => {
  test("fields, lists, ranges, steps, names and macros", () => {
    const cron = parseCronExpression("*/15 9-17 * jan,jul mon-fri");
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.months]).toEqual([1, 7]);
    expect([...cron.weekdays].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(parseCronExpression("0 0 * * 7").weekdays.has(0)).toBe(true);
    expect(parseCronExpression("@daily").source).toBe("@daily");
    expect(parseCronExpression("@hourly").anyHour).toBe(true);
    expect(parseCronExpression("@daily").anyHour).toBe(false);
    expect(parseCronExpression("5 * * * *").anyHour).toBe(true);
  });

  test("rejects malformed expressions", () => {
    for (const bad of [
      "",
      "* * * *",
      "61 * * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "a b c d e",
    ]) {
      expect(() => parseCronExpression(bad)).toThrow(ScheduleTimeError);
    }
  });

  test("an expression that never fires returns null", () => {
    expect(
      nextCronFire(parseCronExpression("0 0 31 2 *"), "UTC", Date.parse("2026-01-01T00:00:00Z")),
    ).toBeNull();
  });

  test("day-of-month and day-of-week combine with OR when both are restricted", () => {
    // The 1st of the month or any Monday.
    expect(fires("0 12 1 * mon", "UTC", "2026-11-28T00:00:00Z", 3)).toEqual([
      "2026-11-30T12:00:00.000Z",
      "2026-12-01T12:00:00.000Z",
      "2026-12-07T12:00:00.000Z",
    ]);
  });
});

describe("cron across DST", () => {
  test("a fixed time inside the spring-forward gap fires once, shifted by the gap", () => {
    expect(fires("30 1 * * *", LONDON, "2026-03-28T12:00:00Z", 3)).toEqual([
      "2026-03-29T01:30:00.000Z", // 02:30 BST: 01:30 did not exist
      "2026-03-30T00:30:00.000Z", // 01:30 BST
      "2026-03-31T00:30:00.000Z",
    ]);
  });

  test("a fixed time in the repeated autumn hour fires once, at its first occurrence", () => {
    expect(fires("30 1 * * *", LONDON, "2026-10-24T12:00:00Z", 3)).toEqual([
      "2026-10-25T00:30:00.000Z", // 01:30 BST
      "2026-10-26T01:30:00.000Z", // 01:30 GMT
      "2026-10-27T01:30:00.000Z",
    ]);
  });

  test("a wildcard-hour expression keeps real-time rhythm through fall-back", () => {
    expect(fires("*/30 * * * *", LONDON, "2026-10-24T23:50:00Z", 6)).toEqual([
      "2026-10-25T00:00:00.000Z", // 01:00 BST
      "2026-10-25T00:30:00.000Z", // 01:30 BST
      "2026-10-25T01:00:00.000Z", // 01:00 GMT
      "2026-10-25T01:30:00.000Z", // 01:30 GMT
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T02:30:00.000Z",
    ]);
  });

  test("a wildcard-hour expression skips the missing hour in spring", () => {
    expect(fires("0 * * * *", LONDON, "2026-03-28T23:30:00Z", 3)).toEqual([
      "2026-03-29T00:00:00.000Z", // 00:00 GMT
      "2026-03-29T01:00:00.000Z", // 02:00 BST (01:00 GMT shifted)
      "2026-03-29T02:00:00.000Z", // 03:00 BST
    ]);
  });

  test("daily 09:00 stays at local 09:00 across a US change", () => {
    expect(fires("0 9 * * *", NEW_YORK, "2026-03-07T00:00:00Z", 3)).toEqual([
      "2026-03-07T14:00:00.000Z", // EST
      "2026-03-08T13:00:00.000Z", // EDT
      "2026-03-09T13:00:00.000Z",
    ]);
  });

  test("every-minute search stays fast on a transition day", () => {
    const cron = parseCronExpression("* * * * *");
    let cursor = Date.parse("2026-10-25T00:00:00Z");
    const started = performance.now();
    for (let index = 0; index < 200; index += 1) cursor = nextCronFire(cron, LONDON, cursor)!;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(new Date(cursor).toISOString()).toBe("2026-10-25T03:20:00.000Z");
  });
});

describe("one-shot times", () => {
  const now = Date.parse("2026-10-25T10:00:00Z"); // 10:00 GMT, after the change

  test("HH:MM is the next occurrence in the zone", () => {
    expect(new Date(resolveOneShotTime("03:12", LONDON, now)).toISOString()).toBe(
      "2026-10-26T03:12:00.000Z",
    );
    expect(new Date(resolveOneShotTime("11:00", LONDON, now)).toISOString()).toBe(
      "2026-10-25T11:00:00.000Z",
    );
    expect(new Date(resolveOneShotTime("03:12", NEW_YORK, now)).toISOString()).toBe(
      "2026-10-26T07:12:00.000Z",
    );
  });

  test("local date-times, offsets and relative times", () => {
    expect(new Date(resolveOneShotTime("2026-07-01T08:00", LONDON, now)).toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(new Date(resolveOneShotTime("2026-07-01 08:00", LONDON, now)).toISOString()).toBe(
      "2026-07-01T07:00:00.000Z",
    );
    expect(
      new Date(resolveOneShotTime("2026-07-01T08:00:00+02:00", LONDON, now)).toISOString(),
    ).toBe("2026-07-01T06:00:00.000Z");
    expect(resolveOneShotTime("+1h30m", LONDON, now) - now).toBe(90 * 60_000);
    expect(resolveOneShotTime("+45s", LONDON, now) - now).toBe(45_000);
  });

  test("rejects nonsense", () => {
    for (const bad of ["tomorrow", "25:00", "2026-02-30T10:00", "+0m", "+5x"]) {
      expect(() => resolveOneShotTime(bad, LONDON, now)).toThrow(ScheduleTimeError);
    }
  });
});

import { describe, test, expect } from "bun:test";
import { formatElapsed, formatElapsedWithHours } from "./format-elapsed";

describe("formatElapsed", () => {
  test("formats 0 seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  test("formats seconds under a minute", () => {
    expect(formatElapsed(1)).toBe("1s");
    expect(formatElapsed(30)).toBe("30s");
    expect(formatElapsed(59)).toBe("59s");
  });

  test("formats exactly 60 seconds as 1m 0s", () => {
    expect(formatElapsed(60)).toBe("1m 0s");
  });

  test("formats minutes and seconds", () => {
    expect(formatElapsed(90)).toBe("1m 30s");
    expect(formatElapsed(125)).toBe("2m 5s");
  });

  test("formats large values", () => {
    expect(formatElapsed(3661)).toBe("61m 1s");
  });
});

describe("formatElapsedWithHours", () => {
  test("matches the minute-only formatter below an hour", () => {
    expect(formatElapsedWithHours(0)).toBe("0s");
    expect(formatElapsedWithHours(59)).toBe("59s");
    expect(formatElapsedWithHours(125)).toBe("2m 5s");
    expect(formatElapsedWithHours(3599)).toBe("59m 59s");
  });

  test("carries an hour unit from exactly one hour", () => {
    expect(formatElapsedWithHours(3600)).toBe("1h 0m 0s");
    expect(formatElapsedWithHours(3661)).toBe("1h 1m 1s");
  });

  test("keeps a task that outlived its turn readable", () => {
    // The whole point of the second formatter: `formatElapsed` reports this as
    // "185m 3s", which the reader has to divide before it means anything.
    expect(formatElapsedWithHours(11_103)).toBe("3h 5m 3s");
    expect(formatElapsedWithHours(90_061)).toBe("25h 1m 1s");
  });
});

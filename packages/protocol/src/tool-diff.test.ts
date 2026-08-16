import { describe, expect, test } from "bun:test";
import { countTextLines, lineChangeStatsFromSides } from "./tool-diff";

describe("tool diff line stats", () => {
  test("counts logical lines without treating a trailing newline as another line", () => {
    expect(countTextLines(undefined)).toBe(0);
    expect(countTextLines("")).toBe(0);
    expect(countTextLines("one")).toBe(1);
    expect(countTextLines("one\ntwo")).toBe(2);
    expect(countTextLines("one\ntwo\n")).toBe(2);
    expect(countTextLines("\n\n")).toBe(2);
  });

  test("derives compact additions and deletions only when a side is known", () => {
    expect(lineChangeStatsFromSides(undefined, undefined)).toBeUndefined();
    expect(lineChangeStatsFromSides("old\nlines", "new\nlines\nhere")).toEqual({
      additions: 3,
      deletions: 2,
    });
    expect(lineChangeStatsFromSides("", "created\nfile\n")).toEqual({
      additions: 2,
      deletions: 0,
    });
  });
});

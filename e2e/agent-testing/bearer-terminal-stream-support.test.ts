import { describe, expect, test } from "bun:test";
import { openAt, percentile } from "./bearer-terminal-stream-support";

describe("bearer terminal stream support", () => {
  test("one stream open across the whole window", () => {
    expect(openAt([{ at: 0 }], 10, 20)).toEqual({ min: 1, max: 1, overlapping: 1 });
  });

  test("a stream that ends inside the window leaves none open", () => {
    expect(openAt([{ at: 0, closedAt: 15 }], 10, 20)).toEqual({ min: 0, max: 1, overlapping: 1 });
  });

  test("make-before-break shows two open for a moment, then one", () => {
    const streams = [{ at: 0, closedAt: 16 }, { at: 14 }];
    expect(openAt(streams, 10, 20)).toEqual({ min: 1, max: 2, overlapping: 2 });
    expect(openAt(streams, 17, 20)).toEqual({ min: 1, max: 1, overlapping: 1 });
  });

  test("a close and an open at the same instant are a replacement", () => {
    expect(openAt([{ at: 0, closedAt: 15 }, { at: 15 }], 10, 20)).toEqual({
      min: 1,
      max: 1,
      overlapping: 2,
    });
  });

  test("requests outside the window are ignored", () => {
    const streams = [{ at: 0, closedAt: 5 }, { at: 25 }, { at: 12, closedAt: 18 }];
    expect(openAt(streams, 10, 20)).toEqual({ min: 0, max: 1, overlapping: 1 });
    expect(openAt([], 10, 20)).toEqual({ min: 0, max: 0, overlapping: 0 });
  });

  test("nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([30, 10, 20], 0.5)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([5], 0.99)).toBe(5);
  });
});

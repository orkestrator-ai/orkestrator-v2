import { expect, test } from "bun:test";
import { niceCeiling } from "./UsageTrendChart";

test("the scale tops out just above the busiest value, not far above it", () => {
  expect(niceCeiling(0)).toBe(1);
  expect(niceCeiling(-5)).toBe(1);
  expect(niceCeiling(Number.NaN)).toBe(1);
  expect(niceCeiling(1)).toBe(1);
  expect(niceCeiling(26_000_000)).toBe(30_000_000);
  expect(niceCeiling(9_400)).toBe(10_000);
  expect(niceCeiling(10_500)).toBe(12_000);
  expect(niceCeiling(0.42)).toBeCloseTo(0.5, 10);
  // Never below the value it has to hold.
  for (const value of [1, 7, 31, 260, 4_100, 55_000, 612_345, 9_999_999]) {
    expect(niceCeiling(value)).toBeGreaterThanOrEqual(value);
    // And never more than double it, so the chart keeps its height.
    expect(niceCeiling(value)).toBeLessThanOrEqual(value * 2);
  }
});

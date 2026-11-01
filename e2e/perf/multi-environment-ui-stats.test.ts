import { describe, expect, test } from "bun:test";
import {
  cpuBusyPercent,
  distribution,
  frameSummary,
  longTaskSummary,
  medianRatio,
  parseCpuPercent,
  parseProcStat,
  percentile,
} from "./multi-environment-ui-stats";

describe("multi-environment UI probe statistics", () => {
  test("percentile uses the nearest rank and is null without samples", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(percentile(values, 1)).toBe(20);
    expect(percentile(values, 0)).toBe(1);
  });

  test("a missed sample is counted, never averaged in as zero", () => {
    const summary = distribution([30, null, 10, 20, Number.NaN]);
    expect(summary).toEqual({ count: 3, missed: 2, min: 10, median: 20, p95: 30, max: 30 });
    expect(distribution([null])).toEqual({
      count: 0,
      missed: 1,
      min: null,
      median: null,
      p95: null,
      max: null,
    });
  });

  test("frame timestamps become intervals, stalls and a frame rate", () => {
    const summary = frameSummary([0, 16, 32, 132, 148]);
    expect(summary.frames).toBe(5);
    expect(summary.interval.max).toBe(100);
    expect(summary.interval.median).toBe(16);
    expect(summary.over50ms).toBe(1);
    expect(summary.fps).toBe(27);
    expect(frameSummary([5]).fps).toBeNull();
  });

  test("long tasks sum and keep the longest", () => {
    expect(longTaskSummary([])).toEqual({ count: 0, totalMs: 0, maxMs: null });
    expect(longTaskSummary([51.2, 120.6])).toEqual({ count: 2, totalMs: 172, maxMs: 121 });
  });

  test("host CPU use comes from two /proc/stat readings", () => {
    const before = parseProcStat("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4\n");
    const after = parseProcStat("cpu  400 0 150 1300 50 0 0 0 0 0\n");
    expect(before).toEqual({ busy: 150, total: 1000 });
    expect(after).toEqual({ busy: 550, total: 1900 });
    expect(cpuBusyPercent(before, after)).toBe(44.4);
    expect(cpuBusyPercent(after, after)).toBeNull();
    expect(cpuBusyPercent(null, after)).toBeNull();
    expect(parseProcStat("intr 1 2 3")).toBeNull();
  });

  test("docker stats CPU percentages parse, anything else is unknown", () => {
    expect(parseCpuPercent("187.53%")).toBe(187.53);
    expect(parseCpuPercent(" 0.00% ")).toBe(0);
    expect(parseCpuPercent("--")).toBeNull();
    expect(parseCpuPercent("")).toBeNull();
  });

  test("the busy-against-idle ratio needs both medians", () => {
    const idle = distribution([10, 20, 30]);
    const busy = distribution([30, 40, 50]);
    expect(medianRatio(busy, idle)).toBe(2);
    expect(medianRatio(busy, distribution([]))).toBeNull();
    expect(medianRatio(distribution([0]), distribution([0]))).toBeNull();
  });
});

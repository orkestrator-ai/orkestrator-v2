import { describe, expect, test } from "bun:test";
import { PreviewMetrics } from "./preview-metrics.js";

describe("PreviewMetrics histograms", () => {
  test("keeps the newest 512 samples once full", () => {
    const metrics = new PreviewMetrics();
    for (let value = 1; value <= 1_000; value += 1) metrics.observe("http.connect_ms", value);
    const histogram = metrics.snapshot().histograms["http.connect_ms"]!;
    expect(histogram.count).toBe(512);
    expect(histogram.max).toBe(1_000);
    // 489 is the oldest of the newest 512, so the median sits above it.
    expect(histogram.p50).toBe(745);
  });

  test("refuses a value that is not a duration", () => {
    const metrics = new PreviewMetrics();
    metrics.observe("http.connect_ms", -1);
    metrics.observe("http.connect_ms", Number.NaN);
    expect(metrics.snapshot().histograms).toEqual({});
  });
});

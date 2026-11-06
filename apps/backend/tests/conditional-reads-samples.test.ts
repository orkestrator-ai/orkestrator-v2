import { expect, test } from "bun:test";
import { ProgressiveReadMetrics } from "../src/core/native-agent-progressive-metrics.js";
import { collectStreamingSamples } from "../scripts/conditional-reads-samples.js";

test("excludes mixed-domain warm-up and retains all 47 three-viewer streaming reads once", () => {
  const metrics = new ProgressiveReadMetrics();
  const record = (domain: "transcript" | "state", durationMs: number) =>
    metrics.record({ domain, durationMs, cacheTier: "memory", outcome: "delta" });
  for (let viewer = 0; viewer < 3; viewer += 1) {
    record("transcript", 999);
    record("state", 999);
  }
  const collection = collectStreamingSamples(metrics);
  for (let poll = 0; poll < 47; poll += 1) {
    record("transcript", poll);
    record("state", poll);
    collection.capture();
    collection.capture(); // Other viewers can drain the same buffer without duplication.
  }
  for (const domain of ["transcript", "state"]) {
    expect(
      collection.samples.filter((sample) => sample.domain === domain).map((s) => s.durationMs),
    ).toEqual(Array.from({ length: 47 }, (_, index) => index));
  }
  expect(metrics.list()).toEqual([]);
});

test("retains streaming reads across the per-domain buffer limit", () => {
  const metrics = new ProgressiveReadMetrics();
  const collection = collectStreamingSamples(metrics);
  for (let poll = 0; poll < 600; poll += 1) {
    for (const domain of ["state", "transcript"] as const) {
      metrics.record({ domain, durationMs: poll, cacheTier: "provider", outcome: "delta" });
    }
    collection.capture();
  }
  expect(collection.samples).toHaveLength(1200);
  for (const domain of ["transcript", "state"]) {
    expect(collection.samples.filter((s) => s.domain === domain).map((s) => s.durationMs)).toEqual(
      Array.from({ length: 600 }, (_, index) => index),
    );
  }
});

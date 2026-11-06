import type {
  ProgressiveReadMetric,
  ProgressiveReadMetrics,
} from "../src/core/native-agent-progressive-metrics.js";

/** Benchmark-only collection: exclude warm-up and drain before bounded buffers roll over. */
export function collectStreamingSamples(metrics: ProgressiveReadMetrics) {
  metrics.clear();
  const samples: ProgressiveReadMetric[] = [];
  return {
    samples,
    capture() {
      samples.push(...metrics.list());
      metrics.clear();
    },
  };
}

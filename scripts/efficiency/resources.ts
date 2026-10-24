/**
 * Secondary, machine-specific resource figures for the efficiency harness:
 * heap and RSS of the harness process, and event-loop lag while a case runs.
 *
 * Like wall-clock time these are never compared by `--compare` and never
 * feed `unstableCounters`: they depend on the runtime, the garbage collector
 * and whatever else the machine is doing. They describe the harness process
 * running one function-level case, not a production backend, and a heap
 * figure is never an encoded-byte or source-byte figure (see the method notes
 * in docs/development/efficiency-harness.md). Only integers are kept.
 */

/** Default sampling interval; small enough to see a blocking call of a few ms. */
export const RESOURCE_SAMPLE_INTERVAL_MS = 5;

export interface MemorySample {
  heapUsedBytes: number;
  rssBytes: number;
}

export interface ResourceWindow {
  /** Memory when sampling started, after a forced collection where the runtime allows one. */
  start: MemorySample;
  /** Memory when sampling stopped, before any collection. */
  end: MemorySample;
  /** Memory after a forced collection at the end: what the case left reachable. */
  retained: MemorySample;
  /** Largest values seen at any sample, including start and end. */
  peak: MemorySample;
  /** How late each timer tick fired, in ms (non-negative). */
  lagMs: number[];
}

export interface ResourceSampler {
  stop(): ResourceWindow;
}

export interface CaseResources {
  /** Repetitions the figures cover. */
  repetitions: number;
  /**
   * Heap still reachable after the cold repetition, collected on both sides
   * (module caches and other state the case left behind).
   */
  coldRetainedHeapDeltaBytes: number;
  /** RSS growth across the cold repetition. */
  coldRssDeltaBytes: number;
  /**
   * Largest sampled heap across every repetition. Bun refreshes heap figures
   * only at a collection, so this is the largest post-collection heap seen
   * and undercounts short-lived peaks.
   */
  heapUsedPeakBytes: number;
  /** Largest sampled RSS across every repetition. */
  rssPeakBytes: number;
  /** Timer-tick lateness over every repetition, nearest-rank percentiles. */
  eventLoopLag: { samples: number; p50Ms: number; p99Ms: number; maxMs: number };
}

function memoryNow(): MemorySample {
  const usage = process.memoryUsage();
  return { heapUsedBytes: usage.heapUsed, rssBytes: usage.rss };
}

/** A synchronous full collection, so a start sample is not inflated by earlier garbage. */
export function collectGarbage(): void {
  (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
}

/**
 * Samples memory and timer lateness until `stop`, which also forces a
 * collection to measure what stayed reachable; call it after the timed span.
 * A setTimeout chain, not `perf_hooks.monitorEventLoopDelay`: Bun's histogram
 * does not see a blocking synchronous call, while a late timer tick does. A tick can only fire when
 * the case yields, so a case that never yields reports one long tick at the
 * end, which is exactly its blocking time.
 */
export function startResourceSampler(
  intervalMs: number = RESOURCE_SAMPLE_INTERVAL_MS,
  options: { now?: () => number; memory?: () => MemorySample; collect?: () => void } = {},
): ResourceSampler {
  const now = options.now ?? (() => performance.now());
  const memory = options.memory ?? memoryNow;
  const collect = options.collect ?? collectGarbage;
  const start = memory();
  const peak = { ...start };
  const lagMs: number[] = [];
  const observe = (sample: MemorySample) => {
    peak.heapUsedBytes = Math.max(peak.heapUsedBytes, sample.heapUsedBytes);
    peak.rssBytes = Math.max(peak.rssBytes, sample.rssBytes);
  };
  let expected = now() + intervalMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const at = now();
    lagMs.push(Math.max(0, at - expected));
    observe(memory());
    expected = at + intervalMs;
    timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // The tick that would have fired now: a case that never yielded still
      // reports the time it held the loop.
      const at = now();
      if (at > expected) lagMs.push(at - expected);
      const end = memory();
      observe(end);
      collect();
      const retained = memory();
      return { start, end, retained, peak: { ...peak }, lagMs };
    },
  };
}

function nearestRank(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index]!;
}

const roundMs = (value: number) => Math.round(value * 1000) / 1000;

/** Folds the windows of a case's repetitions (index 0 is the cold one). */
export function summarizeResources(windows: readonly ResourceWindow[]): CaseResources {
  const cold = windows[0];
  const lag = windows.flatMap((window) => window.lagMs);
  return {
    repetitions: windows.length,
    coldRetainedHeapDeltaBytes: cold ? cold.retained.heapUsedBytes - cold.start.heapUsedBytes : 0,
    coldRssDeltaBytes: cold ? cold.end.rssBytes - cold.start.rssBytes : 0,
    heapUsedPeakBytes: Math.max(0, ...windows.map((window) => window.peak.heapUsedBytes)),
    rssPeakBytes: Math.max(0, ...windows.map((window) => window.peak.rssBytes)),
    eventLoopLag: {
      samples: lag.length,
      p50Ms: roundMs(nearestRank(lag, 0.5)),
      p99Ms: roundMs(nearestRank(lag, 0.99)),
      maxMs: roundMs(Math.max(0, ...lag)),
    },
  };
}

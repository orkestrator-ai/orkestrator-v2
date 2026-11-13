/**
 * Arithmetic for `bearer-terminal-stream-live.spec.ts` (to-do 5380 (retired),
 * task 1): how many requests were open at once inside a window, and latency
 * percentiles. Timestamps only.
 */

/** A request from the moment it was sent until its connection closed (open while absent). */
export interface OpenInterval {
  at: number;
  closedAt?: number;
}

export interface OpenCount {
  /** Fewest open at any moment of the window. */
  min: number;
  /** Most open at any moment of the window. */
  max: number;
  /** Requests open at some moment of the window. */
  overlapping: number;
}

/**
 * Open requests over `[from, to]`: the count at `from`, then after every open
 * or close inside the window. A request that closes at the same instant
 * another opens is counted as replaced, not as both open.
 */
export function openAt(intervals: readonly OpenInterval[], from: number, to: number): OpenCount {
  const ends = (interval: OpenInterval) => interval.closedAt ?? Number.POSITIVE_INFINITY;
  const overlapping = intervals.filter((interval) => interval.at <= to && ends(interval) > from);
  let open = overlapping.filter((interval) => interval.at <= from).length;
  let min = open;
  let max = open;
  const events: Array<{ at: number; change: number }> = [];
  for (const interval of overlapping) {
    if (interval.at > from) events.push({ at: interval.at, change: 1 });
    if (ends(interval) <= to) events.push({ at: ends(interval), change: -1 });
  }
  // Closes before opens at the same instant.
  events.sort((a, b) => a.at - b.at || a.change - b.change);
  for (let index = 0; index < events.length; index += 1) {
    open += events[index]!.change;
    // Only the settled count after every event at one instant is a moment.
    if (events[index + 1]?.at === events[index]!.at) continue;
    min = Math.min(min, open);
    max = Math.max(max, open);
  }
  return { min, max, overlapping: overlapping.length };
}

/** Nearest-rank percentile; 0 for no values. */
export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank]!;
}

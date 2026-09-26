import {
  classifyViewSnapshotResponse,
  isUnknownViewCommandError,
} from "@orkestrator/protocol/view-sync";
import type { HydrationEntry, HydrationFetchResult } from "./bounded-hydration";

/**
 * Small bounded building blocks for {@link createBoundedHydration} and for
 * views that need the same guarantees without the whole controller.
 */

/**
 * Sorted set of revisions stored as closed intervals, with a hard bound on the
 * number of intervals. Past the bound it saturates (forgets its contents and
 * reports saturation) instead of growing, which callers treat as "a gap may
 * exist; reconcile".
 */
export class RevisionRanges {
  private ranges: Array<[number, number]> = [];
  saturated = false;

  constructor(private readonly maxRanges: number) {}

  add(revision: number): void {
    this.addRange(revision, revision);
  }

  addRange(low: number, high: number): void {
    if (this.saturated || high < low) return;
    const merged: Array<[number, number]> = [];
    let next: [number, number] = [low, high];
    let inserted = false;
    for (const range of this.ranges) {
      if (range[1] < next[0] - 1) merged.push(range);
      else if (range[0] > next[1] + 1) {
        if (!inserted) {
          merged.push(next);
          inserted = true;
        }
        merged.push(range);
      } else {
        next = [Math.min(range[0], next[0]), Math.max(range[1], next[1])];
      }
    }
    if (!inserted) merged.push(next);
    if (merged.length > this.maxRanges) {
      this.saturated = true;
      this.ranges = [];
      return;
    }
    this.ranges = merged;
  }

  /** Adds every interval of `other`; saturation propagates. */
  merge(other: RevisionRanges): void {
    if (other.saturated) {
      this.saturated = true;
      this.ranges = [];
      return;
    }
    for (const [low, high] of other.ranges) this.addRange(low, high);
  }

  /** Extends a contiguous position through every interval it now touches. */
  extend(contiguous: number): number {
    let position = contiguous;
    for (const [low, high] of this.ranges) {
      if (low > position + 1) break;
      position = Math.max(position, high);
    }
    return position;
  }

  /** Drops everything at or below `revision`. */
  prune(revision: number): void {
    this.ranges = this.ranges
      .filter(([, high]) => high > revision)
      .map(([low, high]) => [Math.max(low, revision + 1), high] as [number, number]);
  }

  hasAbove(revision: number): boolean {
    return this.ranges.some(([, high]) => high > revision);
  }

  get size(): number {
    return this.ranges.length;
  }

  clear(): void {
    this.ranges = [];
    this.saturated = false;
  }
}

/** Upper bound on nodes visited by {@link approximateJsonBytes}. */
const MAX_ESTIMATE_NODES = 10_000;

/**
 * Cheap retained-size estimate with a hard work bound. Accurate enough to
 * bound memory; never serialises the value. Returns more than `cap` as soon as
 * the estimate or the work bound is exceeded.
 */
export function approximateJsonBytes(value: unknown, cap = 256 * 1024): number {
  let total = 0;
  let visited = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    if (total > cap || visited >= MAX_ESTIMATE_NODES) return Math.max(total, cap + 1);
    const current = stack.pop();
    visited += 1;
    if (current === null || current === undefined) total += 4;
    else if (typeof current === "string") total += current.length + 2;
    else if (typeof current === "object") {
      total += 2;
      const children = Array.isArray(current)
        ? current
        : Object.entries(current as Record<string, unknown>).map(([key, item]) => {
            total += key.length + 3;
            return item;
          });
      for (const child of children) {
        if (stack.length + visited >= MAX_ESTIMATE_NODES) return Math.max(total, cap + 1);
        stack.push(child);
      }
    } else total += 8;
  }
  return total;
}

/**
 * Bounded, insertion-ordered set for notification deduplication. The oldest
 * key is evicted first; re-adding a key refreshes it.
 */
export class BoundedKeySet {
  private readonly keys = new Map<string, true>();

  constructor(private readonly maxKeys: number) {}

  /** Adds `key`; returns false when it was already present. */
  add(key: string): boolean {
    const present = this.keys.delete(key);
    this.keys.set(key, true);
    while (this.keys.size > this.maxKeys) {
      const oldest = this.keys.keys().next().value as string;
      this.keys.delete(oldest);
    }
    return !present;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  get size(): number {
    return this.keys.size;
  }
}

/**
 * Adapts a raw snapshot-command response (conditional outcome, stamped
 * snapshot, or plain legacy snapshot) into a {@link HydrationFetchResult},
 * validating the body before anything can be applied.
 */
export function toHydrationFetchResult<S, V>(
  response: unknown,
  isSnapshot: (value: unknown) => value is S,
  toEntries: (snapshot: S) => HydrationEntry<V>[],
): HydrationFetchResult<V> {
  const classified = classifyViewSnapshotResponse(response, isSnapshot);
  switch (classified.kind) {
    case "invalid":
      return { kind: "invalid" };
    case "legacy":
      return { kind: "snapshot", stamp: null, entries: toEntries(classified.snapshot) };
    case "stamped":
      return { kind: "snapshot", stamp: classified.stamp, entries: toEntries(classified.snapshot) };
    case "outcome": {
      const { outcome } = classified;
      const stamp = { generation: outcome.generation, revision: outcome.revision };
      if (outcome.status === "unchanged") return { kind: "unchanged", stamp };
      if (outcome.status === "deleted") return { kind: "deleted", stamp };
      return { kind: "snapshot", stamp, entries: toEntries(outcome.snapshot) };
    }
  }
}

/**
 * Runs a snapshot read, mapping the backend's unknown-command answer (and only
 * that answer) to the `unsupported` capability. Other failures propagate and
 * are retried with backoff by the controller.
 */
export async function readViewSnapshot<S, V>(
  command: string,
  read: () => Promise<unknown>,
  isSnapshot: (value: unknown) => value is S,
  toEntries: (snapshot: S) => HydrationEntry<V>[],
): Promise<HydrationFetchResult<V>> {
  let response: unknown;
  try {
    response = await read();
  } catch (error) {
    if (isUnknownViewCommandError(error, command)) return { kind: "unsupported" };
    throw error;
  }
  return toHydrationFetchResult(response, isSnapshot, toEntries);
}

/**
 * The persisted form of machine-load history (`machine-load.ts`), so a
 * machine's 24-hour figure survives a backend restart or update (to-do 8104).
 *
 * One small document: the bucket lists as number tuples
 * `[startMs, endMs, coveredMs, cpuWeighted, ramWeighted]`, oldest first. It is
 * numbers only, never content. Downtime is simply the absence of buckets, so
 * `coveredSeconds` stays truthful across the gap without any marker.
 *
 * Reading never trusts the document: anything malformed, too large, out of
 * order or written by a newer format is discarded whole and history starts
 * empty, which the report already reads as short coverage.
 */

export const MACHINE_LOAD_HISTORY_DOCUMENT_VERSION = 1;

/** One bucket without its key; the key is derived from `endMs` on restore. */
export interface PersistedLoadBucket {
  startMs: number;
  endMs: number;
  coveredMs: number;
  cpuWeighted: number;
  ramWeighted: number;
}

export type PersistedLoadBucketTuple = [number, number, number, number, number];

export interface MachineLoadHistoryDocument {
  version: typeof MACHINE_LOAD_HISTORY_DOCUMENT_VERSION;
  fine: PersistedLoadBucketTuple[];
  coarse: PersistedLoadBucketTuple[];
}

export interface MachineLoadHistoryParts {
  fine: PersistedLoadBucket[];
  coarse: PersistedLoadBucket[];
}

/** The shape every valid document must fit; the sampler passes its own constants. */
export interface MachineLoadHistoryLimits {
  fineBucketMs: number;
  coarseBucketMs: number;
  /** The longest interval one reading may cover. */
  maxSampleGapMs: number;
  maxFineBuckets: number;
  maxCoarseBuckets: number;
}

export type MachineLoadHistoryDiscardReason = "malformed" | "newer-version" | "too-large";

export type DecodedMachineLoadHistory =
  ({ ok: true } & MachineLoadHistoryParts) | { ok: false; reason: MachineLoadHistoryDiscardReason };

function tuple(bucket: PersistedLoadBucket): PersistedLoadBucketTuple {
  // Whole milliseconds and percent-milliseconds: far below the 0.1% the report rounds to.
  return [
    Math.round(bucket.startMs),
    Math.round(bucket.endMs),
    Math.round(bucket.coveredMs),
    Math.round(bucket.cpuWeighted),
    Math.round(bucket.ramWeighted),
  ];
}

export function encodeMachineLoadHistory(
  parts: MachineLoadHistoryParts,
): MachineLoadHistoryDocument {
  return {
    version: MACHINE_LOAD_HISTORY_DOCUMENT_VERSION,
    fine: parts.fine.map(tuple),
    coarse: parts.coarse.map(tuple),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBucket(value: unknown, maxSpanMs: number): PersistedLoadBucket | null {
  if (!Array.isArray(value) || value.length !== 5) return null;
  if (!value.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)) return null;
  const [startMs, endMs, coveredMs, cpuWeighted, ramWeighted] = value as number[];
  const spanMs = endMs! - startMs!;
  if (spanMs <= 0 || spanMs > maxSpanMs) return null;
  if (coveredMs! <= 0 || coveredMs! > spanMs) return null;
  // At most 100% of the covered time, with a millisecond of rounding.
  const ceiling = 100 * coveredMs! + 1;
  if (cpuWeighted! > ceiling || ramWeighted! > ceiling) return null;
  return {
    startMs: startMs!,
    endMs: endMs!,
    coveredMs: coveredMs!,
    cpuWeighted: cpuWeighted!,
    ramWeighted: ramWeighted!,
  };
}

function readBuckets(
  value: unknown[],
  bucketMs: number,
  maxSpanMs: number,
): PersistedLoadBucket[] | null {
  const buckets: PersistedLoadBucket[] = [];
  for (const entry of value) {
    const bucket = readBucket(entry, maxSpanMs);
    if (!bucket) return null;
    const previous = buckets.at(-1);
    // One bucket per period, in order: a duplicate key would never merge again.
    if (previous && Math.floor(previous.endMs / bucketMs) >= Math.floor(bucket.endMs / bucketMs)) {
      return null;
    }
    buckets.push(bucket);
  }
  return buckets;
}

/** Validates a stored document; nothing in a rejected one is used. */
export function decodeMachineLoadHistory(
  value: unknown,
  limits: MachineLoadHistoryLimits,
): DecodedMachineLoadHistory {
  if (!isRecord(value)) return { ok: false, reason: "malformed" };
  if (value.version !== MACHINE_LOAD_HISTORY_DOCUMENT_VERSION) {
    const newer =
      typeof value.version === "number" && value.version > MACHINE_LOAD_HISTORY_DOCUMENT_VERSION;
    return { ok: false, reason: newer ? "newer-version" : "malformed" };
  }
  if (!Array.isArray(value.fine) || !Array.isArray(value.coarse)) {
    return { ok: false, reason: "malformed" };
  }
  if (value.fine.length > limits.maxFineBuckets || value.coarse.length > limits.maxCoarseBuckets) {
    return { ok: false, reason: "too-large" };
  }
  const coarse = readBuckets(
    value.coarse,
    limits.coarseBucketMs,
    limits.coarseBucketMs + limits.maxSampleGapMs,
  );
  const fine = readBuckets(
    value.fine,
    limits.fineBucketMs,
    limits.fineBucketMs + limits.maxSampleGapMs,
  );
  if (!coarse || !fine) return { ok: false, reason: "malformed" };
  // Readings never overlap: each bucket starts where an earlier one ended or later.
  const all = [...coarse, ...fine];
  for (let index = 1; index < all.length; index += 1) {
    if (all[index]!.startMs < all[index - 1]!.endMs) return { ok: false, reason: "malformed" };
  }
  return { ok: true, fine, coarse };
}

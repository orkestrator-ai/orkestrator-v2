import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readBoundedFile,
  statFingerprint,
  syncDirectory,
  writeExclusivePrivateFile,
} from "./keyed-record-format.js";

/**
 * Small private JSON metadata files that live beside keyed records: the
 * rebuildable quota/eviction index, deletion tombstones and migration
 * progress. Each is bounded by an explicit byte cap on read, written through
 * a unique temporary file and published by rename.
 */
export const KEYED_RECORD_META_DIRECTORY = "_meta";

export type MetaJsonRead<T> =
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "ok"; value: T; fingerprint: string };

export async function readMetaJson<T>(
  filePath: string,
  maxBytes: number,
  validate: (value: unknown) => value is T,
): Promise<MetaJsonRead<T>> {
  const read = await readBoundedFile(filePath, maxBytes);
  if (read.status === "missing") return read;
  if (read.status === "corrupt") return { status: "corrupt" };
  try {
    const value: unknown = JSON.parse(read.bytes.toString("utf8"));
    return validate(value)
      ? { status: "ok", value, fingerprint: read.fingerprint }
      : { status: "corrupt" };
  } catch {
    return { status: "corrupt" };
  }
}

/**
 * Publishes one metadata file. `durable` metadata (tombstones, migration
 * completion) flushes the file and directory so a crash cannot forget a
 * deletion that a legacy import would otherwise undo; the rebuildable index
 * skips both barriers. Returns the published fingerprint for stat caching.
 */
export async function writeMetaJson(
  filePath: string,
  value: unknown,
  options: { durable: boolean; maxBytes: number },
): Promise<string | null> {
  const contents = Buffer.from(JSON.stringify(value), "utf8");
  if (contents.length > options.maxBytes) throw new Error("Keyed record metadata is too large");
  const directory = path.dirname(filePath);
  const temp = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeExclusivePrivateFile(temp, contents, options.durable);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (options.durable) await syncDirectory(directory);
  return statFingerprint(filePath);
}

const TOMBSTONE_FORMAT = "ork-keyed-record-tombstones-v1";

export interface TombstoneState {
  format: typeof TOMBSTONE_FORMAT;
  /** Record stem -> deletion time. */
  keys: Record<string, number>;
  /** `${attribute}\0${value}` -> deletion time, for owner-wide deletes. */
  owners: Record<string, number>;
  /**
   * Set once a bound forced an older tombstone out. Consumers that rely on
   * tombstones to block a legacy import must then retire that legacy source
   * instead of trusting the incomplete set.
   */
  overflowed: boolean;
}

export function emptyTombstones(): TombstoneState {
  return { format: TOMBSTONE_FORMAT, keys: {}, owners: {}, overflowed: false };
}

export function isTombstoneState(value: unknown): value is TombstoneState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const isTimes = (entry: unknown) =>
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    Object.values(entry as Record<string, unknown>).every(
      (time) => typeof time === "number" && Number.isFinite(time),
    );
  return (
    state.format === TOMBSTONE_FORMAT &&
    isTimes(state.keys) &&
    isTimes(state.owners) &&
    typeof state.overflowed === "boolean"
  );
}

export function ownerTombstoneKey(attribute: string, value: string): string {
  return `${attribute}\0${value}`;
}

/**
 * Applies the finite lifetime and count bounds. Expiry is silent (a marker
 * older than its lifetime has outlived any legacy source it protected);
 * count pressure sets `overflowed` so the protection gap is visible.
 */
export function boundTombstones(
  state: TombstoneState,
  options: { now: number; ttlMs: number; maxEntries: number },
): TombstoneState {
  const live = (entries: Record<string, number>) =>
    Object.entries(entries).filter(([, time]) => options.now - time <= options.ttlMs);
  const keys = live(state.keys).map(([id, time]) => ["k", id, time] as const);
  const owners = live(state.owners).map(([id, time]) => ["o", id, time] as const);
  const all = [...keys, ...owners].sort((left, right) => right[2] - left[2]);
  const kept = all.slice(0, options.maxEntries);
  const next = emptyTombstones();
  next.overflowed = state.overflowed || all.length > kept.length;
  for (const [kind, id, time] of kept) {
    if (kind === "k") next.keys[id] = time;
    else next.owners[id] = time;
  }
  return next;
}

const MIGRATION_FORMAT = "ork-keyed-record-migration-v1";

export interface MigrationProgress {
  format: typeof MIGRATION_FORMAT;
  id: string;
  targetSchema: string;
  sourceFingerprint: string;
  /** Source entries already processed in enumeration order. */
  processed: number;
  imported: number;
  skipped: number;
  completedAt?: number;
}

export function newMigrationProgress(
  id: string,
  targetSchema: string,
  sourceFingerprint: string,
): MigrationProgress {
  return {
    format: MIGRATION_FORMAT,
    id,
    targetSchema,
    sourceFingerprint,
    processed: 0,
    imported: 0,
    skipped: 0,
  };
}

export function isMigrationProgress(value: unknown): value is MigrationProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  return (
    progress.format === MIGRATION_FORMAT &&
    typeof progress.id === "string" &&
    typeof progress.targetSchema === "string" &&
    typeof progress.sourceFingerprint === "string" &&
    count(progress.processed) &&
    count(progress.imported) &&
    count(progress.skipped) &&
    (progress.completedAt === undefined || typeof progress.completedAt === "number")
  );
}

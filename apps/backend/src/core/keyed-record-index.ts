import { promises as fs } from "node:fs";
import path from "node:path";
import {
  KEYED_RECORD_EXTENSION,
  KEYED_RECORD_PREVIOUS_EXTENSION,
  KEYED_RECORD_TEMP_EXTENSION,
  isRecordFileStem,
  readRecordHeader,
  recordFileStem,
  statFingerprint,
  type BoundedReadLimits,
  type RecordRetentionClass,
} from "./keyed-record-format.js";
import { KEYED_RECORD_META_DIRECTORY } from "./keyed-record-meta.js";

/**
 * The small, rebuildable metadata index for one keyed-record namespace.
 *
 * It is the eviction/quota view: per record, only the key, owner attributes,
 * revision, sizes, write time and the stat fingerprint the entry was built
 * from. It never contains payload. Totals are maintained incrementally as
 * entries change so admission and eviction never re-measure every record.
 * Losing or corrupting this file is recoverable: `reconcileIndex` rebuilds it
 * from directory metadata and bounded header reads.
 */
const INDEX_FORMAT = "ork-keyed-record-index-v1";

export interface KeyedRecordIndexEntry {
  key: string;
  owner: Record<string, string>;
  revision: number;
  payloadBytes: number;
  diskBytes: number;
  /** Retained previous-generation bytes (durable only). */
  previousBytes: number;
  updatedAt: number;
  fingerprint: string;
}

export interface PersistedKeyedRecordIndex {
  format: typeof INDEX_FORMAT;
  namespace: string;
  schema: string;
  retentionClass: RecordRetentionClass;
  /** False when the last rebuild hit its scan bound; durable admission then fails closed. */
  complete: boolean;
  /** Disk bytes of files that could not be classified; reserved, never assumed zero. */
  unclassifiedBytes: number;
  entries: Record<string, KeyedRecordIndexEntry>;
}

export class KeyedRecordIndexState {
  private payloadTotal = 0;
  private previousTotal = 0;

  constructor(private readonly persisted: PersistedKeyedRecordIndex) {
    for (const entry of Object.values(persisted.entries)) {
      this.payloadTotal += entry.payloadBytes;
      this.previousTotal += entry.previousBytes;
    }
  }

  static empty(
    namespace: string,
    schema: string,
    retentionClass: RecordRetentionClass,
  ): KeyedRecordIndexState {
    return new KeyedRecordIndexState({
      format: INDEX_FORMAT,
      namespace,
      schema,
      retentionClass,
      complete: true,
      unclassifiedBytes: 0,
      entries: {},
    });
  }

  get count(): number {
    return Object.keys(this.persisted.entries).length;
  }

  get totalPayloadBytes(): number {
    return this.payloadTotal;
  }

  get totalPreviousBytes(): number {
    return this.previousTotal;
  }

  get complete(): boolean {
    return this.persisted.complete;
  }

  get unclassifiedBytes(): number {
    return this.persisted.unclassifiedBytes;
  }

  entry(stem: string): KeyedRecordIndexEntry | undefined {
    return this.persisted.entries[stem];
  }

  entries(): Array<[string, KeyedRecordIndexEntry]> {
    return Object.entries(this.persisted.entries);
  }

  set(stem: string, entry: KeyedRecordIndexEntry): void {
    this.remove(stem);
    this.persisted.entries[stem] = entry;
    this.payloadTotal += entry.payloadBytes;
    this.previousTotal += entry.previousBytes;
  }

  remove(stem: string): KeyedRecordIndexEntry | undefined {
    const existing = this.persisted.entries[stem];
    if (!existing) return undefined;
    delete this.persisted.entries[stem];
    this.payloadTotal -= existing.payloadBytes;
    this.previousTotal -= existing.previousBytes;
    return existing;
  }

  toJSON(): PersistedKeyedRecordIndex {
    return this.persisted;
  }
}

export function isPersistedKeyedRecordIndex(value: unknown): value is PersistedKeyedRecordIndex {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const index = value as Record<string, unknown>;
  if (
    index.format !== INDEX_FORMAT ||
    typeof index.namespace !== "string" ||
    typeof index.schema !== "string" ||
    (index.retentionClass !== "cache" && index.retentionClass !== "durable") ||
    typeof index.complete !== "boolean" ||
    typeof index.unclassifiedBytes !== "number" ||
    !index.entries ||
    typeof index.entries !== "object" ||
    Array.isArray(index.entries)
  ) {
    return false;
  }
  const count = (entry: unknown) =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  return Object.entries(index.entries as Record<string, unknown>).every(([stem, raw]) => {
    if (!isRecordFileStem(stem) || !raw || typeof raw !== "object") return false;
    const entry = raw as Record<string, unknown>;
    return (
      typeof entry.key === "string" &&
      !!entry.owner &&
      typeof entry.owner === "object" &&
      count(entry.revision) &&
      count(entry.payloadBytes) &&
      count(entry.diskBytes) &&
      count(entry.previousBytes) &&
      typeof entry.updatedAt === "number" &&
      typeof entry.fingerprint === "string"
    );
  });
}

export interface ReconcileReport {
  scanned: number;
  headerReads: number;
  removedTemp: number;
  removedCorrupt: number;
  removedOrphanPrevious: number;
  complete: boolean;
}

export interface ReconcileOptions {
  directory: string;
  namespace: string;
  schema: string;
  retentionClass: RecordRetentionClass;
  limits: BoundedReadLimits;
  now: number;
  tempGraceMs: number;
  maxEntries: number;
  onHeaderRead?: (key: string | undefined) => void;
}

async function lstatSize(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.lstat(filePath);
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Bounded, metadata-only reconciliation of the index with the directory.
 *
 * Entries whose stat fingerprint still matches are kept without any read.
 * Changed or unknown records cost one bounded header read, never a payload
 * read or checksum. Temporary files older than the grace window are removed
 * (younger ones may belong to an active writer and are reserved instead).
 * Once the scan bound is hit the result is marked incomplete and previously
 * known entries are carried over, so the store never assumes zero bytes.
 */
export async function reconcileIndex(
  previous: KeyedRecordIndexState | null,
  options: ReconcileOptions,
): Promise<{ state: KeyedRecordIndexState; report: ReconcileReport }> {
  const report: ReconcileReport = {
    scanned: 0,
    headerReads: 0,
    removedTemp: 0,
    removedCorrupt: 0,
    removedOrphanPrevious: 0,
    complete: true,
  };
  const next = KeyedRecordIndexState.empty(
    options.namespace,
    options.schema,
    options.retentionClass,
  );
  const previousSizes = new Map<string, number>();
  let unclassifiedBytes = 0;
  const directory = await fs.opendir(options.directory, { bufferSize: 64 });
  try {
    for await (const dirent of directory) {
      if (report.scanned >= options.maxEntries) {
        report.complete = false;
        break;
      }
      report.scanned += 1;
      const name = dirent.name;
      if (name === KEYED_RECORD_META_DIRECTORY) continue;
      // Cross-process lock files belong to the lock protocol, which reclaims
      // stale ones itself.
      if (name.endsWith(".lock") || name.endsWith(".reclaim")) continue;
      const fullPath = path.join(options.directory, name);
      if (name.startsWith(".") && name.endsWith(KEYED_RECORD_TEMP_EXTENSION)) {
        const stat = await lstatSize(fullPath);
        if (!stat) continue;
        if (options.now - stat.mtimeMs > options.tempGraceMs) {
          await fs.rm(fullPath, { force: true });
          report.removedTemp += 1;
        } else {
          unclassifiedBytes += stat.size;
        }
        continue;
      }
      const extension = name.endsWith(KEYED_RECORD_EXTENSION)
        ? KEYED_RECORD_EXTENSION
        : name.endsWith(KEYED_RECORD_PREVIOUS_EXTENSION)
          ? KEYED_RECORD_PREVIOUS_EXTENSION
          : null;
      const stem = extension ? name.slice(0, -extension.length) : "";
      if (!extension || !isRecordFileStem(stem)) {
        // Not ours to delete; conservatively reserve its bytes.
        unclassifiedBytes += (await lstatSize(fullPath))?.size ?? 0;
        continue;
      }
      if (extension === KEYED_RECORD_PREVIOUS_EXTENSION) {
        const stat = await lstatSize(fullPath);
        if (stat) previousSizes.set(stem, stat.size);
        continue;
      }
      const fingerprint = await statFingerprint(fullPath);
      const known = previous?.entry(stem);
      if (known && fingerprint && known.fingerprint === fingerprint) {
        next.set(stem, { ...known, previousBytes: 0 });
        continue;
      }
      report.headerReads += 1;
      const header = await readRecordHeader(
        fullPath,
        { schema: options.schema, retentionClass: options.retentionClass },
        options.limits,
      );
      options.onHeaderRead?.(header.status === "ok" ? header.header.key : undefined);
      if (header.status === "ok" && recordFileStem(options.namespace, header.header.key) === stem) {
        next.set(stem, {
          key: header.header.key,
          owner: header.header.owner,
          revision: header.header.revision,
          payloadBytes: header.header.accountedBytes ?? header.header.byteLength,
          diskBytes: header.bytes,
          previousBytes: 0,
          updatedAt: header.header.updatedAt,
          fingerprint: header.fingerprint,
        });
        continue;
      }
      if (header.status === "missing") continue;
      if (options.retentionClass === "cache") {
        // A corrupt cache record is only ever a miss; drop it.
        await fs.rm(fullPath, { force: true });
        report.removedCorrupt += 1;
      } else {
        // A corrupt durable current may still have a valid previous
        // generation; keep both and reserve the bytes.
        unclassifiedBytes += header.status === "corrupt" ? header.bytes : 0;
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  for (const [stem, size] of previousSizes) {
    const current = next.entry(stem);
    if (current) {
      next.set(stem, { ...current, previousBytes: size });
      continue;
    }
    if (!report.complete) {
      unclassifiedBytes += size;
      continue;
    }
    // A previous generation with no current file is the remnant of an
    // interrupted delete: deletion wins, so it must not be recoverable.
    const currentPath = path.join(options.directory, `${stem}${KEYED_RECORD_EXTENSION}`);
    if (options.retentionClass === "durable" && (await lstatSize(currentPath))) {
      unclassifiedBytes += size;
      continue;
    }
    await fs.rm(path.join(options.directory, `${stem}${KEYED_RECORD_PREVIOUS_EXTENSION}`), {
      force: true,
    });
    report.removedOrphanPrevious += 1;
  }
  if (!report.complete && previous) {
    for (const [stem, entry] of previous.entries()) {
      if (!next.entry(stem)) next.set(stem, entry);
    }
  }
  const persisted = next.toJSON();
  persisted.complete = report.complete;
  persisted.unclassifiedBytes = unclassifiedBytes;
  return { state: new KeyedRecordIndexState(persisted), report };
}

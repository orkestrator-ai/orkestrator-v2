import {
  STORAGE_TIMING_BUCKETS_MS,
  type StorageActivitySnapshot,
  type StorageFileActivity,
  type StorageTimingSeries,
} from "@orkestrator/protocol/backend-diagnostics";
import { leaseFamily } from "./storage-lease-metrics.js";
import type { StorageDatabaseName } from "./storage-slow-operations.js";

/**
 * Bounded, content-free counts of the commits and reads every connection in
 * this process made, per database file. They are what a busy session is
 * measured with before SQLite's durability or cache settings change
 * (to-dos 5180 and 5181): how many commits sync the WAL each minute, and how
 * long the reads take.
 *
 * `instrumentSqliteConnection` (`storage-slow-operations.ts`) classifies and
 * times each call; this only adds the result to fixed-size histograms. A read
 * series is named by a store family or a table, never by an id, a key or a
 * value, and each file holds at most {@link MAX_STORAGE_READ_SERIES}.
 */
export const MAX_STORAGE_READ_SERIES = 64;
const OTHER_SERIES = "other";

interface MutableSeries {
  count: number;
  totalMs: number;
  maxMs: number;
  buckets: number[];
}

interface FileActivity {
  connections: number;
  commits: MutableSeries;
  checkpoints: MutableSeries;
  reads: Map<string, MutableSeries>;
}

function emptySeries(): MutableSeries {
  return {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    buckets: Array.from({ length: STORAGE_TIMING_BUCKETS_MS.length + 1 }, () => 0),
  };
}

function bucketOf(ms: number): number {
  for (let index = 0; index < STORAGE_TIMING_BUCKETS_MS.length; index += 1) {
    if (ms <= STORAGE_TIMING_BUCKETS_MS[index]!) return index;
  }
  return STORAGE_TIMING_BUCKETS_MS.length;
}

function observe(series: MutableSeries, ms: number): void {
  const time = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  series.count += 1;
  series.totalMs += time;
  if (time > series.maxMs) series.maxMs = time;
  series.buckets[bucketOf(time)]! += 1;
}

/** Microsecond precision is plenty, and keeps the snapshot short. */
const rounded = (ms: number) => Math.round(ms * 1_000) / 1_000;

function snapshotSeries(series: MutableSeries): StorageTimingSeries {
  return {
    count: series.count,
    totalMs: rounded(series.totalMs),
    maxMs: rounded(series.maxMs),
    buckets: [...series.buckets],
  };
}

/** The read series a store name counts in: its family, as lease waits use. */
export function readSeriesForStore(store: string): string {
  return leaseFamily(store);
}

/** The read series of a statement that named no store. */
export function readSeriesForTable(table: string | null): string {
  return table ? `table:${table}` : OTHER_SERIES;
}

export class StorageActivityMetrics {
  private readonly files = new Map<StorageDatabaseName, FileActivity>();
  private since: string | null = null;
  private overflowed = 0;

  constructor(private readonly wallClock: () => number = Date.now) {}

  private file(database: StorageDatabaseName): FileActivity {
    let file = this.files.get(database);
    if (!file) {
      this.since ??= new Date(this.wallClock()).toISOString();
      file = {
        connections: 0,
        commits: emptySeries(),
        checkpoints: emptySeries(),
        reads: new Map(),
      };
      this.files.set(database, file);
    }
    return file;
  }

  connectionOpened(database: StorageDatabaseName): void {
    this.file(database).connections += 1;
  }

  commit(database: StorageDatabaseName, ms: number): void {
    observe(this.file(database).commits, ms);
  }

  checkpoint(database: StorageDatabaseName, ms: number): void {
    observe(this.file(database).checkpoints, ms);
  }

  read(database: StorageDatabaseName, series: string, ms: number): void {
    const reads = this.file(database).reads;
    let target = reads.get(series);
    if (!target) {
      let name = series;
      if (reads.size >= MAX_STORAGE_READ_SERIES) {
        this.overflowed += 1;
        name = OTHER_SERIES;
      }
      target = reads.get(name);
      if (!target) {
        target = emptySeries();
        reads.set(name, target);
      }
    }
    observe(target, ms);
  }

  snapshot(): StorageActivitySnapshot {
    const files: Record<string, StorageFileActivity> = {};
    for (const [database, file] of this.files) {
      const reads: Record<string, StorageTimingSeries> = {};
      for (const [name, series] of file.reads) reads[name] = snapshotSeries(series);
      files[database] = {
        connections: file.connections,
        commits: snapshotSeries(file.commits),
        checkpoints: snapshotSeries(file.checkpoints),
        reads,
      };
    }
    return {
      since: this.since ?? new Date(this.wallClock()).toISOString(),
      bucketsMs: STORAGE_TIMING_BUCKETS_MS,
      files,
      readsOverflowed: this.overflowed,
    };
  }
}

/** The process-wide counts every {@link StorageDatabase} connection reports into. */
export const storageActivityMetrics = new StorageActivityMetrics();

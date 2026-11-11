/**
 * The database figures `/__orkestrator/metrics`, `get_database_stats` and the
 * diagnostics bundle share, and the bundle's plan and manifest. Numbers, fixed
 * labels and table names only: never a key, a path or a row's value.
 */

/** One SQLite file. The page figures are `null` when no connection could read them. */
export interface DatabaseFileSummary {
  fileBytes: number;
  walBytes: number;
  pageBytes: number | null;
  pageCount: number | null;
  freelistPages: number | null;
  /** Space inside the file that holds nothing and is reused or released later. */
  freelistBytes: number | null;
}

export interface DatabaseBackupKindSummary {
  count: number;
  bytes: number;
}

export interface DatabaseBackupSummary {
  count: number;
  bytes: number;
  newestAt: string | null;
  kinds: Record<
    "hourly" | "pre-migration" | "ledger" | "ledger-pre-migration",
    DatabaseBackupKindSummary
  >;
}

/** The last change-tracking retention pass this process ran. */
export interface DatabaseRetentionSummary {
  at: string;
  outcome: "completed" | "failed";
  /** Passes that failed since this process started. */
  failedPasses: number;
  report: {
    prunedMeasurements: number;
    prunedMeasurementFiles: number;
    expiredReferences: number;
    releasedForQuota: number;
    deletedSnapshots: number;
    removedObjects: number;
    removedBytes: number;
    storedBytes: number;
    hardLimited: boolean;
  } | null;
}

export interface DatabaseTopTable {
  /** A table or index name from the schema. */
  name: string;
  bytes: number;
}

/**
 * Bytes of stored values per store family in `store_rows`, the one table nearly
 * every store shares. A family drops the ids a store name can hold
 * (`web-annotations/<environmentId>` is `web-annotations`), so it is
 * content-free.
 */
export interface DatabaseStoreFamily {
  family: string;
  /** UTF-8 bytes of the family's row values; keys and index pages are not counted. */
  bytes: number;
  rows: number;
}

/** Sampled in the backup child from a finished copy, so as old as that copy. */
export interface DatabaseTopTables {
  takenAt: string;
  tables: DatabaseTopTable[];
  /**
   * The largest store families inside `store_rows`, largest first. Absent for a
   * database without that table (the ledger), and from an older backend.
   */
  stores?: DatabaseStoreFamily[];
}

export interface DatabaseSummary {
  generatedAt: string;
  main: DatabaseFileSummary | null;
  /** The change-tracking ledger's own file; `null` until it exists. */
  ledger: DatabaseFileSummary | null;
  backups: DatabaseBackupSummary;
  retention: DatabaseRetentionSummary | null;
  /** `null` until a copy has run, or where SQLite has no `dbstat`. */
  topTables: { main: DatabaseTopTables | null; ledger: DatabaseTopTables | null };
}

/** Upper bounds in milliseconds; a wait past the last counts in the final bucket. */
export const LEASE_WAIT_BUCKETS_MS = [1, 5, 25, 100, 500, 2_000, 10_000, 30_000] as const;

export interface LeaseWaitFamilySnapshot {
  acquired: number;
  timedOut: number;
  totalWaitMs: number;
  maxWaitMs: number;
  /** Per-bucket counts, one for each of {@link LEASE_WAIT_BUCKETS_MS} plus the overflow. */
  buckets: number[];
}

export interface LeaseWaitSnapshot {
  bucketsMs: readonly number[];
  families: Record<string, LeaseWaitFamilySnapshot>;
  /** Waits folded into `other` because the family table was full. */
  overflowed: number;
  /** Transactions that gave up with `SQLITE_BUSY` once `busy_timeout` ran out. */
  transactionsBusy: number;
}

/**
 * One synchronous SQLite call or transaction that held the event loop for at
 * least the slow-operation threshold. Content-free: names, kinds and times
 * only, never SQL text, parameters or rows.
 */
export interface SlowStorageOperation {
  /** Wall-clock end of the operation, as an ISO string. */
  at: string;
  /** `main` (`orkestrator.sqlite`), `ledger` (`change-tracking.sqlite`) or `other`. */
  database: string;
  /** `transaction`, or the statement's kind (`select`, `insert`, `pragma`, …). */
  op: string;
  /** The statement's table (or pragma); for a transaction, its slowest statement's. */
  table: string | null;
  /** The store family a transaction worked on, when the caller named one. */
  store: string | null;
  /** A transaction's mode: `deferred`, `immediate` or `exclusive`. */
  mode: string | null;
  durationMs: number;
  /** A transaction's wait to begin: the write lock, for an immediate one. */
  beginMs: number | null;
  /** A transaction's time in its own statements, summed. */
  sqlMs: number | null;
  /** A transaction's commit, which syncs the WAL. */
  commitMs: number | null;
  /** The call failed with `SQLITE_BUSY`: the busy timeout ran out. */
  busy: boolean;
}

export interface SlowStorageOperationSeries {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface SlowStorageOperationsSnapshot {
  thresholdMs: number;
  /** By `database:op:table`, capped; the rest is counted in `overflowed`. */
  series: Record<string, SlowStorageOperationSeries>;
  overflowed: number;
  /** The most recent, oldest first. */
  recent: SlowStorageOperation[];
}

/**
 * Upper bounds in milliseconds of the commit and read histograms; a time past
 * the last counts in the final bucket.
 */
export const STORAGE_TIMING_BUCKETS_MS = [0.1, 0.25, 1, 4, 16, 64, 250, 1_000] as const;

/** A count of timed SQLite calls, with their total, maximum and histogram. */
export interface StorageTimingSeries {
  count: number;
  totalMs: number;
  maxMs: number;
  /** Per-bucket counts, one for each of {@link STORAGE_TIMING_BUCKETS_MS} plus the overflow. */
  buckets: number[];
}

/** What one SQLite file's connections in this process did since {@link StorageActivitySnapshot.since}. */
export interface StorageFileActivity {
  /** Connections to the file this process opened. */
  connections: number;
  /**
   * Write commits: transactions that ran a statement which changed something,
   * and changing statements outside a transaction. With WAL each one appends
   * to the WAL and, under `synchronous = FULL`, syncs it. Timed from the end of
   * the transaction's body to its return (the COMMIT and its sync), or the
   * whole statement outside a transaction.
   */
  commits: StorageTimingSeries;
  /** Explicit `wal_checkpoint` calls, which sync the database file. */
  checkpoints: StorageTimingSeries;
  /**
   * Read-only transactions and reads outside a transaction, timed by the
   * time spent in SQLite statements, by store family (`web-annotations/<id>`
   * counts as `web-annotations`), or `table:<name>` when no store was named.
   */
  reads: Record<string, StorageTimingSeries>;
}

/**
 * Content-free counts of the commits and reads this process made, per
 * database file (`main`, `ledger`, `other`). Counts only grow: a rate is the
 * difference of two snapshots over the time between them.
 */
export interface StorageActivitySnapshot {
  /** When counting began: this process's first connection. */
  since: string;
  bucketsMs: readonly number[];
  files: Record<string, StorageFileActivity>;
  /** Reads folded into `other` because a file's read table was full. */
  readsOverflowed: number;
}

/** `get_database_stats`: the cached summary plus the live lease counters. */
export interface DatabaseStats extends DatabaseSummary {
  leaseWaits: LeaseWaitSnapshot;
  /** Absent from a backend older than the slow-operation record. */
  slowOperations?: SlowStorageOperationsSnapshot;
  /** Absent from a backend older than the commit and read counters. */
  activity?: StorageActivitySnapshot;
}

export const DIAGNOSTICS_MANIFEST_SCHEMA_VERSION = 1;

/** Says plainly what the pass does and does not establish. Shown wherever the manifest is. */
export const DIAGNOSTICS_REDACTION_NOTICE =
  "Redaction is a best-effort pass by pattern, not a proof: a credential or private text with no recognisable shape can survive it. Read the files before sharing this bundle. Nothing is uploaded; the bundle goes only where you save it.";

/** The largest piece of a bundle one read returns; a plan is read piece by piece. */
export const DIAGNOSTICS_CHUNK_BYTES = 256 * 1024;

export interface DiagnosticsManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
  description: string;
  /** Pieces of text the redaction pass replaced in this file. */
  redactions: number;
}

export interface DiagnosticsManifestAbsent {
  name: string;
  reason: string;
}

/** `manifest.json` in the archive, byte for byte what a plan reports. */
export interface DiagnosticsManifest {
  schemaVersion: typeof DIAGNOSTICS_MANIFEST_SCHEMA_VERSION;
  createdAt: string;
  appVersion: string;
  platform: string;
  arch: string;
  bunVersion: string | null;
  notice: string;
  entries: DiagnosticsManifestEntry[];
  absent: DiagnosticsManifestAbsent[];
}

/** Environments a plan may read container server logs from, chosen per plan. */
export const DIAGNOSTICS_MAX_CONTAINER_LOG_ENVIRONMENTS = 8;

/**
 * A container environment whose server logs the user may add to a bundle. Not
 * part of the archive: it only tells the Export dialog what it can offer.
 */
export interface DiagnosticsContainerLogOption {
  environmentId: string;
  /** The environment's name, for the dialog. */
  name: string;
  /** Its stored status (`running`, `stopped`, …); a container that is not running answers nothing. */
  status: string;
  /** Whether this plan holds its logs. */
  included: boolean;
}

/** One planned bundle: already built and held until it is read or expires. */
export interface DiagnosticsBundlePlan {
  planId: string;
  fileName: string;
  expiresAt: string;
  archive: { bytes: number; sha256: string };
  manifest: DiagnosticsManifest;
  /**
   * Container environments whose server logs can be added, opt-in, by planning
   * again with their ids. Absent from a backend older than the option.
   */
  containerLogs?: DiagnosticsContainerLogOption[];
}

/** One piece of a planned bundle, in order. Says what the whole must add up to. */
export interface DiagnosticsBundleChunk {
  planId: string;
  fileName: string;
  archive: { bytes: number; sha256: string };
  offset: number;
  /** Base64. */
  data: string;
  nextOffset: number | null;
}

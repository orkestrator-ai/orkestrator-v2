import { Database } from "bun:sqlite";
import {
  STORAGE_COLLECTION_MARKER,
  STORAGE_DATABASE_FILE,
  assembleStoredValue,
  type StoredLayoutKind,
  type StoredRow,
} from "@orkestrator/protocol/node/storage-database";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { leaseFamily, leaseLogName, leaseWaitMetrics } from "./storage-lease-metrics.js";
import {
  applyArrayRowUpdate,
  assertArrayRowKey,
  compareRowEntries,
  decompose,
  isUnchanged,
  rowId,
  stabilizePositions,
  type StoreRow,
} from "./storage-database-rows.js";
import {
  instrumentSqliteConnection,
  storageDatabaseName,
  type SlowStorageOperations,
  type SqliteConnectionTiming,
} from "./storage-slow-operations.js";
import type { StorageActivityMetrics } from "./storage-activity-metrics.js";
import type { CacheGaugeName, CacheGaugeSource } from "./recurring-diagnostics.js";

const log = createLogger("storage");

/**
 * The backend's single SQLite database.
 *
 * Every authoritative store that used to be a JSON file lives here. SQLite owns
 * atomicity (one transaction can span several stores), crash safety (WAL with
 * full sync replaces temp-file renames and the five-file backup ladder) and
 * cross-process exclusion for short critical sections. Long critical sections
 * that span provider or Git I/O use {@link StorageDatabase.acquireLease}, which
 * replaces the old `.lock` files.
 *
 * `bun:sqlite` is synchronous and its busy handler blocks the event loop, so a
 * transaction must never be held across an `await`. Every method here runs to
 * completion synchronously; async callers serialize their read-modify-write
 * with a lease and commit each write as its own short transaction (or batch
 * them with {@link StorageDatabase.transaction}).
 */

export { STORAGE_DATABASE_FILE };
export { applyArrayRowUpdate };

/**
 * The change-tracking ledger's own database file, beside
 * {@link STORAGE_DATABASE_FILE} (`change-tracking/ledger-schema.ts`).
 */
export const CHANGE_LEDGER_DATABASE_FILE = "change-tracking.sqlite";

/** Free pages {@link StorageDatabase.releaseFreePages} returns by default (4 KiB pages: 16 MiB). */
const INCREMENTAL_VACUUM_PAGES = 4096;

/**
 * First wait before a deferred scrub tries again ({@link StorageDatabase.scrubDeletedContent}).
 * It doubles per busy attempt up to {@link SCRUB_RETRY_MAX_MS}.
 */
export const SCRUB_RETRY_FIRST_MS = 5_000;
/** The longest wait between attempts of a deferred scrub. */
export const SCRUB_RETRY_MAX_MS = 60_000;

/**
 * Rows `PRAGMA optimize` samples per index (`analysis_limit`), which bounds its
 * cost on a large table. SQLite recommends a few hundred.
 */
const OPTIMIZE_ANALYSIS_LIMIT = 400;

/** How a store's JSON value maps onto rows. Fixed per store name. */
export type StoreLayout =
  /** One opaque value. Small configuration-like stores. */
  | { kind: "document" }
  /** `Record<string, T>`: one row per key. */
  | { kind: "record"; owner?: (value: unknown) => string | undefined }
  /**
   * `T[]` whose items carry a unique string key field (`id` unless `key`
   * names another): one row per item, order kept.
   */
  | { kind: "array"; key?: string; owner?: (value: unknown) => string | undefined }
  /**
   * An object whose named fields are each `Record<string, T>` collections
   * (one row per entry); every other field is kept in the envelope document.
   */
  | { kind: "envelope"; collections: readonly string[] };

export interface StorageMigrationContext {
  dataDir: string;
  db: Database;
  /** The database being opened; its store methods work inside `up`. */
  database: StorageDatabase;
}

export interface StorageMigration {
  version: number;
  name: string;
  /** Runs inside the migration's IMMEDIATE transaction. Must be synchronous. */
  up(context: StorageMigrationContext): void;
}

type CachedStore = {
  revision: number;
  layout: StoredLayoutKind;
  /** Serialized document part (whole value, envelope remainder, or null). */
  document: string | null;
  rows: Map<string, StoreRow>;
  /** "rows" for a row layout; "document" when the value had to be stored whole. */
  mode: "rows" | "document";
};

/** One row as {@link StorageDatabase.rows} lists it; `value` is null with `values: false`. */
export interface StoreRowEntry {
  collection: string;
  key: string;
  position: number;
  owner: string | null;
  value: string | null;
  /** UTF-8 byte length of the serialized value. */
  bytes: number;
}

/** Uncached row access returned by {@link StorageDatabase.rows}. */
export interface StoreRows {
  get(key: string, collection?: string): string | undefined;
  /** The whole row (owner, position, size, value) for one key. */
  entry(key: string, collection?: string): StoreRowEntry | undefined;
  has(key: string, collection?: string): boolean;
  list(options?: { collection?: string; owner?: string; values?: boolean }): StoreRowEntry[];
  owners(): string[];
  /** Inside a transaction. `owner` overrides the layout's owner extractor. */
  put(
    key: string,
    value: string,
    options?: { collection?: string; owner?: string | null; position?: number },
  ): void;
  /** Inside a transaction (checked before anything is deleted). */
  delete(key: string, collection?: string): boolean;
  /** Inside a transaction. Returns the number of rows removed. */
  deleteWhere(options: { collection?: string; owner?: string }): number;
}

/** What {@link StorageDatabase.updateStoreRow} does with the row. */
export type RowUpdate<T> =
  | { result: T; value?: undefined; delete?: undefined }
  | { result: T; value: unknown; delete?: undefined }
  | { result: T; delete: true };

/** Options of {@link StorageDatabase.writeStore}. */
export interface StoreWriteOptions {
  expectedRevision?: number | null;
  /** Refuse the write when the serialized value exceeds this many UTF-8 bytes. */
  maxBytes?: number;
}

/** What {@link StorageDatabase.readStoreSerialized} returns. */
export interface SerializedStore {
  revision: number;
  layout: StoredLayoutKind;
  mode: "rows" | "document";
  /** Serialized document part (whole value, envelope remainder, or null). */
  document: string | null;
  rows: Iterable<Readonly<StoredRow>>;
}

export interface StoreSnapshot {
  value: unknown;
  revision: number;
}

export class StorageDatabaseVersionError extends Error {
  constructor(found: number, supported: number) {
    super(
      `Storage database schema version ${found} is newer than this build supports (${supported}). Update Orkestrator to open it.`,
    );
    this.name = "StorageDatabaseVersionError";
  }
}

/** A stored value that is not valid JSON (imported from a corrupt legacy file). */
export class StoreCorruptError extends Error {
  constructor(store: string) {
    super(`Storage ${store} is unreadable`);
    this.name = "StoreCorruptError";
  }
}

/** A write refused by its `maxBytes` bound; nothing was written. */
export class StoreTooLargeError extends Error {
  constructor(
    store: string,
    readonly bytes: number,
  ) {
    super(`Storage ${store} would exceed its size limit`);
    this.name = "StoreTooLargeError";
  }
}

export class StoreConflictError extends Error {
  constructor(store: string) {
    super(`Storage ${store} changed concurrently`);
    this.name = "StoreConflictError";
  }
}

const SCHEMA: StorageMigration = {
  version: 1,
  name: "schema",
  up({ db }) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stores (
        name TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        layout TEXT NOT NULL CHECK (layout IN ('document', 'array', 'record', 'envelope')),
        mode TEXT NOT NULL CHECK (mode IN ('rows', 'document')),
        document TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS store_rows (
        store TEXT NOT NULL,
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        position INTEGER NOT NULL,
        owner TEXT,
        value TEXT NOT NULL,
        PRIMARY KEY (store, collection, key)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS store_rows_owner ON store_rows (store, owner) WHERE owner IS NOT NULL;
      CREATE TABLE IF NOT EXISTS leases (
        name TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        heartbeat_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS storage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
    `);
    db.query("INSERT OR IGNORE INTO storage_meta (key, value) VALUES ('instance', ?)").run(
      randomUUID(),
    );
  },
};

/** How {@link StorageDatabaseOptions.observe} classifies a read. */
export type StorageReadEvent = "read" | "stat";

export interface StorageDatabaseOptions {
  /** Ordered migrations after the base schema (version 1). */
  migrations?: readonly StorageMigration[];
  /** Resolves a store's layout; unknown stores are documents. */
  layoutFor?: (store: string) => StoreLayout;
  /**
   * The database file in `dataDir`, {@link STORAGE_DATABASE_FILE} by default.
   * The change-tracking ledger has its own file (`change-tracking/ledger-schema.ts`).
   */
  file?: string;
  /** WAL commit durability; defaults to full. Only the change ledger opts into normal. */
  synchronous?: "normal" | "full";
  busyTimeoutMs?: number;
  /**
   * Called before migrating a database that already has data (outside any
   * transaction), so a snapshot can be taken first. Throwing aborts the open.
   */
  beforeMigrate?: (database: StorageDatabase, from: number, to: number) => void;
  /**
   * Observes reads, never content. `read`: stored content was decoded for a
   * caller (a whole store, one owner's rows or one row), whether its rows came
   * from the database or from this connection's revision-validated cache, or
   * a store's rows were fetched from the database for an internal lookup.
   * `stat`: an internal lookup (a write's previous rows, row sizes) reused the
   * cached rows after checking the committed revision. Every query through
   * {@link StorageDatabase.rows} that returns rows or keys is a `read`.
   */
  observe?: (event: StorageReadEvent) => void;
  /**
   * Observes how much stored content an access fetched from the database, as
   * the serialized length (UTF-16 code units) of the rows or document it
   * selected. A read served by the revision-validated cache fetches nothing
   * and reports nothing, so a cache miss (a whole-store fetch) shows as bytes
   * beside its `read` while a cache-served read shows as a `read` alone.
   */
  observeFetch?: (length: number) => void;
  /**
   * Where this connection reports its row-cache gauges
   * ({@link StorageDatabase.cacheGauges}) while open; usually
   * `recurringDiagnosticsRegistry`. Unregistered on close.
   */
  cacheGaugeRegistry?: {
    addCacheSource(name: CacheGaugeName, source: CacheGaugeSource): () => void;
  };
  /**
   * Record stores whose rows without an owner get a partial index of their
   * own, so {@link StorageDatabase.listUnownedRows} costs those rows rather
   * than a walk of the store. For a store whose rows normally all have one.
   */
  unownedRowIndexes?: readonly string[];
  /**
   * Where this connection reports its slow SQLite calls; the process-wide
   * `slowStorageOperations` by default. Tests pass their own.
   */
  slowOperations?: SlowStorageOperations;
  /**
   * Where this connection counts its commits and reads; the process-wide
   * `storageActivityMetrics` by default. Tests pass their own.
   */
  activity?: StorageActivityMetrics;
}

/** Content-free size of one connection's row cache. */
export type StorageRowCacheGauges = {
  /** Open connections reporting (1 per instance; summed in diagnostics). */
  connections: number;
  /** Stores held in the cache. */
  stores: number;
  /** Rows held across them. */
  rows: number;
  /**
   * Serialized length of the cached rows and documents, in UTF-16 code units
   * like `observeFetch`: a proxy for retained bytes, not a heap measurement.
   */
  bytes: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restrictCompanionFiles(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const companion = `${databasePath}${suffix}`;
    try {
      if (fs.lstatSync(companion).isFile()) fs.chmodSync(companion, 0o600);
    } catch (error) {
      // Another backend closing the database removes its WAL and SHM.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export class StorageDatabase {
  readonly path: string;
  readonly db: Database;
  /** Random per-database identity; part of every snapshot revision. */
  readonly instanceId: string;
  private readonly cache = new Map<string, CachedStore>();
  /** Serialized length per cached store. A cached store is never mutated, only replaced. */
  private readonly cachedLengths = new WeakMap<CachedStore, number>();
  private unregisterCacheGauges: () => void = () => undefined;
  /**
   * Cache entries written by the open transaction. Applied only after the
   * outermost commit: a rolled-back revision must never be cached, or a later
   * foreign commit reusing that revision number would be shadowed by it.
   */
  private pendingCache: Map<string, CachedStore | null> | null = null;
  /** {@link rowBytesExpression} for this connection's SQLite library. */
  private rowBytesSql: string | null = null;
  /** Revision each store was bumped to by row writes in the open transaction. */
  private readonly touchedRevisions = new Map<string, number>();
  private readonly layoutFor: (store: string) => StoreLayout;
  /** Each `unownedRowIndexes` store's partial index: its name and its WHERE clause. */
  private readonly unownedRowIndexes = new Map<string, { name: string; where: string }>();
  private readonly observe: ((event: StorageReadEvent) => void) | undefined;
  private readonly observeFetch: ((length: number) => void) | undefined;
  private readonly busyTimeoutMs: number;
  /** Times this connection's calls (`storage-slow-operations.ts`). */
  private readonly timing: SqliteConnectionTiming;
  /** The timer of a deferred scrub, while one is pending. */
  private scrubRetry: ReturnType<typeof setTimeout> | null = null;
  private scrubRetryDelayMs = SCRUB_RETRY_FIRST_MS;
  private closed = false;

  constructor(dataDir: string, options: StorageDatabaseOptions = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.path = path.join(dataDir, options.file ?? STORAGE_DATABASE_FILE);
    if (fs.existsSync(this.path) && fs.lstatSync(this.path).isSymbolicLink()) {
      throw new Error("Storage database must not be a symbolic link");
    }
    this.layoutFor = options.layoutFor ?? (() => ({ kind: "document" }));
    for (const store of options.unownedRowIndexes ?? []) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(store) || this.layoutFor(store).kind !== "record") {
        throw new Error(`An unowned-row index needs a record store with a plain name: ${store}`);
      }
      this.unownedRowIndexes.set(store, {
        name: `store_rows_unowned_${store.replaceAll("-", "_")}`,
        where: `store = '${store}' AND collection = '' AND owner IS NULL`,
      });
    }
    this.observe = options.observe;
    this.observeFetch = options.observeFetch;
    this.db = new Database(this.path, { create: true, strict: true });
    // Before the first statement, so a slow migration is recorded too.
    this.timing = instrumentSqliteConnection(
      this.db,
      storageDatabaseName(options.file ?? STORAGE_DATABASE_FILE),
      { recorder: options.slowOperations, activity: options.activity },
    );
    try {
      // Sensitive stores (agent mail, prompt queues, credentials) share this
      // file. SQLite creates -wal/-shm with the database file's mode, but keeps
      // the mode of ones already there.
      fs.chmodSync(this.path, 0o600);
      restrictCompanionFiles(this.path);
      this.busyTimeoutMs = Math.max(0, options.busyTimeoutMs ?? 10_000);
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      // Only takes effect before the first table exists (a new database);
      // switching later needs a full VACUUM. Lets deletes give space back.
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      this.db.exec("PRAGMA journal_mode = WAL");
      // Preserve full durability unless this database explicitly opts into NORMAL.
      this.db.exec(
        options.synchronous === "normal"
          ? "PRAGMA synchronous = NORMAL"
          : "PRAGMA synchronous = FULL",
      );
      // A checkpoint copies WAL frames into the database file and then resets
      // the WAL, so it must sync in order. On macOS Bun links the system
      // SQLite, which syncs a checkpoint with F_BARRIERFSYNC only because
      // Apple builds it with DEFAULT_CKPTFULLFSYNC; plain fsync there neither
      // flushes the drive cache nor orders writes. Set it rather than inherit
      // the build default. A no-op on Linux. `fullfsync` (each commit) stays
      // off: storage.md, "Durability and deletion".
      this.db.exec("PRAGMA checkpoint_fullfsync = ON");
      // Deleting user content must not leave it readable in free pages.
      this.db.exec("PRAGMA secure_delete = ON");
      // No table declares a foreign key, so `foreign_keys` is left off: setting
      // it would promise referential checks that nothing enforces. A migration
      // that declares keys must turn it on here.
      this.db.exec("PRAGMA journal_size_limit = 8388608");
      const migrations = [SCHEMA, ...(options.migrations ?? [])];
      const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
      const existing = this.schemaVersion();
      let step = "snapshot";
      try {
        if (existing > 0 && existing < target) options.beforeMigrate?.(this, existing, target);
        step = "migrate";
        this.migrate(dataDir, migrations);
      } catch (error) {
        log.error("migration.failed", {
          fromVersion: existing,
          toVersion: target,
          step,
          error: formatLogError(error, { message: false }),
        });
        throw error;
      }
      this.ensureIndexes();
      this.instanceId = (
        this.db.query("SELECT value FROM storage_meta WHERE key = 'instance'").get() as {
          value: string;
        }
      ).value;
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.unregisterCacheGauges =
      options.cacheGaugeRegistry?.addCacheSource("storage-row-cache", this) ?? (() => undefined);
  }

  /**
   * How much this connection's revision-validated store cache holds. Walks
   * memory only (each store's length is computed once); committed entries
   * only, not a transaction's pending ones.
   */
  cacheGauges(): StorageRowCacheGauges {
    let rows = 0;
    let bytes = 0;
    for (const cached of this.cache.values()) {
      rows += cached.rows.size;
      let length = this.cachedLengths.get(cached);
      if (length === undefined) {
        length = cached.document?.length ?? 0;
        for (const row of cached.rows.values()) length += row.value.length;
        this.cachedLengths.set(cached, length);
      }
      bytes += length;
    }
    return { connections: this.closed ? 0 : 1, stores: this.cache.size, rows, bytes };
  }

  /**
   * Closes the connection. Planner statistics are refreshed first for the
   * tables this connection queried ({@link optimize}), as SQLite recommends,
   * and a deferred scrub is tried once more without waiting.
   */
  close(): void {
    if (this.closed) return;
    this.optimize();
    if (this.scrubRetry) {
      clearTimeout(this.scrubRetry);
      this.scrubRetry = null;
      this.tryTruncateWal();
    }
    this.closed = true;
    this.cache.clear();
    this.unregisterCacheGauges();
    this.db.close();
  }

  isClosed(): boolean {
    return this.closed;
  }

  /** Schema version before this open ran its migrations. */
  openedAtVersion = 0;

  private migrate(dataDir: string, migrations: readonly StorageMigration[]): void {
    const supported = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
    const versions = migrations.map((migration) => migration.version);
    if (new Set(versions).size !== versions.length) {
      throw new Error("Storage migration versions must be unique");
    }
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    // Exclusive so two backends opening a fresh directory cannot both import.
    this.db
      .transaction(() => {
        const current = (this.db.query("PRAGMA user_version").get() as { user_version: number })
          .user_version;
        if (current > supported) throw new StorageDatabaseVersionError(current, supported);
        this.openedAtVersion = current;
        for (const migration of ordered) {
          if (migration.version <= current) continue;
          migration.up({ dataDir, db: this.db, database: this });
          this.db.exec(`PRAGMA user_version = ${migration.version}`);
        }
      })
      .exclusive();
  }

  /**
   * Secondary indexes that change no stored value and no schema version, so
   * they are created on open rather than by a numbered migration: an older
   * build still opens the database and SQLite maintains an index it does not
   * know about. `store_rows_position` turns an insert's next-position lookup
   * (`max(position)` of one collection) and every ordered row fetch into an
   * index walk instead of a scan of the collection. Creating it is one write
   * on the first open after an upgrade; afterwards this reads the schema.
   */
  private ensureIndexes(): void {
    const present = new Set(
      (
        this.db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name),
    );
    if (!present.has("store_rows_position")) {
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS store_rows_position ON store_rows (store, collection, position)",
      );
    }
    // Partial indexes for `unownedRowIndexes`, the same way: SQLite keeps an
    // older build's writes to them current.
    for (const index of this.unownedRowIndexes.values()) {
      if (present.has(index.name)) continue;
      this.db.exec(
        `CREATE INDEX IF NOT EXISTS ${index.name} ON store_rows (key) WHERE ${index.where}`,
      );
    }
  }

  /**
   * The rows of a record store that have no owner, in key order: through the
   * store's partial index when it has one (`unownedRowIndexes`), else a walk
   * of the store's rows. Uncached, like {@link rows}.
   */
  listUnownedRows(store: string): Array<{ key: string; position: number; value: string }> {
    const index = this.unownedRowIndexes.get(store);
    // The planner uses a partial index only for a query whose WHERE repeats
    // the index's terms, so the store's name is inlined (it is checked when
    // the database opens); otherwise it is bound.
    const rows = (
      index
        ? this.db
            .query(
              `SELECT key, position, value FROM store_rows INDEXED BY ${index.name} WHERE ${index.where} ORDER BY key`,
            )
            .all()
        : this.db
            .query(
              "SELECT key, position, value FROM store_rows WHERE store = ? AND collection = '' AND owner IS NULL ORDER BY key",
            )
            .all(store)
    ) as Array<{ key: string; position: number; value: string }>;
    this.observe?.("read");
    this.fetched(rows.reduce((length, row) => length + row.value.length, 0));
    return rows;
  }

  schemaVersion(): number {
    return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  /**
   * Runs `fn` in one IMMEDIATE transaction. `fn` must be synchronous. `store`
   * names the store it works on for the slow-operation record, never more.
   */
  transaction<T>(fn: () => T, store?: string): T {
    if (this.pendingCache) {
      // Nested: bun:sqlite turns this into a savepoint; the outermost call
      // owns the pending cache.
      const saved = new Map(this.pendingCache);
      try {
        return this.runTransaction(fn, store);
      } catch (error) {
        this.pendingCache = saved;
        throw error;
      }
    }
    this.pendingCache = new Map();
    let pending: Map<string, CachedStore | null>;
    try {
      const result = this.runTransaction(fn, store);
      pending = this.pendingCache;
      return result;
    } catch (error) {
      pending = new Map();
      throw error;
    } finally {
      this.pendingCache = null;
      this.touchedRevisions.clear();
      for (const [store, entry] of pending!) {
        if (entry) this.cache.set(store, entry);
        else this.cache.delete(store);
      }
    }
  }

  private runTransaction<T>(fn: () => T, store: string | undefined): T {
    let result: T;
    try {
      this.timing.store = store ?? null;
      result = this.db.transaction(fn).immediate();
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_BUSY") leaseWaitMetrics.transactionBusy();
      throw error;
    }
    if (result instanceof Promise) {
      throw new Error("Storage transactions must be synchronous");
    }
    return result;
  }

  private setCache(store: string, entry: CachedStore | null): void {
    if (this.pendingCache) {
      this.pendingCache.set(store, entry);
      return;
    }
    if (entry) this.cache.set(store, entry);
    else this.cache.delete(store);
  }

  // ---------------------------------------------------------------------------
  // Stores

  /** The revision the next write of `store` commits; never reuses a deleted store's. */
  private nextRevision(store: string, committed: number | null): number {
    if (committed !== null) return committed + 1;
    const deleted = this.db
      .query("SELECT value FROM storage_meta WHERE key = ?")
      .get(`deleted-revision:${store}`) as { value: string } | null;
    return (deleted ? Number(deleted.value) : 0) + 1;
  }

  /**
   * A store's header without its rows: layout, representation and the
   * envelope (or whole) document. Lets an engine check an envelope's version
   * fields cheaply. `null` when the store does not exist.
   */
  readStoreHeader(store: string): {
    revision: number;
    layout: StoredLayoutKind;
    mode: "rows" | "document";
    document: string | null;
  } | null {
    return (
      (this.db
        .query("SELECT revision, layout, mode, document FROM stores WHERE name = ?")
        .get(store) as {
        revision: number;
        layout: StoredLayoutKind;
        mode: "rows" | "document";
        document: string | null;
      } | null) ?? null
    );
  }

  /** Current committed revision of a store, or `null` when it does not exist. */
  storeRevision(store: string): number | null {
    this.timing.nameCall(leaseFamily(store));
    const row = this.db.query("SELECT revision FROM stores WHERE name = ?").get(store) as {
      revision: number;
    } | null;
    return row?.revision ?? null;
  }

  hasStore(store: string): boolean {
    return this.storeRevision(store) !== null;
  }

  /**
   * Reads a store's value. Rows are parsed fresh on every call, so callers may
   * mutate the result. The serialized rows are cached and revalidated against
   * the committed revision, which also observes writes by other processes.
   */
  readStore(store: string): StoreSnapshot | null {
    const cached = this.loadCached(store, "read");
    if (!cached) return null;
    return { value: this.assemble(store, cached), revision: cached.revision };
  }

  /**
   * A store's serialized rows at the committed revision, unparsed, from this
   * connection's revision-validated cache (a miss fetches them). For read
   * models that keep parsed rows and re-parse only the rows whose serialized
   * value changed. The result is shared with the cache: callers must not
   * mutate it. `null` when the store does not exist.
   */
  readStoreSerialized(store: string): SerializedStore | null {
    const cached = this.loadCached(store, "read");
    if (!cached) return null;
    return {
      revision: cached.revision,
      layout: cached.layout,
      mode: cached.mode,
      document: cached.document,
      rows: cached.rows.values(),
    };
  }

  /**
   * Stores an exact, possibly invalid, serialized document. Used only by the
   * legacy import to carry an unreadable file forward: readers then see the
   * same "present but unreadable" state the file had instead of an absent,
   * empty store that a reconciliation could act on.
   */
  writeRawDocumentInTransaction(store: string, document: string): void {
    const revision = this.nextRevision(store, this.storeRevision(store));
    this.db.query("DELETE FROM store_rows WHERE store = ?").run(store);
    this.db
      .query(
        `INSERT INTO stores (name, revision, layout, mode, document, updated_at)
         VALUES (?, ?, ?, 'document', ?, ?)
         ON CONFLICT (name) DO UPDATE SET revision = excluded.revision, layout = excluded.layout,
           mode = excluded.mode, document = excluded.document, updated_at = excluded.updated_at`,
      )
      .run(store, revision, this.layoutFor(store).kind, document, Date.now());
    this.setCache(store, null);
  }

  /**
   * Discovers owned keys and unowned candidates in one read snapshot. An
   * owner backfill on another connection must not move a row between the two
   * result sets. The header shares that snapshot for representation changes.
   */
  listStoreRowKeysByOwner(
    store: string,
    owner: string,
  ): { owned: string[]; unowned: Array<{ key: string; value: string }> } | undefined {
    return this.db
      .transaction(() => {
        const header = this.readStoreHeader(store);
        if (!header) return { owned: [], unowned: [] };
        if (header.mode !== "rows") return undefined;
        return {
          owned: this.rows(store)
            .list({ collection: "", owner, values: false })
            .map((row) => row.key),
          unowned: this.listUnownedRows(store),
        };
      })
      .deferred();
  }

  /**
   * Reads only the rows of a record/array store whose owner column matches.
   * Returns the items as an array in stored order (record keys are dropped).
   */
  readStoreRowsByOwner(store: string, owner: string): unknown[] | null {
    this.timing.store = store;
    return this.db
      .transaction(() => {
        const header = this.readStoreHeader(store);
        if (!header) return null;
        if (header.mode === "document") {
          const cached = this.loadCachedInTransaction(store, header.revision, "read");
          const layout = this.layoutFor(store);
          const ownerOf =
            layout.kind === "record" || layout.kind === "array" ? layout.owner : undefined;
          const value = this.assemble(store, cached);
          const items = Array.isArray(value)
            ? value
            : isPlainRecord(value)
              ? Object.values(value)
              : [];
          return items.filter((item) => ownerOf?.(item) === owner);
        }
        // Do not populate the whole-store cache for an owner-scoped read.
        // The header and selected rows must come from the same snapshot.
        this.observe?.("read");
        const rows = this.db
          .query(
            "SELECT value FROM store_rows WHERE store = ? AND owner = ? ORDER BY position, key",
          )
          .all(store, owner) as Array<{ value: string }>;
        this.fetched(rows.reduce((length, row) => length + row.value.length, 0));
        try {
          return rows.map((row) => JSON.parse(row.value) as unknown);
        } catch (error) {
          if (error instanceof SyntaxError) throw new StoreCorruptError(store);
          throw error;
        }
      })
      .deferred();
  }

  /**
   * Reads one committed row without loading the store's cached history. The
   * header and value share a read snapshot, including representation changes
   * by another connection. When this connection already caches the store at
   * the committed revision the row comes from that cache and fetches nothing;
   * a miss fetches only the row and leaves the cache alone. A document
   * representation retains the legacy fallback.
   */
  readStoreRow(store: string, key: string, collection = ""): unknown | undefined {
    this.timing.store = store;
    return this.db
      .transaction(() => {
        const header = this.readStoreHeader(store);
        if (!header) return undefined;
        let value: unknown;
        try {
          if (header.mode === "rows") {
            this.observe?.("read");
            const cached = this.pendingCache?.has(store)
              ? this.pendingCache.get(store)
              : this.cache.get(store);
            if (cached && cached.revision === header.revision && cached.mode === "rows") {
              const hit = cached.rows.get(rowId(collection, key));
              return hit ? (JSON.parse(hit.value) as unknown) : undefined;
            }
            const row = this.db
              .query("SELECT value FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
              .get(store, collection, key) as { value: string } | null;
            this.fetched(row?.value.length ?? 0);
            return row ? (JSON.parse(row.value) as unknown) : undefined;
          }
          this.observe?.("read");
          this.fetched(header.document?.length ?? 0);
          value = assembleStoredValue(header, []);
        } catch (error) {
          if (error instanceof SyntaxError) throw new StoreCorruptError(store);
          throw error;
        }
        if (collection) {
          const records = isPlainRecord(value) ? value[collection] : undefined;
          return isPlainRecord(records) ? records[key] : undefined;
        }
        if (Array.isArray(value)) {
          const layout = this.layoutFor(store);
          const field = layout.kind === "array" ? (layout.key ?? "id") : "id";
          return value.find((item) => isPlainRecord(item) && item[field] === key);
        }
        return isPlainRecord(value) ? value[key] : undefined;
      })
      .deferred();
  }

  /**
   * Persists `value` as the store's complete new state, writing only the rows
   * that changed. Returns the new revision. With `expectedRevision` the write
   * is refused when the store moved since that revision, and with `maxBytes`
   * when the serialized value (document and rows, UTF-8) would exceed it.
   */
  writeStore(store: string, value: unknown, options: StoreWriteOptions = {}) {
    if (value === undefined) throw new Error(`Cannot persist undefined to ${store}`);
    return this.transaction(() => this.writeStoreInTransaction(store, value, options), store);
  }

  /** {@link writeStore} for use inside an existing {@link transaction}. */
  writeStoreInTransaction(store: string, value: unknown, options: StoreWriteOptions = {}): number {
    const layout = this.layoutFor(store);
    const committed = this.storeRevision(store);
    if (options.expectedRevision !== undefined && options.expectedRevision !== committed) {
      throw new StoreConflictError(store);
    }
    const next = decompose(layout, value);
    if (options.maxBytes !== undefined) {
      let bytes = next.document === null ? 0 : Buffer.byteLength(next.document, "utf8");
      for (const row of next.rows.values()) bytes += Buffer.byteLength(row.value, "utf8");
      if (bytes > options.maxBytes) throw new StoreTooLargeError(store, bytes);
    }
    const previous =
      committed === null ? null : this.loadCachedInTransaction(store, committed, "stat");
    if (previous?.mode === "rows" && next.mode === "rows")
      stabilizePositions(next.rows, previous.rows);
    const revision = this.nextRevision(store, committed);
    const now = Date.now();
    const upsertRow = this.db.query(
      `INSERT INTO store_rows (store, collection, key, position, owner, value)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (store, collection, key) DO UPDATE SET
         position = excluded.position, owner = excluded.owner, value = excluded.value`,
    );
    const deleteRow = this.db.query(
      "DELETE FROM store_rows WHERE store = ? AND collection = ? AND key = ?",
    );
    if (next.mode === "document" || previous?.mode === "document") {
      if (previous?.mode === "rows" || (previous && next.mode === "rows")) {
        // Switching representation: clear every old row first.
        this.db.query("DELETE FROM store_rows WHERE store = ?").run(store);
      }
    } else if (previous) {
      for (const [id, row] of previous.rows) {
        if (!next.rows.has(id)) deleteRow.run(store, row.collection, row.key);
      }
    }
    if (previous && previous.layout === layout.kind && isUnchanged(previous, next)) {
      return committed!;
    }
    const ownerOf = layout.kind === "record" || layout.kind === "array" ? layout.owner : undefined;
    if (next.mode === "rows") {
      const unchangedRows = previous?.mode === "rows" ? previous.rows : undefined;
      for (const [id, row] of next.rows) {
        const before = unchangedRows?.get(id);
        if (before && before.value === row.value && before.position === row.position) continue;
        const owner = ownerOf && !row.collection ? ownerOf(JSON.parse(row.value)) : undefined;
        upsertRow.run(store, row.collection, row.key, row.position, owner ?? null, row.value);
      }
    }
    this.db
      .query(
        `INSERT INTO stores (name, revision, layout, mode, document, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET revision = excluded.revision, layout = excluded.layout,
           mode = excluded.mode, document = excluded.document, updated_at = excluded.updated_at`,
      )
      .run(store, revision, layout.kind, next.mode, next.document, now);
    this.setCache(store, {
      revision,
      layout: layout.kind,
      document: next.document,
      rows: next.rows,
      mode: next.mode,
    });
    return revision;
  }

  /** Mutate legacy array documents without reducing duplicate IDs to a keyed row.
   * The mode check and mutation share a write transaction; normal row writers
   * must continue using updateStoreRow.
   */
  updateDocumentArrayRows<T>(store: string, mutate: (items: T[]) => void): void {
    this.transaction(() => {
      if (this.readStoreHeader(store)?.mode !== "document") {
        throw new Error("Expected an array document");
      }
      const current = this.readStoreValueInTransaction(store, { unreadable: "throw" })!
        .value as T[];
      mutate(current);
      this.writeStoreInTransaction(store, current);
    }, store);
  }

  /**
   * Synchronous read-modify-write in one IMMEDIATE transaction: SQLite's write
   * lock serializes it against every other connection, so no lease is needed.
   * `mutate` receives the current value (or `fallback()`), changes it in place,
   * and must not await. If it throws, nothing is written. An unreadable
   * store is replaced from `fallback()` unless `unreadable: "throw"`.
   */
  updateStore<V, T>(
    store: string,
    fallback: () => V,
    mutate: (value: V) => T,
    options: { unreadable?: "replace" | "throw" } = {},
  ): T {
    return this.transaction(() => {
      const current = (this.readStoreValueInTransaction(store, options) ?? { value: fallback() })
        .value as V;
      const result = mutate(current);
      this.writeStoreInTransaction(store, current);
      return result;
    }, store);
  }

  /**
   * Synchronous read-modify-write of ONE row, in one IMMEDIATE transaction:
   * a key of a `record` store, an item of a keyed `array` store, or a key of
   * one collection of an `envelope` store. Unlike {@link updateStore} it
   * neither parses nor rewrites the other rows, so writers holding different
   * keys' leases can commit concurrently without overwriting each other, and a
   * write costs O(row), not O(store).
   *
   * `mutate` receives the row's current value (`undefined` when absent) and
   * returns `{ result }` to leave it, `{ result, value }` to write it, or
   * `{ result, delete: true }` to remove it. An absent store is created (an
   * envelope as `{ [collection]: { [key]: value } }`). An array item keeps its
   * position when updated, a new one goes last, and its value must carry `key`
   * in the layout's key field, since a row and its item cannot name different
   * keys. A store held whole as a document falls back to a full
   * read-modify-write; if that document is unreadable, `unreadable: "throw"`
   * raises {@link StoreCorruptError} instead of replacing it. An unparsable row
   * raises it too, unless `unreadableRow: "replace"`, where `mutate` sees that
   * row as absent and may overwrite or delete it.
   */
  updateStoreRow<T>(
    store: string,
    key: string,
    mutate: (current: unknown) => RowUpdate<T>,
    options: {
      collection?: string;
      unreadable?: "replace" | "throw";
      unreadableRow?: "replace";
      /** Value to start from when the store is absent (or replaced); default `{}`. */
      initial?: () => Record<string, unknown>;
    } = {},
  ): T {
    const layout = this.layoutFor(store);
    const collection = options.collection ?? "";
    if (
      layout.kind === "record" || layout.kind === "array"
        ? collection !== ""
        : layout.kind !== "envelope" || !collection
    ) {
      throw new Error(
        `updateStoreRow requires a record store, a keyed array store or an envelope collection: ${store}`,
      );
    }
    if (layout.kind === "envelope" && !layout.collections.includes(collection)) {
      throw new Error(`Store ${store} has no collection ${collection}`);
    }
    return this.transaction(() => {
      const header = this.readStoreHeader(store);
      if (!header || header.mode === "document") {
        const whole = this.readStoreValueInTransaction(store, options);
        if (layout.kind === "array") {
          const items = Array.isArray(whole?.value) ? (whole.value as unknown[]) : [];
          const applied = applyArrayRowUpdate(store, layout, items, key, mutate);
          if (applied.changed) this.writeStoreInTransaction(store, items);
          return applied.result;
        }
        const value = isPlainRecord(whole?.value) ? { ...whole.value } : { ...options.initial?.() };
        const records = collection
          ? isPlainRecord(value[collection])
            ? { ...value[collection] }
            : {}
          : value;
        const update = mutate(records[key]);
        if (update.delete) delete records[key];
        else if ("value" in update) records[key] = update.value;
        else return update.result;
        this.writeStoreInTransaction(
          store,
          collection ? { ...value, [collection]: records } : records,
        );
        return update.result;
      }
      this.observe?.("read");
      const existing = this.db
        .query(
          "SELECT position, value FROM store_rows WHERE store = ? AND collection = ? AND key = ?",
        )
        .get(store, collection, key) as { position: number; value: string } | null;
      this.fetched(existing?.value.length ?? 0);
      let current: unknown;
      try {
        current = existing ? (JSON.parse(existing.value) as unknown) : undefined;
      } catch {
        if (options.unreadableRow !== "replace") throw new StoreCorruptError(store);
      }
      const update = mutate(current);
      if (layout.kind === "array" && !update.delete && "value" in update) {
        assertArrayRowKey(store, layout, key, update.value);
      }
      let document = header.document;
      let nextRow: StoreRow | null = null;
      if (update.delete) {
        if (!existing) return update.result;
        this.db
          .query("DELETE FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
          .run(store, collection, key);
      } else if ("value" in update) {
        if (update.value === undefined) throw new Error(`Cannot persist undefined to ${store}`);
        const value = JSON.stringify(update.value);
        if (existing?.value === value) return update.result;
        let position = existing?.position;
        if (position === undefined) {
          position = (
            this.db
              .query(
                "SELECT coalesce(max(position) + 1, 0) AS next FROM store_rows WHERE store = ? AND collection = ?",
              )
              .get(store, collection) as { next: number }
          ).next;
        }
        const owner =
          layout.kind === "record" || layout.kind === "array"
            ? layout.owner?.(update.value)
            : undefined;
        this.db
          .query(
            `INSERT INTO store_rows (store, collection, key, position, owner, value)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (store, collection, key) DO UPDATE SET
               owner = excluded.owner, value = excluded.value`,
          )
          .run(store, collection, key, position, owner ?? null, value);
        nextRow = { collection, key, position, value };
        if (collection && document !== null) {
          // A first row of a collection the envelope did not have yet.
          const envelope = JSON.parse(document) as Record<string, unknown>;
          if (envelope[collection] !== STORAGE_COLLECTION_MARKER) {
            envelope[collection] = STORAGE_COLLECTION_MARKER;
            document = JSON.stringify(envelope);
          }
        }
      } else {
        return update.result;
      }
      const revision = header.revision + 1;
      this.db
        .query("UPDATE stores SET revision = ?, document = ?, updated_at = ? WHERE name = ?")
        .run(revision, document, Date.now(), store);
      // Carry an already cached store forward so the next whole-store reader
      // does not refetch every row for one changed row. The map is copied
      // because a rollback must restore it, but the row values are shared, so
      // this copies references, never retained history.
      const cached = this.pendingCache?.has(store)
        ? this.pendingCache.get(store)
        : this.cache.get(store);
      if (cached?.revision === header.revision && cached.mode === "rows") {
        const rows = new Map(cached.rows);
        if (nextRow) rows.set(rowId(collection, key), nextRow);
        else rows.delete(rowId(collection, key));
        this.setCache(store, { ...cached, revision, document, rows });
      } else {
        this.setCache(store, null);
      }
      return update.result;
    }, store);
  }

  /**
   * {@link updateStoreRow} for a change that spans several rows of a `record`
   * store or of an `envelope`'s collections, plus (for an envelope) its
   * document, in one IMMEDIATE transaction. The store's other rows are neither
   * parsed nor reserialized. A row whose `value` is `undefined` is deleted.
   * `document` changes the envelope's non-collection fields in place. With
   * `maxBytes`, a write that grows the store (document and rows, UTF-8) past it
   * throws {@link StoreTooLargeError}; one that shrinks it always commits.
   * Returns `false`, writing nothing, when the store is absent or held whole as
   * a document, so the caller can fall back to a whole-value write.
   */
  updateStoreRows(
    store: string,
    rows: ReadonlyArray<{ collection?: string; key: string; value: unknown }>,
    options: { document?: (envelope: Record<string, unknown>) => void; maxBytes?: number } = {},
  ): boolean {
    const layout = this.layoutFor(store);
    if (layout.kind !== "record" && layout.kind !== "envelope") {
      throw new Error(`updateStoreRows requires a record or envelope store: ${store}`);
    }
    for (const { collection = "" } of rows) {
      if (layout.kind === "record" ? collection !== "" : !layout.collections.includes(collection)) {
        throw new Error(`Store ${store} has no collection ${collection}`);
      }
    }
    if (options.document && layout.kind !== "envelope") {
      throw new Error(`Store ${store} has no envelope document`);
    }
    const bytes = (text: string | null) => (text === null ? 0 : Buffer.byteLength(text, "utf8"));
    return this.transaction(() => {
      const header = this.readStoreHeader(store);
      if (!header || header.mode !== "rows") return false;
      this.observe?.("read");
      // A store this connection holds at the committed revision answers the
      // rows' old values without fetching them again.
      const cached = this.pendingCache?.has(store)
        ? this.pendingCache.get(store)
        : this.cache.get(store);
      const known = cached?.revision === header.revision && cached.mode === "rows" ? cached : null;
      const select = this.db.query(
        "SELECT position, value FROM store_rows WHERE store = ? AND collection = ? AND key = ?",
      );
      const written = new Map<string, StoreRow | null>();
      const markers = new Set<string>();
      let growth = 0;
      for (const { collection = "", key, value } of rows) {
        let existing: { position: number; value: string } | null;
        if (known) {
          existing = known.rows.get(rowId(collection, key)) ?? null;
        } else {
          existing = select.get(store, collection, key) as typeof existing;
          this.fetched(existing?.value.length ?? 0);
        }
        if (value === undefined) {
          if (!existing) continue;
          this.db
            .query("DELETE FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
            .run(store, collection, key);
          growth -= bytes(existing.value);
          written.set(rowId(collection, key), null);
          continue;
        }
        const serialized = JSON.stringify(value);
        if (existing?.value === serialized) continue;
        const position =
          existing?.position ??
          (
            this.db
              .query(
                "SELECT coalesce(max(position) + 1, 0) AS next FROM store_rows WHERE store = ? AND collection = ?",
              )
              .get(store, collection) as { next: number }
          ).next;
        const owner = layout.kind === "record" ? layout.owner?.(value) : undefined;
        this.db
          .query(
            `INSERT INTO store_rows (store, collection, key, position, owner, value)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (store, collection, key) DO UPDATE SET
               owner = excluded.owner, value = excluded.value`,
          )
          .run(store, collection, key, position, owner ?? null, serialized);
        growth += bytes(serialized) - bytes(existing?.value ?? null);
        written.set(rowId(collection, key), { collection, key, position, value: serialized });
        if (collection) markers.add(collection);
      }
      let document = header.document;
      if (layout.kind === "envelope" && (options.document || markers.size > 0)) {
        const envelope = (document === null ? {} : JSON.parse(document)) as Record<string, unknown>;
        options.document?.(envelope);
        for (const collection of markers) envelope[collection] = STORAGE_COLLECTION_MARKER;
        document = JSON.stringify(envelope);
        growth += bytes(document) - bytes(header.document);
      }
      if (written.size === 0 && document === header.document) return true;
      if (options.maxBytes !== undefined && growth > 0) {
        this.rowBytesSql ??= rowBytesExpression(this.db);
        const total =
          (
            this.db
              .query(
                `SELECT coalesce(sum(${this.rowBytesSql}), 0) AS total FROM store_rows WHERE store = ?`,
              )
              .get(store) as { total: number }
          ).total + bytes(document);
        if (total > options.maxBytes) throw new StoreTooLargeError(store, total);
      }
      const revision = header.revision + 1;
      this.db
        .query("UPDATE stores SET revision = ?, document = ?, updated_at = ? WHERE name = ?")
        .run(revision, document, Date.now(), store);
      // Carried forward as updateStoreRow does, so the next whole-store reader
      // fetches nothing for the rows this write did not touch.
      if (known) {
        const next = new Map(known.rows);
        for (const [id, row] of written) {
          if (row) next.set(id, row);
          else next.delete(id);
        }
        this.setCache(store, { ...known, revision, document, rows: next });
      } else {
        this.setCache(store, null);
      }
      return true;
    }, store);
  }

  /**
   * Keys and serialized sizes of a store's rows (one collection's, for an
   * envelope) without parsing them: quota accounting and eviction. `null`
   * when the store is absent or held whole as a document.
   */
  storeRowStats(
    store: string,
    collection = "",
  ): Array<{ key: string; bytes: number; position: number }> | null {
    const cached = this.loadCached(store, "stat");
    if (!cached || cached.mode === "document") return null;
    const stats: Array<{ key: string; bytes: number; position: number }> = [];
    for (const row of cached.rows.values()) {
      if (row.collection !== collection) continue;
      stats.push({
        key: row.key,
        bytes: Buffer.byteLength(row.value, "utf8"),
        position: row.position,
      });
    }
    return stats.sort((a, b) => a.position - b.position);
  }

  /**
   * Reads a store inside an open transaction. An unreadable document reads as
   * absent unless `unreadable: "throw"`.
   */
  readStoreValueInTransaction(
    store: string,
    options: { unreadable?: "replace" | "throw" } = {},
  ): { value: unknown } | null {
    const committed = this.storeRevision(store);
    if (committed === null) return null;
    try {
      return {
        value: this.assemble(store, this.loadCachedInTransaction(store, committed, "read")),
      };
    } catch (error) {
      if (error instanceof StoreCorruptError && options.unreadable !== "throw") return null;
      throw error;
    }
  }

  /** Removes a store entirely; the next read sees it as absent. */
  deleteStore(store: string): void {
    this.transaction(() => this.deleteStoreInTransaction(store), store);
  }

  deleteStoreInTransaction(store: string): void {
    const revision = this.storeRevision(store);
    if (revision !== null) {
      // Remembered so a recreated store continues the sequence: another
      // connection that cached the deleted store at some revision must never
      // see that number again for different content.
      this.db
        .query("INSERT OR REPLACE INTO storage_meta (key, value) VALUES (?, ?)")
        .run(`deleted-revision:${store}`, String(revision));
    }
    this.db.query("DELETE FROM store_rows WHERE store = ?").run(store);
    this.db.query("DELETE FROM stores WHERE name = ?").run(store);
    this.setCache(store, null);
  }

  /** Names of every stored store under `prefix` (for directory-like stores). */
  listStores(prefix = ""): string[] {
    const rows = this.db
      .query("SELECT name FROM stores WHERE substr(name, 1, ?) = ? ORDER BY name")
      .all(prefix.length, prefix) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  /**
   * Makes deleted content unrecoverable from the WAL. `secure_delete` zeroes
   * freed pages in the main file; a truncating checkpoint moves the deleting
   * transaction there and discards the old frames.
   *
   * It does not return the freed pages to the filesystem: they hold zeros
   * already, so that only gives space back, and an in-process
   * `incremental_vacuum` held the event loop for 250–450 ms after a deletion
   * on a 512 MiB database (storage.md, "Durability and deletion"). The main
   * file's five-minute upkeep releases them in a child process
   * (`runDatabaseUpkeep`), and the ledger's retention pass releases its own.
   *
   * The checkpoint never waits. A reader holding an older snapshot (an hourly
   * snapshot copy, another backend's long read) would make a truncating
   * checkpoint call the busy handler for the whole busy timeout, blocking the
   * event loop, so it runs with `busy_timeout = 0`: it copies what it can and
   * reports the rest busy. A busy or failed scrub is then retried from a timer,
   * also without waiting, {@link SCRUB_RETRY_FIRST_MS} later and doubling up to
   * {@link SCRUB_RETRY_MAX_MS}, until the WAL truncates or the connection
   * closes. So deleted content leaves the WAL within a minute of the last
   * older reader finishing. Never throws.
   */
  scrubDeletedContent(): void {
    if (this.tryTruncateWal()) {
      this.cancelScrubRetry();
      return;
    }
    this.scheduleScrubRetry();
  }

  /** Whether a scrub is waiting for readers to move on. */
  hasDeferredScrub(): boolean {
    return this.scrubRetry !== null;
  }

  /**
   * One truncating checkpoint that never invokes the busy handler. True when
   * the WAL was truncated. A failure is logged (throttled) and reported false.
   */
  private tryTruncateWal(): boolean {
    if (this.closed) return false;
    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      try {
        const { busy } = this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
          busy: number;
        };
        if (busy === 0) {
          log.recovered("scrub.checkpoint-failed", "scrub");
          return true;
        }
        log.throttled("warn", "scrub.checkpoint-failed", { scope: "scrub", kind: "busy" });
        return false;
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      }
    } catch (error) {
      log.throttled("warn", "scrub.checkpoint-failed", {
        scope: "scrub",
        error,
        fields: () => ({ error: formatLogError(error, { message: false, stack: false }) }),
      });
      return false;
    }
  }

  private scheduleScrubRetry(): void {
    if (this.closed || this.scrubRetry) return;
    const delay = this.scrubRetryDelayMs;
    this.scrubRetryDelayMs = Math.min(delay * 2, SCRUB_RETRY_MAX_MS);
    this.scrubRetry = setTimeout(() => {
      this.scrubRetry = null;
      if (this.closed) return;
      if (this.tryTruncateWal()) this.scrubRetryDelayMs = SCRUB_RETRY_FIRST_MS;
      else this.scheduleScrubRetry();
    }, delay);
    this.scrubRetry.unref?.();
  }

  private cancelScrubRetry(): void {
    if (this.scrubRetry) clearTimeout(this.scrubRetry);
    this.scrubRetry = null;
    this.scrubRetryDelayMs = SCRUB_RETRY_FIRST_MS;
  }

  /**
   * Refreshes the query planner's statistics for the tables this connection
   * has queried, with `PRAGMA optimize` bounded by `analysis_limit`. Cheap when
   * nothing changed much, which is the usual case, so it runs from the
   * periodic backup check and at close. It never waits for another writer and
   * never throws: stale statistics only cost plan quality.
   */
  optimize(): void {
    if (this.closed) return;
    try {
      // Statistics are written in a write transaction. Never wait for another
      // writer here: a busy database just keeps its statistics until next time.
      this.db.exec("PRAGMA busy_timeout = 0");
      try {
        this.db.exec(`PRAGMA analysis_limit = ${OPTIMIZE_ANALYSIS_LIMIT}`);
        this.db.exec("PRAGMA optimize");
      } finally {
        this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
      }
      log.recovered("optimize.failed", "optimize");
    } catch (error) {
      if ((error as { code?: unknown }).code === "SQLITE_BUSY") return;
      log.throttled("warn", "optimize.failed", {
        scope: "optimize",
        error,
        fields: () => ({ error: formatLogError(error, { message: false, stack: false }) }),
      });
    }
  }

  /** Estimated compact copy size, including live pages currently in the WAL. */
  livePageBytes(): number {
    return this.transaction(() => {
      const pages = (this.db.query("PRAGMA page_count").get() as { page_count: number }).page_count;
      const free = (this.db.query("PRAGMA freelist_count").get() as { freelist_count: number })
        .freelist_count;
      const size = (this.db.query("PRAGMA page_size").get() as { page_size: number }).page_size;
      return Math.max(1, pages - free) * size;
    });
  }

  /** The page figures of this file. Takes no write lock; a reader never waits on a writer. */
  pageStats(): { pageBytes: number; pageCount: number; freelistPages: number } {
    return {
      pageBytes: (this.db.query("PRAGMA page_size").get() as { page_size: number }).page_size,
      pageCount: (this.db.query("PRAGMA page_count").get() as { page_count: number }).page_count,
      freelistPages: (this.db.query("PRAGMA freelist_count").get() as { freelist_count: number })
        .freelist_count,
    };
  }

  /**
   * Free pages a release could return: the free list with incremental
   * auto-vacuum, else 0 (free pages are then only reused). Two pragma reads,
   * no lock, so the upkeep can skip starting a release that has nothing to do.
   */
  releasableFreePages(): number {
    const { auto_vacuum } = this.db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
    if (auto_vacuum !== 2) return 0;
    return (this.db.query("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count;
  }

  /**
   * Returns up to `maxPages` free pages to the filesystem (with incremental
   * auto-vacuum; a no-op otherwise) and the number of free pages left (-1 on
   * contention). A bounded step, so a caller freeing much space can yield between steps.
   */
  releaseFreePages(maxPages = INCREMENTAL_VACUUM_PAGES): number {
    this.db.exec("PRAGMA busy_timeout = 0");
    try {
      this.db.exec(`PRAGMA incremental_vacuum(${Math.max(1, Math.floor(maxPages))})`);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return -1;
      throw error;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${this.busyTimeoutMs}`);
    }
    const { auto_vacuum } = this.db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
    // Without incremental auto-vacuum free pages are only reused, never released.
    if (auto_vacuum !== 2) return 0;
    return (this.db.query("PRAGMA freelist_count").get() as { freelist_count: number })
      .freelist_count;
  }

  private loadCached(store: string, use: StorageReadEvent): CachedStore | null {
    this.timing.store = store;
    return this.db
      .transaction(() => {
        const committed = this.storeRevision(store);
        if (committed === null) {
          this.setCache(store, null);
          return null;
        }
        return this.loadCachedInTransaction(store, committed, use);
      })
      .deferred();
  }

  /**
   * The store's rows at `committed`, from this connection's cache when its
   * revision matches. `use` is how a cache hit is observed: `read` when the
   * caller decodes the rows, `stat` for an internal lookup. A miss fetches
   * every row, which is always a read.
   */
  private loadCachedInTransaction(
    store: string,
    committed: number,
    use: StorageReadEvent,
  ): CachedStore {
    const cached = this.pendingCache?.has(store)
      ? this.pendingCache.get(store)
      : this.cache.get(store);
    if (cached && cached.revision === committed) {
      this.observe?.(use);
      return cached;
    }
    this.observe?.("read");
    const meta = this.db
      .query("SELECT revision, layout, mode, document FROM stores WHERE name = ?")
      .get(store) as {
      revision: number;
      layout: StoredLayoutKind;
      mode: "rows" | "document";
      document: string | null;
    };
    const rows = new Map<string, StoreRow>();
    let length = meta.document?.length ?? 0;
    if (meta.mode === "rows") {
      for (const row of this.db
        .query(
          "SELECT collection, key, position, value FROM store_rows WHERE store = ? ORDER BY collection, position, key",
        )
        .all(store) as StoreRow[]) {
        rows.set(rowId(row.collection, row.key), row);
        length += row.value.length;
      }
    }
    this.fetched(length);
    const loaded: CachedStore = {
      revision: meta.revision,
      layout: meta.layout,
      document: meta.document,
      rows,
      mode: meta.mode,
    };
    this.setCache(store, loaded);
    return loaded;
  }

  private fetched(length: number): void {
    if (length > 0) this.observeFetch?.(length);
  }

  private assemble(store: string, cached: CachedStore): unknown {
    try {
      return this.assembleValue(store, cached);
    } catch (error) {
      if (error instanceof SyntaxError) throw new StoreCorruptError(store);
      throw error;
    }
  }

  private assembleValue(_store: string, cached: CachedStore): unknown {
    // The stored layout, not the current registry, decides how rows assemble:
    // a value written under one layout always reads back as written.
    return assembleStoredValue(cached, cached.rows.values());
  }

  /**
   * Removes lease rows whose holder stopped heartbeating long ago. A crashed
   * holder's row is otherwise only reclaimed when someone next takes that
   * exact lease, and per-key names (one per native session, per canvas) may
   * never recur. Live holders heartbeat at least every `staleMs / 3`, and no
   * lease uses a `staleMs` anywhere near `olderThanMs`.
   */
  purgeAbandonedLeases(olderThanMs = 60 * 60 * 1000): number {
    return this.db.query("DELETE FROM leases WHERE heartbeat_at < ?").run(Date.now() - olderThanMs)
      .changes;
  }

  /**
   * Writes a consistent, compacted copy of the database to `file` (which must
   * not exist) without blocking other connections' writers for the copy:
   * `VACUUM INTO` reads one snapshot. Synchronous; it blocks this event loop
   * for roughly the time it takes to copy the file, so only the pre-migration
   * snapshot (which must finish before the open does) uses it. Hourly
   * snapshots copy in a child process (`copyDatabaseInChildProcess`).
   */
  backupTo(file: string): void {
    this.db.query("VACUUM INTO ?").run(file);
  }

  /**
   * Uncached row access for large stores whose engines must not hold the
   * whole store in memory (display tails, transcript manifests, web
   * annotations). Reads go straight to the rows; writes must run inside
   * {@link transaction}. Each committing transaction that writes bumps the
   * store's revision once (`storeRevision` still moves for every writer) and
   * drops this connection's cached copy, so the cached APIs stay correct for
   * the same store. Values are serialized JSON strings: callers own parsing
   * and validation.
   */
  rows(store: string): StoreRows {
    const layout = this.layoutFor(store);
    if (layout.kind !== "record" && layout.kind !== "envelope") {
      throw new Error(`Row access requires a record or envelope store: ${store}`);
    }
    const db = this.db;
    this.rowBytesSql ??= rowBytesExpression(db);
    const rowBytes = this.rowBytesSql;
    const ownerOf = layout.kind === "record" ? layout.owner : undefined;
    // Uncached, so every query that returns rows or keys is a database read;
    // the write paths below charge nothing here.
    const read = (length = 0): void => {
      this.observe?.("read");
      this.fetched(length);
    };
    const requireTransaction = (): Map<string, CachedStore | null> => {
      if (!this.pendingCache) {
        throw new Error(`Row writes to ${store} must run inside a storage transaction`);
      }
      return this.pendingCache;
    };
    const touch = () => {
      const pending = requireTransaction();
      const committed = this.storeRevision(store);
      const touched = pending.get(store);
      // One bump per transaction: a later write in the same transaction
      // sees its own pending revision.
      if (
        touched === null &&
        committed !== null &&
        this.touchedRevisions.get(store) === committed
      ) {
        return;
      }
      const revision = this.nextRevision(store, committed);
      if (committed === null) {
        const envelope =
          layout.kind === "envelope"
            ? JSON.stringify(
                Object.fromEntries(
                  layout.collections.map((name) => [name, STORAGE_COLLECTION_MARKER]),
                ),
              )
            : null;
        db.query(
          `INSERT INTO stores (name, revision, layout, mode, document, updated_at)
           VALUES (?, ?, ?, 'rows', ?, ?)`,
        ).run(store, revision, layout.kind, envelope, Date.now());
      } else {
        const mode = (
          db.query("SELECT mode FROM stores WHERE name = ?").get(store) as { mode: string }
        ).mode;
        if (mode !== "rows") {
          throw new Error(`Row access requires ${store} to be stored as rows`);
        }
        db.query("UPDATE stores SET revision = ?, updated_at = ? WHERE name = ?").run(
          revision,
          Date.now(),
          store,
        );
      }
      this.touchedRevisions.set(store, revision);
      this.setCache(store, null);
    };
    return {
      get(key, collection = "") {
        const row = db
          .query("SELECT value FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
          .get(store, collection, key) as { value: string } | null;
        read(row?.value.length);
        return row?.value;
      },
      entry(key, collection = "") {
        const row = db
          .query(
            `SELECT collection, key, position, owner, value, ${rowBytes} AS bytes
             FROM store_rows WHERE store = ? AND collection = ? AND key = ?`,
          )
          .get(store, collection, key) as StoreRowEntry | null;
        read(row?.value?.length);
        return row ?? undefined;
      },
      has(key, collection = "") {
        read();
        return (
          db
            .query(
              "SELECT 1 AS present FROM store_rows WHERE store = ? AND collection = ? AND key = ?",
            )
            .get(store, collection, key) !== null
        );
      },
      list(options = {}) {
        const clauses = ["store = ?"];
        const parameters: Array<string> = [store];
        if (options.collection !== undefined) {
          clauses.push("collection = ?");
          parameters.push(options.collection);
        }
        if (options.owner !== undefined) {
          clauses.push("owner = ?");
          parameters.push(options.owner);
        }
        // Sizes only: scan the primary key and sort here. Ordering in SQL walks
        // `store_rows_position` and seeks each row, and a seek in this WITHOUT
        // ROWID table reads whole cells, overflow pages included, to compare
        // keys, which costs as much as reading the values.
        const sizesOnly = options.values === false;
        const entries = db
          .query(
            `SELECT collection, key, position, owner, ${sizesOnly ? "NULL AS value" : "value"},
               ${rowBytes} AS bytes FROM store_rows
             WHERE ${clauses.join(" AND ")}${sizesOnly ? "" : " ORDER BY collection, position, key"}`,
          )
          .all(...parameters) as StoreRowEntry[];
        if (sizesOnly) entries.sort(compareRowEntries);
        read(entries.reduce((length, entry) => length + (entry.value?.length ?? 0), 0));
        return entries;
      },
      owners() {
        read();
        return (
          db
            .query(
              "SELECT DISTINCT owner FROM store_rows WHERE store = ? AND owner IS NOT NULL ORDER BY owner",
            )
            .all(store) as Array<{ owner: string }>
        ).map((row) => row.owner);
      },
      put(key, value, options = {}) {
        const collection = options.collection ?? "";
        if (layout.kind === "envelope" && !layout.collections.includes(collection)) {
          throw new Error(`Store ${store} has no collection ${collection}`);
        }
        if (layout.kind === "record" && collection) {
          throw new Error(`Record store ${store} has no collections`);
        }
        touch();
        let position = options.position;
        if (position === undefined) {
          const existing = db
            .query("SELECT position FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
            .get(store, collection, key) as { position: number } | null;
          position =
            existing?.position ??
            (
              db
                .query(
                  "SELECT coalesce(max(position) + 1, 0) AS next FROM store_rows WHERE store = ? AND collection = ?",
                )
                .get(store, collection) as { next: number }
            ).next;
        }
        const owner =
          options.owner !== undefined
            ? options.owner
            : ownerOf && !collection
              ? (ownerOf(JSON.parse(value)) ?? null)
              : null;
        db.query(
          `INSERT INTO store_rows (store, collection, key, position, owner, value)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (store, collection, key) DO UPDATE SET
             position = excluded.position, owner = excluded.owner, value = excluded.value`,
        ).run(store, collection, key, position, owner, value);
      },
      delete(key, collection = "") {
        requireTransaction();
        const changes = db
          .query("DELETE FROM store_rows WHERE store = ? AND collection = ? AND key = ?")
          .run(store, collection, key).changes;
        if (changes > 0) touch();
        return changes > 0;
      },
      deleteWhere(options) {
        requireTransaction();
        const clauses = ["store = ?"];
        const parameters: Array<string> = [store];
        if (options.collection !== undefined) {
          clauses.push("collection = ?");
          parameters.push(options.collection);
        }
        if (options.owner !== undefined) {
          clauses.push("owner = ?");
          parameters.push(options.owner);
        }
        const changes = db
          .query(`DELETE FROM store_rows WHERE ${clauses.join(" AND ")}`)
          .run(...parameters).changes;
        if (changes > 0) touch();
        return changes;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Leases

  /**
   * Cross-process exclusive lease. A holder heartbeats every `staleMs / 3`; a
   * waiter reclaims a lease whose heartbeat is older than its own `staleMs`.
   * The check-and-claim is one IMMEDIATE transaction, so two waiters can never
   * both reclaim the same stale holder.
   *
   * `staleMs` and `acquireTimeoutMs` must both exceed the critical section the
   * lease guards, or a waiter can steal it from a live holder whose event loop
   * merely stalled (machine sleep is the realistic case).
   */
  async acquireLease(
    name: string,
    description: string,
    options: { staleMs?: number; acquireTimeoutMs?: number } = {},
  ): Promise<() => Promise<void>> {
    const staleMs = options.staleMs ?? 15_000;
    const acquireTimeoutMs = options.acquireTimeoutMs ?? 20_000;
    const heartbeatMs = Math.max(1_000, Math.floor(staleMs / 3));
    const owner = randomUUID();
    const waitStartedAt = Date.now();
    const deadline = waitStartedAt + acquireTimeoutMs;
    // Lease statements are counted under the lease's family, apart from the
    // store it guards (to-do 7562: each claim and release is its own commit).
    const caller = `lease:${leaseFamily(name)}`;
    const claim = this.db.query(
      `INSERT INTO leases (name, owner, heartbeat_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
       WHERE leases.heartbeat_at < ?4`,
    );
    while (true) {
      if (this.closed) throw new Error(`Storage closed while waiting for ${description} lock`);
      const now = Date.now();
      this.timing.nameCall(caller);
      const claimed = this.transaction(() => {
        claim.run(name, owner, now, now - staleMs);
        const row = this.db.query("SELECT owner FROM leases WHERE name = ?").get(name) as {
          owner: string;
        } | null;
        return row?.owner === owner;
      });
      if (claimed) {
        leaseWaitMetrics.acquired(name, Date.now() - waitStartedAt);
        break;
      }
      if (Date.now() >= deadline) {
        this.reportLeaseTimeout(name, Date.now() - waitStartedAt);
        throw new Error(`Timed out waiting for ${description} lock`);
      }
      await sleep(25);
    }
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        this.timing.nameCall(caller);
        const renewed = this.db
          .query("UPDATE leases SET heartbeat_at = ? WHERE name = ? AND owner = ?")
          .run(Date.now(), name, owner);
        if (renewed.changes > 0) log.recovered("lease.heartbeat-failed", name);
      } catch (error) {
        // A missed heartbeat only shortens the lease; the next one retries.
        log.throttled("warn", "lease.heartbeat-failed", {
          scope: name,
          error,
          fields: () => ({ error: formatLogError(error, { message: false, stack: false }) }),
        });
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      if (this.closed) return;
      this.timing.nameCall(caller);
      this.db.query("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
    };
  }

  /**
   * Names who is waiting on whom. Holder age is the time since the holder's last
   * heartbeat, so a large one is a dead or stalled holder and a small one a live
   * holder keeping the lease for longer than this waiter would wait.
   */
  private reportLeaseTimeout(name: string, waitedMs: number): void {
    leaseWaitMetrics.timedOut(name, waitedMs);
    let holderAgeMs: number | null = null;
    try {
      const holder = this.db.query("SELECT heartbeat_at FROM leases WHERE name = ?").get(name) as {
        heartbeat_at: number;
      } | null;
      if (holder) holderAgeMs = Math.max(0, Date.now() - holder.heartbeat_at);
    } catch {
      // The age is detail: the timeout still gets its line.
    }
    log.warn("lease.timed-out", {
      lease: leaseLogName(name),
      family: leaseFamily(name),
      holderAgeMs,
      waitedMs,
    });
  }
}

/**
 * The SQL for a row value's UTF-8 length. `octet_length` (SQLite 3.43) reads the
 * length from the record header, so sizing a value never reads its overflow
 * pages. Bun on macOS loads the system library, which varies with the macOS
 * version, so the slower cast stays as the fallback.
 */
export function rowBytesExpression(db: Pick<Database, "query">): string {
  try {
    db.query("SELECT octet_length('')").get();
    return "octet_length(value)";
  } catch {
    return "length(CAST(value AS BLOB))";
  }
}

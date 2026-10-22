import { Database } from "bun:sqlite";
import {
  STORAGE_COLLECTION_MARKER,
  STORAGE_DATABASE_FILE,
  assembleStoredValue,
  type StoredLayoutKind,
} from "@orkestrator/protocol/node/storage-database";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

/** Freed pages returned per scrub (4 KiB pages: at most 16 MiB at a time). */
const INCREMENTAL_VACUUM_PAGES = 4096;

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

type StoreRow = { collection: string; key: string; position: number; value: string };
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class StorageDatabase {
  readonly path: string;
  readonly db: Database;
  /** Random per-database identity; part of every snapshot revision. */
  readonly instanceId: string;
  private readonly cache = new Map<string, CachedStore>();
  /**
   * Cache entries written by the open transaction. Applied only after the
   * outermost commit: a rolled-back revision must never be cached, or a later
   * foreign commit reusing that revision number would be shadowed by it.
   */
  private pendingCache: Map<string, CachedStore | null> | null = null;
  /** Revision each store was bumped to by row writes in the open transaction. */
  private readonly touchedRevisions = new Map<string, number>();
  private readonly layoutFor: (store: string) => StoreLayout;
  private readonly observe: ((event: StorageReadEvent) => void) | undefined;
  private readonly observeFetch: ((length: number) => void) | undefined;
  private closed = false;

  constructor(dataDir: string, options: StorageDatabaseOptions = {}) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.path = path.join(dataDir, STORAGE_DATABASE_FILE);
    if (fs.existsSync(this.path) && fs.lstatSync(this.path).isSymbolicLink()) {
      throw new Error("Storage database must not be a symbolic link");
    }
    this.layoutFor = options.layoutFor ?? (() => ({ kind: "document" }));
    this.observe = options.observe;
    this.observeFetch = options.observeFetch;
    this.db = new Database(this.path, { create: true, strict: true });
    try {
      // Sensitive stores (agent mail, prompt queues, credentials) share this
      // file. SQLite creates -wal/-shm with the database file's mode.
      fs.chmodSync(this.path, 0o600);
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, options.busyTimeoutMs ?? 10_000)}`);
      // Only takes effect before the first table exists (a new database);
      // switching later needs a full VACUUM. Lets deletes give space back.
      this.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      this.db.exec("PRAGMA journal_mode = WAL");
      // Structural writes were fsynced before; keep commits durable.
      this.db.exec("PRAGMA synchronous = FULL");
      // Deleting user content must not leave it readable in free pages.
      this.db.exec("PRAGMA secure_delete = ON");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_size_limit = 8388608");
      const migrations = [SCHEMA, ...(options.migrations ?? [])];
      const target = migrations.reduce((max, migration) => Math.max(max, migration.version), 0);
      const existing = this.schemaVersion();
      if (existing > 0 && existing < target) options.beforeMigrate?.(this, existing, target);
      this.migrate(dataDir, migrations);
      this.instanceId = (
        this.db.query("SELECT value FROM storage_meta WHERE key = 'instance'").get() as {
          value: string;
        }
      ).value;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
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

  schemaVersion(): number {
    return (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  /** Runs `fn` in one IMMEDIATE transaction. `fn` must be synchronous. */
  transaction<T>(fn: () => T): T {
    if (this.pendingCache) {
      // Nested: bun:sqlite turns this into a savepoint; the outermost call
      // owns the pending cache.
      const saved = new Map(this.pendingCache);
      try {
        return this.runTransaction(fn);
      } catch (error) {
        this.pendingCache = saved;
        throw error;
      }
    }
    this.pendingCache = new Map();
    let pending: Map<string, CachedStore | null>;
    try {
      const result = this.runTransaction(fn);
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

  private runTransaction<T>(fn: () => T): T {
    const result = this.db.transaction(fn).immediate();
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
   * Reads only the rows of a record/array store whose owner column matches.
   * Returns the items as an array in stored order (record keys are dropped).
   */
  readStoreRowsByOwner(store: string, owner: string): unknown[] | null {
    const cached = this.loadCached(store, "read");
    if (!cached) return null;
    if (cached.mode === "document") {
      const layout = this.layoutFor(store);
      const ownerOf =
        layout.kind === "record" || layout.kind === "array" ? layout.owner : undefined;
      const value = this.assemble(store, cached);
      const items = Array.isArray(value) ? value : isPlainRecord(value) ? Object.values(value) : [];
      return items.filter((item) => ownerOf?.(item) === owner);
    }
    const rows = this.db
      .query("SELECT value FROM store_rows WHERE store = ? AND owner = ? ORDER BY position, key")
      .all(store, owner) as Array<{ value: string }>;
    this.fetched(rows.reduce((length, row) => length + row.value.length, 0));
    return rows.map((row) => JSON.parse(row.value) as unknown);
  }

  /**
   * Reads one committed row without loading the store's cached history. The
   * header and value share a read snapshot, including representation changes
   * by another connection. A document representation retains the legacy fallback.
   */
  readStoreRow(store: string, key: string, collection = ""): unknown | undefined {
    return this.db
      .transaction(() => {
        const header = this.readStoreHeader(store);
        if (!header) return undefined;
        let value: unknown;
        try {
          if (header.mode === "rows") {
            this.observe?.("read");
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
   * is refused when the store moved since that revision.
   */
  writeStore(store: string, value: unknown, options: { expectedRevision?: number | null } = {}) {
    if (value === undefined) throw new Error(`Cannot persist undefined to ${store}`);
    return this.transaction(() => this.writeStoreInTransaction(store, value, options));
  }

  /** {@link writeStore} for use inside an existing {@link transaction}. */
  writeStoreInTransaction(
    store: string,
    value: unknown,
    options: { expectedRevision?: number | null } = {},
  ): number {
    const layout = this.layoutFor(store);
    const committed = this.storeRevision(store);
    if (options.expectedRevision !== undefined && options.expectedRevision !== committed) {
      throw new StoreConflictError(store);
    }
    const next = decompose(layout, value);
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
    });
  }

  /**
   * Synchronous read-modify-write of ONE row, in one IMMEDIATE transaction:
   * a key of a `record` store, or a key of one collection of an `envelope`
   * store. Unlike {@link updateStore} it neither parses nor rewrites the other
   * rows, so writers holding different keys' leases can commit concurrently
   * without overwriting each other, and a write costs O(row), not O(store).
   *
   * `mutate` receives the row's current value (`undefined` when absent) and
   * returns `{ result }` to leave it, `{ result, value }` to write it, or
   * `{ result, delete: true }` to remove it. An absent store is created (an
   * envelope as `{ [collection]: { [key]: value } }`). A store held whole as a
   * document falls back to a full read-modify-write; if that document is
   * unreadable, `unreadable: "throw"` raises {@link StoreCorruptError} instead
   * of replacing it.
   */
  updateStoreRow<T>(
    store: string,
    key: string,
    mutate: (current: unknown) => RowUpdate<T>,
    options: {
      collection?: string;
      unreadable?: "replace" | "throw";
      /** Value to start from when the store is absent (or replaced); default `{}`. */
      initial?: () => Record<string, unknown>;
    } = {},
  ): T {
    const layout = this.layoutFor(store);
    const collection = options.collection ?? "";
    if (layout.kind === "record" ? collection !== "" : layout.kind !== "envelope" || !collection) {
      throw new Error(`updateStoreRow requires a record store or an envelope collection: ${store}`);
    }
    if (layout.kind === "envelope" && !layout.collections.includes(collection)) {
      throw new Error(`Store ${store} has no collection ${collection}`);
    }
    return this.transaction(() => {
      const header = this.readStoreHeader(store);
      if (!header || header.mode === "document") {
        const whole = this.readStoreValueInTransaction(store, options);
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
        throw new StoreCorruptError(store);
      }
      const update = mutate(current);
      let document = header.document;
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
        const owner = layout.kind === "record" ? layout.owner?.(update.value) : undefined;
        this.db
          .query(
            `INSERT INTO store_rows (store, collection, key, position, owner, value)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (store, collection, key) DO UPDATE SET
               owner = excluded.owner, value = excluded.value`,
          )
          .run(store, collection, key, position, owner ?? null, value);
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
      // Whole-store readers must reload after a keyed write; keeping a full
      // cached copy here would make each mutation copy retained history.
      this.setCache(store, null);
      return update.result;
    });
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
    this.transaction(() => this.deleteStoreInTransaction(store));
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
   * transaction there and discards the old frames. Busy readers can defer
   * truncation, so this is best effort and never throws.
   */
  scrubDeletedContent(): void {
    try {
      // Return a bounded number of freed pages to the filesystem first, so a
      // large delete shrinks the file without one long blocking vacuum.
      this.db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // A concurrent reader keeps the WAL alive; the next checkpoint scrubs it.
    }
  }

  private loadCached(store: string, use: StorageReadEvent): CachedStore | null {
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
   * for roughly the time it takes to copy the file.
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
            `SELECT collection, key, position, owner, value, length(CAST(value AS BLOB)) AS bytes
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
        const columns =
          options.values === false
            ? "collection, key, position, owner, NULL AS value"
            : "collection, key, position, owner, value";
        const entries = db
          .query(
            `SELECT ${columns}, length(CAST(value AS BLOB)) AS bytes FROM store_rows
             WHERE ${clauses.join(" AND ")} ORDER BY collection, position, key`,
          )
          .all(...parameters) as StoreRowEntry[];
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
    const deadline = Date.now() + acquireTimeoutMs;
    const claim = this.db.query(
      `INSERT INTO leases (name, owner, heartbeat_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
       WHERE leases.heartbeat_at < ?4`,
    );
    while (true) {
      if (this.closed) throw new Error(`Storage closed while waiting for ${description} lock`);
      const now = Date.now();
      const claimed = this.transaction(() => {
        claim.run(name, owner, now, now - staleMs);
        const row = this.db.query("SELECT owner FROM leases WHERE name = ?").get(name) as {
          owner: string;
        } | null;
        return row?.owner === owner;
      });
      if (claimed) break;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description} lock`);
      await sleep(25);
    }
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      try {
        this.db
          .query("UPDATE leases SET heartbeat_at = ? WHERE name = ? AND owner = ?")
          .run(Date.now(), name, owner);
      } catch {
        // A missed heartbeat only shortens the lease; the next one retries.
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      if (this.closed) return;
      this.db.query("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
    };
  }
}

/** Same mode, document and rows: persisting would only bump the revision. */
function isUnchanged(
  previous: CachedStore,
  next: { mode: "rows" | "document"; document: string | null; rows: Map<string, StoreRow> },
): boolean {
  if (previous.mode !== next.mode || previous.document !== next.document) return false;
  if (previous.rows.size !== next.rows.size) return false;
  for (const [id, row] of next.rows) {
    const before = previous.rows.get(id);
    if (!before || before.value !== row.value || before.position !== row.position) return false;
  }
  return true;
}

function rowId(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

/**
 * Keeps the stored positions of surviving rows when their relative order is
 * unchanged and new rows only append, so removing or adding one item writes
 * one row instead of renumbering every row after it. Any other reorder keeps
 * the dense positions {@link decompose} assigned.
 */
function stabilizePositions(next: Map<string, StoreRow>, previous: Map<string, StoreRow>): void {
  const byCollection = new Map<string, StoreRow[]>();
  for (const row of next.values()) {
    const rows = byCollection.get(row.collection) ?? [];
    rows.push(row);
    byCollection.set(row.collection, rows);
  }
  for (const [collection, rows] of byCollection) {
    let last = -Infinity;
    let max = -Infinity;
    for (const row of previous.values()) {
      if (row.collection === collection) max = Math.max(max, row.position);
    }
    let sawNew = false;
    let appendOnly = true;
    for (const row of rows) {
      const before = previous.get(rowId(collection, row.key));
      if (!before) {
        sawNew = true;
        continue;
      }
      if (sawNew || before.position <= last) {
        appendOnly = false;
        break;
      }
      last = before.position;
    }
    if (!appendOnly) continue;
    let nextPosition = Number.isFinite(max) ? max + 1 : 0;
    for (const row of rows) {
      const before = previous.get(rowId(collection, row.key));
      row.position = before ? before.position : nextPosition++;
    }
  }
}

function decompose(
  layout: StoreLayout,
  value: unknown,
): { mode: "rows" | "document"; document: string | null; rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>();
  const asDocument = () => ({
    mode: "document" as const,
    document: JSON.stringify(value),
    rows: new Map<string, StoreRow>(),
  });
  if (layout.kind === "document") return asDocument();
  if (layout.kind === "array") {
    if (!Array.isArray(value)) return asDocument();
    const field = layout.key ?? "id";
    for (const [position, item] of value.entries()) {
      const id = isPlainRecord(item) ? item[field] : undefined;
      if (typeof id !== "string" || !id || rows.has(rowId("", id))) return asDocument();
      rows.set(rowId("", id), { collection: "", key: id, position, value: JSON.stringify(item) });
    }
    return { mode: "rows", document: null, rows };
  }
  if (layout.kind === "record") {
    if (!isPlainRecord(value)) return asDocument();
    let position = 0;
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      rows.set(rowId("", key), { collection: "", key, position, value: JSON.stringify(item) });
      position += 1;
    }
    return { mode: "rows", document: null, rows };
  }
  if (!isPlainRecord(value)) return asDocument();
  const envelope: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!layout.collections.includes(field)) {
      envelope[field] = fieldValue;
      continue;
    }
    if (fieldValue === undefined) continue;
    if (!isPlainRecord(fieldValue)) return asDocument();
    envelope[field] = STORAGE_COLLECTION_MARKER;
    let position = 0;
    for (const [key, item] of Object.entries(fieldValue)) {
      if (item === undefined) continue;
      rows.set(rowId(field, key), {
        collection: field,
        key,
        position,
        value: JSON.stringify(item),
      });
      position += 1;
    }
  }
  return { mode: "rows", document: JSON.stringify(envelope), rows };
}

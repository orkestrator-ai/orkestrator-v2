import type { Database } from "bun:sqlite";
import fs from "node:fs";
import { rowId, type StoreRow } from "./storage-database-rows.js";

/** SQLite queries and file checks of {@link StorageDatabase} kept outside the class. */

/**
 * Which rows of one collection {@link StorageDatabase.readStoreRowsSerialized}
 * selects: the rows named by `keys`, or every row whose key starts with
 * `keyPrefix`. A prefix must end in NUL, the separator of composite keys such
 * as agent mailbox ids (`environmentId\0tabId`), so the range it covers is
 * exactly `[prefix, prefix with its NUL raised to U+0001)`.
 */
export type RowSelection = { keys: readonly string[] } | { keyPrefix: string };

/** What {@link StorageDatabase.readStoreRowsSerialized} returns. */
export type SelectedStoreRows = {
  revision: number;
  /** `document` when the store is held whole: no rows exist to select. */
  mode: "rows" | "document";
  /**
   * The envelope (or whole) document at the same revision; `undefined` when
   * the caller said it already knows the document at this revision.
   */
  document: string | null | undefined;
  /** Selected rows in stored order, serialized and unparsed. */
  rows: Array<{ key: string; value: string }>;
};

/**
 * A store's revision and representation, and its document unless the store
 * is held as rows at `documentKnownAt`: an envelope's document holds every
 * field outside its collections (the agent mail store's inject queue among
 * them), so a reader that already checked it at this revision need not copy
 * it out again. `null` when the store does not exist.
 */
export function readSelectionHeader(
  db: Database,
  store: string,
  documentKnownAt: number | undefined,
): Pick<SelectedStoreRows, "revision" | "mode" | "document"> | null {
  const header = db.query("SELECT revision, mode FROM stores WHERE name = ?").get(store) as {
    revision: number;
    mode: "rows" | "document";
  } | null;
  if (!header) return null;
  if (header.mode === "rows" && header.revision === documentKnownAt) {
    return { ...header, document: undefined };
  }
  const { document } = db.query("SELECT document FROM stores WHERE name = ?").get(store) as {
    document: string | null;
  };
  return { ...header, document };
}

/**
 * The selected rows of `collection`, from `cached` (this connection's rows at
 * the committed revision) when given, otherwise from SQLite. A prefix is
 * always answered by an index range on the primary key, never by walking the
 * cache, so its cost is the matching rows, not the store. `fetched` is the
 * serialized length read from SQLite. Run inside the caller's read snapshot.
 */
export function selectSerializedRows(
  db: Database,
  store: string,
  collection: string,
  selection: RowSelection,
  cached: ReadonlyMap<string, StoreRow> | null,
): { rows: SelectedStoreRows["rows"]; fetched: number } {
  if ("keyPrefix" in selection) {
    const prefix = selection.keyPrefix;
    if (!prefix.endsWith("\0")) throw new Error("A key prefix must end in NUL");
    const range = [store, collection, prefix, `${prefix.slice(0, -1)}\u0001`] as const;
    const where = "WHERE store = ? AND collection = ? AND key >= ? AND key < ?";
    if (!cached) {
      const rows = db
        .query(`SELECT key, value FROM store_rows ${where} ORDER BY position, key`)
        .all(...range) as Array<{ key: string; value: string }>;
      return { rows, fetched: rows.reduce((length, row) => length + row.value.length, 0) };
    }
    // Keys only: the values come from the cache without being copied again.
    const keys = (
      db.query(`SELECT key FROM store_rows ${where}`).all(...range) as Array<{
        key: string;
      }>
    ).map((row) => row.key);
    return selectSerializedRows(db, store, collection, { keys }, cached);
  }
  const found: Array<StoreRow | { key: string; value: string; position: number }> = [];
  let fetched = 0;
  const select = cached
    ? null
    : db.query(
        "SELECT key, value, position FROM store_rows WHERE store = ? AND collection = ? AND key = ?",
      );
  for (const key of new Set(selection.keys)) {
    const row = cached
      ? cached.get(rowId(collection, key))
      : (select!.get(store, collection, key) as {
          key: string;
          value: string;
          position: number;
        } | null);
    if (!row) continue;
    if (!cached) fetched += row.value.length;
    found.push(row);
  }
  found.sort((a, b) => a.position - b.position);
  return { rows: found.map(({ key, value }) => ({ key, value })), fetched };
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

/**
 * Additive quota metadata. SQLite maintains it even for writes from older
 * builds. Track only stores that opt into a byte limit. Use SQL available on
 * every supported SQLite, since other connections also run the triggers.
 */
export function ensureRowByteTotals(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name = 'store_row_byte_totals'").get()) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS store_row_byte_totals (
        store TEXT PRIMARY KEY, bytes INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE TRIGGER IF NOT EXISTS store_row_bytes_insert AFTER INSERT ON store_rows
      BEGIN
        UPDATE store_row_byte_totals SET bytes = bytes + length(CAST(new.value AS BLOB))
          WHERE store = new.store;
      END;
      CREATE TRIGGER IF NOT EXISTS store_row_bytes_update AFTER UPDATE OF value ON store_rows
      BEGIN
        UPDATE store_row_byte_totals
          SET bytes = bytes + length(CAST(new.value AS BLOB)) - length(CAST(old.value AS BLOB))
          WHERE store = new.store;
      END;
      CREATE TRIGGER IF NOT EXISTS store_row_bytes_delete AFTER DELETE ON store_rows
      BEGIN
        UPDATE store_row_byte_totals SET bytes = bytes - length(CAST(old.value AS BLOB))
          WHERE store = old.store;
      END;
      CREATE TRIGGER IF NOT EXISTS store_row_bytes_forget AFTER DELETE ON stores
      BEGIN
        DELETE FROM store_row_byte_totals WHERE store = old.name;
      END;
    `);
  }).immediate();
}

export function trackedRowBytes(db: Database, store: string): number | undefined {
  return (
    db.query("SELECT bytes FROM store_row_byte_totals WHERE store = ?").get(store) as {
      bytes: number;
    } | null
  )?.bytes;
}

/** One-time backfill of a store already on disk, inside the caller's write transaction. */
export function initializeRowBytes(db: Database, store: string): number {
  const { bytes } = db
    .query(
      `
    INSERT INTO store_row_byte_totals (store, bytes)
    SELECT ?, coalesce(sum(${rowBytesExpression(db)}), 0) FROM store_rows WHERE store = ?
    RETURNING bytes
  `,
    )
    .get(store, store) as { bytes: number };
  return bytes;
}

/** Owner-only modes on the database's WAL, SHM and journal files. */
export function restrictCompanionFiles(databasePath: string): void {
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

/**
 * On-disk format of the backend's SQLite database (`orkestrator.sqlite` in the
 * data directory), shared by the backend and the Bun scripts that read it.
 *
 * Each store is one `stores` row plus, for row layouts, its `store_rows`. The
 * row records its own layout, so a reader needs no registry to rebuild the
 * JSON value a store holds:
 *
 * - `document`: `stores.document` is the whole value.
 * - `array`: rows ordered by position form the array.
 * - `record`: rows ordered by position, keyed by `key`, form the object.
 * - `envelope`: `stores.document` is the object; each field holding
 *   {@link STORAGE_COLLECTION_MARKER} is a collection rebuilt from the rows
 *   whose `collection` names it.
 *
 * `bun:sqlite` is loaded through `runtimeRequire` so importing this module
 * never pulls a Bun builtin into the Electron (Node) bundle.
 */

export const STORAGE_DATABASE_FILE = "orkestrator.sqlite";

/** Placeholder an envelope document keeps where a collection field sits. */
export const STORAGE_COLLECTION_MARKER = "\u0000collection";

export type StoredLayoutKind = "document" | "array" | "record" | "envelope";

export interface StoredStoreHeader {
  layout: StoredLayoutKind;
  mode: "rows" | "document";
  document: string | null;
}

export interface StoredRow {
  collection: string;
  key: string;
  position: number;
  value: string;
}

/**
 * Rebuilds a store's JSON value from its header and rows. Throws `SyntaxError`
 * for a value that is not valid JSON.
 */
export function assembleStoredValue(header: StoredStoreHeader, rows: Iterable<StoredRow>): unknown {
  if (header.mode === "document") {
    return header.document === null ? null : (JSON.parse(header.document) as unknown);
  }
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  if (header.layout === "array") {
    return ordered.map((row) => JSON.parse(row.value) as unknown);
  }
  if (header.layout === "record") {
    const value: Record<string, unknown> = {};
    for (const row of ordered) value[row.key] = JSON.parse(row.value) as unknown;
    return value;
  }
  if (header.layout === "envelope") {
    const envelope =
      header.document === null ? {} : (JSON.parse(header.document) as Record<string, unknown>);
    for (const [field, fieldValue] of Object.entries(envelope)) {
      if (fieldValue === STORAGE_COLLECTION_MARKER) envelope[field] = {};
    }
    for (const row of ordered) {
      const target = envelope[row.collection];
      const records =
        target && typeof target === "object" && !Array.isArray(target)
          ? (target as Record<string, unknown>)
          : (envelope[row.collection] = {} as Record<string, unknown>);
      records[row.key] = JSON.parse(row.value) as unknown;
    }
    return envelope;
  }
  throw new SyntaxError(`Unknown stored layout ${String(header.layout)}`);
}

/**
 * Reads one store from a data directory's database without writing to it and
 * without running migrations. Returns `undefined` when the database or the
 * store does not exist, or the value cannot be read.
 */
export function readStorageDatabaseStore(
  dataDir: string,
  store: string,
  runtimeRequire: NodeJS.Require = require,
): unknown {
  const { Database } = runtimeRequire("bun:sqlite") as typeof import("bun:sqlite");
  const fs = runtimeRequire("node:fs") as typeof import("node:fs");
  const path = runtimeRequire("node:path") as typeof import("node:path");
  const file = path.join(dataDir, STORAGE_DATABASE_FILE);
  if (!fs.existsSync(file)) return undefined;
  let db: import("bun:sqlite").Database | undefined;
  try {
    db = new Database(file, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const header = db
      .query("SELECT layout, mode, document FROM stores WHERE name = ?")
      .get(store) as StoredStoreHeader | null;
    if (!header) return undefined;
    const rows =
      header.mode === "rows"
        ? (db
            .query("SELECT collection, key, position, value FROM store_rows WHERE store = ?")
            .all(store) as StoredRow[])
        : [];
    return assembleStoredValue(header, rows);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

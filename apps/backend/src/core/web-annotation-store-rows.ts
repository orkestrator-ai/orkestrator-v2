/**
 * Row codec and SQL helpers of the per-environment web-annotation store
 * (`web-annotations/<environmentId>`, layout in `web-annotation-store-layout.ts`).
 *
 * The service works on one in-memory `WebAnnotationManifest`. A commit diffs
 * the mutated manifest against the committed rows and writes only the rows
 * whose JSON or position changed, so a commit costs O(changed rows) of I/O.
 * The diff still serializes every index row (the same CPU the old engine
 * spent serializing the whole manifest per commit).
 *
 * Rows are read and written through the database's uncached row access
 * (`StorageDatabase.rows`), writes inside `StorageDatabase.transaction`; each
 * committing transaction moves the store revision once. The generic store
 * cache is not used for these stores: it would hold (and reload on every
 * foreign commit) the immutable record bodies, up to the 32 MiB metadata quota
 * per environment. Index rows are reloaded here instead, skipping the
 * `records` collection; record bodies are read one row at a time.
 */
import type { WebAnnotationStorageStatus } from "@orkestrator/protocol/web-annotations";
import type { StorageDatabase } from "./storage-database.js";
import {
  WEB_ANNOTATION_INDEX_COLLECTIONS,
  WEB_ANNOTATION_RECORDS_COLLECTION,
} from "./web-annotation-store-layout.js";
import {
  emptyManifest,
  type ManifestEntry,
  type ManifestMigration,
  type WebAnnotationManifest,
  type WebAnnotationRecordKind,
} from "./web-annotation-storage-format.js";

export const WEB_ANNOTATION_STORE_FORMAT = "orkestrator-web-annotation-store";
/** Row format version of the store; a newer one is refused, never rewritten. */
export const WEB_ANNOTATION_STORE_VERSION = 1;

export interface WebAnnotationStoreMeta {
  format: typeof WEB_ANNOTATION_STORE_FORMAT;
  version: number;
  environmentId: string;
  createdAt: string;
  updatedAt: string;
  /** Environment revision: advances on every listing commit (not drafts). */
  revision: number;
  /** Bytes of the `records` rows (row JSON length). */
  recordBytes: number;
  /** `degraded` only for an environment imported from a previous manifest copy. */
  status: "ready" | "degraded";
  reason?: string;
  draftsStatus: WebAnnotationStorageStatus;
  source: "new" | "legacy-v1" | "legacy-v2";
  importedAt?: string;
  /** The legacy files were left in place (an imperfect import): never archive them. */
  legacyRetained?: boolean;
}

/** A record the legacy import found missing or damaged. */
export interface UnreadableRecord {
  kind: WebAnnotationRecordKind;
  state: "missing" | "unreadable";
  /** For `request-text`: the request whose instruction was lost. */
  requestId?: string;
}

export interface IndexRow {
  collection: string;
  key: string;
  position: number;
  json: string;
  bytes: number;
}

/** Committed state of one environment as seen by this process. */
export interface StoreSnapshot {
  /** `stores.revision` this snapshot reflects; `null` while the store does not exist. */
  storeRevision: number | null;
  manifest: WebAnnotationManifest;
  meta: WebAnnotationStoreMeta;
  unreadable: Map<string, UnreadableRecord>;
  rows: Map<string, IndexRow>;
  /** Parsed value of every row (shared with `manifest`; never mutated). */
  values: Map<string, unknown>;
  indexBytes: number;
  maxPosition: number;
}

export function rowId(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

export function recordKey(id: string, revision: number): string {
  return `${id}/${revision}`;
}

export function defaultMeta(environmentId: string, now: string): WebAnnotationStoreMeta {
  return {
    format: WEB_ANNOTATION_STORE_FORMAT,
    version: WEB_ANNOTATION_STORE_VERSION,
    environmentId,
    createdAt: now,
    updatedAt: now,
    revision: 0,
    recordBytes: 0,
    status: "ready",
    draftsStatus: "ready",
    source: "new",
  };
}

export function emptySnapshot(environmentId: string, now: string): StoreSnapshot {
  const meta = defaultMeta(environmentId, now);
  return {
    storeRevision: null,
    manifest: emptyManifest(environmentId, now),
    meta,
    unreadable: new Map(),
    rows: new Map(),
    values: new Map(),
    indexBytes: 0,
    maxPosition: -1,
  };
}

// ---------------------------------------------------------------------------
// Manifest <-> rows

interface RowItem {
  collection: string;
  key: string;
  value: unknown;
  /** Rows of one group keep their relative order through row positions. */
  group?: string;
}

/** Every index row of a manifest (and its storage metadata), in manifest order. */
function* manifestRows(
  manifest: WebAnnotationManifest,
  meta: WebAnnotationStoreMeta,
  unreadable: ReadonlyMap<string, UnreadableRecord>,
  scope: ReadonlySet<string> | null,
): Generator<RowItem> {
  const want = (collection: string) => !scope || scope.has(collection);
  if (want("meta")) {
    yield { collection: "meta", key: "state", value: meta };
    yield { collection: "meta", key: "migration", value: manifest.migration };
  }
  const simple: Array<[string, Record<string, unknown>]> = [
    ["annotations", manifest.annotations],
    ["changed", manifest.changedAt],
    ["captures", manifest.captures],
    ["requests", manifest.requests],
    ["results", manifest.results],
    ["assets", manifest.assets],
    ["drafts", manifest.drafts],
  ];
  for (const [collection, values] of simple) {
    if (!want(collection)) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) yield { collection, key, value };
    }
  }
  if (want("entries")) {
    for (const [annotationId, list] of Object.entries(manifest.entries)) {
      for (const entry of list) {
        yield {
          collection: "entries",
          key: entry.id,
          value: entry,
          group: `e\u0000${annotationId}`,
        };
      }
    }
  }
  if (want("receipts")) {
    const seen = new Set<string>();
    for (const receipt of manifest.receipts) {
      // Lookups return the first receipt of an operation id; later copies are unreachable.
      if (seen.has(receipt.operationId)) continue;
      seen.add(receipt.operationId);
      yield { collection: "receipts", key: receipt.operationId, value: receipt, group: "receipts" };
    }
  }
  if (want("unreadable")) {
    for (const [key, value] of unreadable) yield { collection: "unreadable", key, value };
  }
}

export interface RowPlan {
  upserts: IndexRow[];
  deletes: IndexRow[];
  rows: Map<string, IndexRow>;
  values: Map<string, unknown>;
  indexBytes: number;
  maxPosition: number;
  /** Keys of changed rows per collection (change hints for foreign commits). */
  changedKeys: Map<string, Set<string>>;
}

/**
 * Diff `manifest` against the committed rows. `scope` limits the diff to some
 * collections; rows of the others are carried over untouched. Surviving rows
 * keep their positions while their group's order is append-only, so adding or
 * removing one item never renumbers the rest.
 */
export function planRows(
  previous: Pick<StoreSnapshot, "rows" | "values" | "maxPosition">,
  manifest: WebAnnotationManifest,
  meta: WebAnnotationStoreMeta,
  unreadable: ReadonlyMap<string, UnreadableRecord>,
  scope: ReadonlySet<string> | null = null,
): RowPlan {
  let max = previous.maxPosition;
  const items: Array<RowItem & { id: string; json: string; before: IndexRow | undefined }> = [];
  const groups = new Map<string, number[]>();
  for (const item of manifestRows(manifest, meta, unreadable, scope)) {
    const id = rowId(item.collection, item.key);
    const json = JSON.stringify(item.value);
    if (json === undefined) continue;
    items.push({ ...item, id, json, before: previous.rows.get(id) });
    if (item.group) {
      const members = groups.get(item.group) ?? [];
      members.push(items.length - 1);
      groups.set(item.group, members);
    }
  }
  /** Positions decided for grouped items, by item index. */
  const positions = new Map<number, number>();
  for (const members of groups.values()) {
    let last = -Infinity;
    let sawNew = false;
    let appendOnly = true;
    for (const index of members) {
      const before = items[index]!.before;
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
    for (const index of members) {
      const before = items[index]!.before;
      positions.set(index, appendOnly && before ? before.position : ++max);
    }
  }
  const rows = new Map<string, IndexRow>();
  const values = new Map<string, unknown>();
  const upserts: IndexRow[] = [];
  const changedKeys = new Map<string, Set<string>>();
  const noteChange = (collection: string, key: string) => {
    let keys = changedKeys.get(collection);
    if (!keys) changedKeys.set(collection, (keys = new Set()));
    keys.add(key);
  };
  let indexBytes = 0;
  for (const [index, item] of items.entries()) {
    if (rows.has(item.id)) continue;
    const position = positions.get(index) ?? item.before?.position ?? ++max;
    const unchanged = item.before && item.before.json === item.json;
    const row: IndexRow =
      unchanged && item.before!.position === position
        ? item.before!
        : {
            collection: item.collection,
            key: item.key,
            position,
            json: item.json,
            bytes: unchanged ? item.before!.bytes : Buffer.byteLength(item.json, "utf8"),
          };
    if (row !== item.before) {
      upserts.push(row);
      if (!unchanged) noteChange(item.collection, item.key);
    }
    rows.set(item.id, row);
    values.set(item.id, item.value);
    indexBytes += row.bytes;
  }
  const deletes: IndexRow[] = [];
  for (const [id, row] of previous.rows) {
    if (rows.has(id)) continue;
    if (scope && !scope.has(row.collection)) {
      rows.set(id, row);
      values.set(id, previous.values.get(id));
      indexBytes += row.bytes;
      continue;
    }
    deletes.push(row);
    noteChange(row.collection, row.key);
  }
  return { upserts, deletes, rows, values, indexBytes, maxPosition: max, changedKeys };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultMigration(): ManifestMigration {
  return { imports: {}, drafts: {}, completedAt: null };
}

/**
 * Rebuild the manifest from index rows. `previous` lends the parsed objects
 * of rows whose JSON did not change. Throws `SyntaxError` on a damaged row.
 */
export function assembleSnapshot(
  environmentId: string,
  storeRevision: number,
  fetched: Iterable<{ collection: string; key: string; position: number; value: string }>,
  previous: StoreSnapshot | null,
  now: string,
): StoreSnapshot {
  const rows = new Map<string, IndexRow>();
  const values = new Map<string, unknown>();
  let indexBytes = 0;
  let maxPosition = -1;
  for (const raw of fetched) {
    const id = rowId(raw.collection, raw.key);
    const before = previous?.rows.get(id);
    const reuse = before && before.json === raw.value;
    const row: IndexRow =
      reuse && before.position === raw.position
        ? before
        : {
            collection: raw.collection,
            key: raw.key,
            position: raw.position,
            json: raw.value,
            bytes: reuse ? before.bytes : Buffer.byteLength(raw.value, "utf8"),
          };
    rows.set(id, row);
    values.set(id, reuse ? previous!.values.get(id) : (JSON.parse(raw.value) as unknown));
    indexBytes += row.bytes;
    if (row.position > maxPosition) maxPosition = row.position;
  }
  const ordered = Array.from(rows.entries()).sort((a, b) => a[1].position - b[1].position);
  const metaValue = values.get(rowId("meta", "state"));
  const meta: WebAnnotationStoreMeta = isRecordValue(metaValue)
    ? (metaValue as unknown as WebAnnotationStoreMeta)
    : defaultMeta(environmentId, now);
  const manifest = emptyManifest(environmentId, meta.createdAt);
  manifest.revision = meta.revision;
  manifest.updatedAt = meta.updatedAt;
  manifest.usage = { recordBytes: meta.recordBytes };
  const migration = values.get(rowId("meta", "migration"));
  manifest.migration = isRecordValue(migration)
    ? (migration as unknown as ManifestMigration)
    : defaultMigration();
  const unreadable = new Map<string, UnreadableRecord>();
  const targets: Record<string, Record<string, unknown> | undefined> = {
    annotations: manifest.annotations,
    changed: manifest.changedAt,
    captures: manifest.captures,
    requests: manifest.requests,
    results: manifest.results,
    assets: manifest.assets,
    drafts: manifest.drafts,
  };
  for (const [id, row] of ordered) {
    const value = values.get(id);
    const target = targets[row.collection];
    if (target) {
      target[row.key] = value;
    } else if (row.collection === "entries") {
      const entry = value as ManifestEntry;
      (manifest.entries[entry.annotationId] ??= []).push(entry);
    } else if (row.collection === "receipts") {
      manifest.receipts.push(value as WebAnnotationManifest["receipts"][number]);
    } else if (row.collection === "unreadable") {
      unreadable.set(row.key, value as UnreadableRecord);
    }
  }
  return {
    storeRevision,
    manifest,
    meta,
    unreadable,
    rows,
    values,
    indexBytes,
    maxPosition,
  };
}

// ---------------------------------------------------------------------------
// Row access. Writers hold a `StorageDatabase.transaction`.

type FetchedRow = { collection: string; key: string; position: number; value: string };

/** Attempts at a lock-free consistent read before taking the write lock. */
const CONSISTENT_READ_ATTEMPTS = 3;

function readIndexRowsOnce(database: StorageDatabase, store: string): FetchedRow[] {
  const rows = database.rows(store);
  const fetched: FetchedRow[] = [];
  for (const collection of WEB_ANNOTATION_INDEX_COLLECTIONS) {
    for (const entry of rows.list({ collection })) {
      fetched.push({
        collection: entry.collection,
        key: entry.key,
        position: entry.position,
        value: entry.value!,
      });
    }
  }
  return fetched;
}

/**
 * Every index row of a store with the revision they reflect, or `null` when
 * the store does not exist. One listing per collection: the reads are
 * bracketed by two revision reads and retried until no commit landed between
 * them (revisions only increase, and every row write moves the revision), so
 * the rows are one committed state without holding the write lock. After a
 * few lost races (a busy writer) the read takes the write lock instead.
 * Inside an open transaction the bracket always holds.
 */
export function readIndexSnapshot(
  database: StorageDatabase,
  store: string,
): { revision: number; rows: FetchedRow[] } | null {
  for (let attempt = 0; attempt < CONSISTENT_READ_ATTEMPTS; attempt += 1) {
    const before = database.storeRevision(store);
    if (before === null) return null;
    const rows = readIndexRowsOnce(database, store);
    if (database.storeRevision(store) === before) return { revision: before, rows };
  }
  return database.transaction(() => {
    const revision = database.storeRevision(store);
    return revision === null ? null : { revision, rows: readIndexRowsOnce(database, store) };
  });
}

export function readMetaRow(database: StorageDatabase, store: string): string | null {
  return database.rows(store).get("state", "meta") ?? null;
}

export function readRecordRow(
  database: StorageDatabase,
  store: string,
  key: string,
): string | null {
  return database.rows(store).get(key, WEB_ANNOTATION_RECORDS_COLLECTION) ?? null;
}

export function hasAssetRow(database: StorageDatabase, store: string, assetId: string): boolean {
  return database.rows(store).has(assetId, "assets");
}

export function writeIndexRows(
  database: StorageDatabase,
  store: string,
  upserts: readonly IndexRow[],
  deletes: readonly IndexRow[],
): void {
  const rows = database.rows(store);
  for (const row of deletes) rows.delete(row.key, row.collection);
  for (const row of upserts) {
    rows.put(row.key, row.json, { collection: row.collection, position: row.position });
  }
}

export function writeRecordRows(
  database: StorageDatabase,
  store: string,
  records: ReadonlyArray<{ key: string; json: string }>,
): void {
  const rows = database.rows(store);
  for (const record of records) {
    // Record bodies are keyed lookups only; their position is never read.
    rows.put(record.key, record.json, {
      collection: WEB_ANNOTATION_RECORDS_COLLECTION,
      position: 0,
    });
  }
}

/** Deletes record rows; returns the bytes they held. */
export function deleteRecordRows(
  database: StorageDatabase,
  store: string,
  keys: Iterable<string>,
): number {
  const rows = database.rows(store);
  let freed = 0;
  for (const key of new Set(keys)) {
    const value = rows.get(key, WEB_ANNOTATION_RECORDS_COLLECTION);
    if (value === undefined) continue;
    freed += Buffer.byteLength(value, "utf8");
    rows.delete(key, WEB_ANNOTATION_RECORDS_COLLECTION);
  }
  return freed;
}

/** Removes every row of a store (an interrupted import's record rows). */
export function deleteAllRows(database: StorageDatabase, store: string): void {
  database.rows(store).deleteWhere({});
}

/**
 * The store revision after this transaction's row writes (each committing
 * transaction that writes moves it exactly once; revisions never repeat,
 * even for a deleted and recreated store). `null` when nothing was written
 * to a store that does not exist.
 */
export function committedStoreRevision(database: StorageDatabase, store: string): number | null {
  return database.storeRevision(store);
}

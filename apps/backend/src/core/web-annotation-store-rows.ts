/**
 * Row codec and SQL helpers of the per-environment web-annotation store
 * (`web-annotations/<environmentId>`, layout in `web-annotation-store-layout.ts`).
 *
 * The service works on one in-memory `WebAnnotationManifest`. Its committed
 * row values are deep-frozen (`freezeRowValue`), so an unchanged reference is
 * an unchanged row. A manifest commit plans only the rows its working copy
 * replaced (`planChangedRows`), serializes those, and writes the ones whose
 * JSON or position changed: O(changed rows) of CPU and I/O. `planRows`, the
 * full diff, serves the one-off legacy import and repair, and checks every
 * incremental plan in tests (`assertSameRowPlan`).
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
  /** Parsed value of every row (shared with `manifest`; deep-frozen). */
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
  const meta = freezeRowValue(defaultMeta(environmentId, now));
  return {
    storeRevision: null,
    manifest: freezeRowValue(emptyManifest(environmentId, now)),
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
  /** Row values this plan serialized with `JSON.stringify` (the commit's CPU bound). */
  serialized: number;
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
  return {
    upserts,
    deletes,
    rows,
    values,
    indexBytes,
    maxPosition: max,
    changedKeys,
    serialized: items.length,
  };
}

/** Freezes a row value and everything it holds; already-frozen parts are skipped. */
export function freezeRowValue<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeRowValue(child);
  return value;
}

/** One ungrouped row a commit replaced; `undefined` removes it. */
export interface RowChange {
  collection: string;
  key: string;
  value: unknown;
}

/** A group (one annotation's entries, the receipts) whose member list changed. */
export interface GroupChange {
  group: string;
  /** The new members in order, without duplicate ids. */
  members: RowChange[];
  /** The committed members, for removals. */
  previous: Array<{ collection: string; key: string }>;
}

export interface RowChanges {
  rows: RowChange[];
  groups: GroupChange[];
}

/**
 * Plan only the rows a commit declared. Equivalent to `planRows` over the
 * whole next manifest provided every row not listed in `changes` is
 * unchanged, which frozen committed values guarantee. A listed value that is
 * still the committed object is not serialized; the rest are serialized
 * once and written only when their JSON or position changed. Group
 * positions follow the same append-only rule as `planRows`. The row maps are
 * copied (O(rows) of pointer copies, no serialization) so the previous
 * snapshot stays intact if the transaction rolls back.
 */
export function planChangedRows(
  previous: Pick<StoreSnapshot, "rows" | "values" | "maxPosition" | "indexBytes">,
  changes: RowChanges,
): RowPlan {
  const rows = new Map(previous.rows);
  const values = new Map(previous.values);
  const upserts = new Map<string, IndexRow>();
  const deletes = new Map<string, IndexRow>();
  const changedKeys = new Map<string, Set<string>>();
  const noteChange = (collection: string, key: string) => {
    let keys = changedKeys.get(collection);
    if (!keys) changedKeys.set(collection, (keys = new Set()));
    keys.add(key);
  };
  let max = previous.maxPosition;
  let indexBytes = previous.indexBytes;
  let serialized = 0;
  const remove = (id: string) => {
    const current = rows.get(id);
    if (!current) return;
    rows.delete(id);
    values.delete(id);
    upserts.delete(id);
    indexBytes -= current.bytes;
    const committed = previous.rows.get(id);
    if (committed) {
      deletes.set(id, committed);
      noteChange(committed.collection, committed.key);
    }
  };
  const put = (change: RowChange, position?: number) => {
    const id = rowId(change.collection, change.key);
    if (change.value === undefined) return remove(id);
    const before = rows.get(id);
    if (
      before &&
      previous.values.get(id) === change.value &&
      (position === undefined || position === before.position)
    ) {
      return;
    }
    const json = JSON.stringify(change.value);
    serialized += 1;
    if (json === undefined) return remove(id);
    const at = position ?? before?.position ?? ++max;
    const unchanged = before !== undefined && before.json === json;
    values.set(id, change.value);
    if (unchanged && before.position === at) return;
    const row: IndexRow = {
      collection: change.collection,
      key: change.key,
      position: at,
      json,
      bytes: unchanged ? before.bytes : Buffer.byteLength(json, "utf8"),
    };
    indexBytes += row.bytes - (before?.bytes ?? 0);
    rows.set(id, row);
    upserts.set(id, row);
    deletes.delete(id);
    if (!unchanged) noteChange(change.collection, change.key);
  };
  for (const change of changes.rows) put(change);
  for (const group of changes.groups) {
    let last = -Infinity;
    let sawNew = false;
    let appendOnly = true;
    for (const member of group.members) {
      const before = previous.rows.get(rowId(member.collection, member.key));
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
    const kept = new Set<string>();
    for (const member of group.members) {
      const id = rowId(member.collection, member.key);
      kept.add(id);
      const before = previous.rows.get(id);
      put(member, appendOnly && before ? before.position : ++max);
    }
    for (const member of group.previous) {
      const id = rowId(member.collection, member.key);
      if (!kept.has(id)) remove(id);
    }
  }
  return {
    upserts: Array.from(upserts.values()),
    deletes: Array.from(deletes.values()),
    rows,
    values,
    indexBytes,
    maxPosition: max,
    changedKeys,
    serialized,
  };
}

/** Row position order inside each group, for comparing two plans. */
function groupOrders(rows: ReadonlyMap<string, IndexRow>): Map<string, string[]> {
  const orders = new Map<string, Array<{ id: string; position: number }>>();
  for (const [id, row] of rows) {
    if (row.collection !== "entries" && row.collection !== "receipts") continue;
    const group =
      row.collection === "receipts"
        ? "receipts"
        : `e\u0000${(JSON.parse(row.json) as { annotationId?: string }).annotationId}`;
    const members = orders.get(group) ?? [];
    members.push({ id, position: row.position });
    orders.set(group, members);
  }
  return new Map(
    Array.from(orders, ([group, members]) => [
      group,
      members.sort((a, b) => a.position - b.position).map((member) => member.id),
    ]),
  );
}

/**
 * Debug check that an incremental plan persists exactly what the full diff
 * would: the same rows with the same JSON, the same deletions, and the same
 * order inside every group (new positions may be numbered differently).
 * Throws on a difference, so the commit rolls back.
 */
export function assertSameRowPlan(full: RowPlan, incremental: RowPlan): void {
  const problems: string[] = [];
  const describe = (id: string) => id.replace("\u0000", "/");
  for (const [id, row] of full.rows) {
    const other = incremental.rows.get(id);
    if (!other) problems.push(`missing ${describe(id)}`);
    else if (other.json !== row.json) problems.push(`stale ${describe(id)}`);
  }
  for (const id of incremental.rows.keys()) {
    if (!full.rows.has(id)) problems.push(`extra ${describe(id)}`);
  }
  const fullDeletes = new Set(full.deletes.map((row) => rowId(row.collection, row.key)));
  const incrementalDeletes = new Set(
    incremental.deletes.map((row) => rowId(row.collection, row.key)),
  );
  for (const id of fullDeletes) {
    if (!incrementalDeletes.has(id)) problems.push(`undeleted ${describe(id)}`);
  }
  for (const id of incrementalDeletes) {
    if (!fullDeletes.has(id)) problems.push(`wrongly deleted ${describe(id)}`);
  }
  if (problems.length === 0) {
    const expected = groupOrders(full.rows);
    for (const [group, order] of groupOrders(incremental.rows)) {
      if (expected.get(group)?.join("\n") !== order.join("\n")) {
        problems.push(`reordered ${describe(group)}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `web annotation row plan diverges from the full diff: ${problems.slice(0, 5).join(", ")}`,
    );
  }
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
    values.set(
      id,
      reuse ? previous!.values.get(id) : freezeRowValue(JSON.parse(raw.value) as unknown),
    );
    indexBytes += row.bytes;
    if (row.position > maxPosition) maxPosition = row.position;
  }
  const ordered = Array.from(rows.entries()).sort((a, b) => a[1].position - b[1].position);
  const metaValue = values.get(rowId("meta", "state"));
  const meta: WebAnnotationStoreMeta = isRecordValue(metaValue)
    ? (metaValue as unknown as WebAnnotationStoreMeta)
    : freezeRowValue(defaultMeta(environmentId, now));
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
  // Row values are frozen as they are parsed; this freezes the containers.
  freezeRowValue(manifest);
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

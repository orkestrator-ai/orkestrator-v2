import { STORAGE_COLLECTION_MARKER } from "@orkestrator/protocol/node/storage-database";
import type { RowUpdate, StoreLayout, StoreRowEntry } from "./storage-database.js";

/**
 * Pure helpers of {@link StorageDatabase}'s row layouts: how a value splits into
 * rows, how row ids and positions are formed, and how a row update applies to
 * an array held whole. Nothing here touches SQLite.
 */

/** One serialized row of a store held as rows. */
export type StoreRow = { collection: string; key: string; position: number; value: string };

/** A value split by its layout: rows plus the envelope (or whole) document. */
export type DecomposedStore = {
  mode: "rows" | "document";
  document: string | null;
  rows: Map<string, StoreRow>;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same mode, document and rows: persisting would only bump the revision. */
export function isUnchanged(
  previous: Pick<DecomposedStore, "mode" | "document"> & { rows: Map<string, StoreRow> },
  next: DecomposedStore,
): boolean {
  if (previous.mode !== next.mode || previous.document !== next.document) return false;
  if (previous.rows.size !== next.rows.size) return false;
  for (const [id, row] of next.rows) {
    const before = previous.rows.get(id);
    if (!before || before.value !== row.value || before.position !== row.position) return false;
  }
  return true;
}

/** `ORDER BY collection, position, key`; a position is unique within its collection. */
export function compareRowEntries(left: StoreRowEntry, right: StoreRowEntry): number {
  if (left.collection !== right.collection) return left.collection < right.collection ? -1 : 1;
  if (left.position !== right.position) return left.position - right.position;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

export function rowId(collection: string, key: string): string {
  return `${collection}\u0000${key}`;
}

type ArrayStoreLayout = Extract<StoreLayout, { kind: "array" }>;

export function assertArrayRowKey(
  store: string,
  layout: ArrayStoreLayout,
  key: string,
  value: unknown,
): void {
  const field = layout.key ?? "id";
  if (!key || !isPlainRecord(value) || value[field] !== key) {
    throw new Error(`Array store ${store} row ${field} must equal its non-blank key`);
  }
}

/**
 * {@link StorageDatabase.updateStoreRow} on an array value that is held whole,
 * in place: the first item carrying `key` is the row, and a delete removes
 * every item carrying it, since a value held whole may repeat a key.
 */
export function applyArrayRowUpdate<T>(
  store: string,
  layout: ArrayStoreLayout,
  items: unknown[],
  key: string,
  mutate: (current: unknown) => RowUpdate<T>,
): { result: T; changed: boolean } {
  const field = layout.key ?? "id";
  const matches = (item: unknown) => isPlainRecord(item) && item[field] === key;
  const index = items.findIndex(matches);
  const update = mutate(index < 0 ? undefined : items[index]);
  if (update.delete) {
    if (index < 0) return { result: update.result, changed: false };
    for (let at = items.length - 1; at >= index; at -= 1) {
      if (matches(items[at])) items.splice(at, 1);
    }
    return { result: update.result, changed: true };
  }
  if (!("value" in update)) return { result: update.result, changed: false };
  assertArrayRowKey(store, layout, key, update.value);
  if (index < 0) items.push(update.value);
  else items[index] = update.value;
  return { result: update.result, changed: true };
}

/**
 * Keeps the stored positions of surviving rows when their relative order is
 * unchanged and new rows only append, so removing or adding one item writes
 * one row instead of renumbering every row after it. Any other reorder keeps
 * the dense positions {@link decompose} assigned.
 */
export function stabilizePositions(
  next: Map<string, StoreRow>,
  previous: Map<string, StoreRow>,
): void {
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

export function decompose(layout: StoreLayout, value: unknown): DecomposedStore {
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

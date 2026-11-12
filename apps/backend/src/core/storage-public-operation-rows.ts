import { namespaceOfOperationId } from "./public-api/operation-ledger.js";
import type { StorageMigration, StoreLayout } from "./storage-database.js";

/**
 * Public operation namespaces (`public-operations/ns-…`) hold one row per
 * operation record, keyed by its `operationId`, in admission order.
 *
 * Until schema version 9 a namespace was one document, `{ version: 1,
 * namespace, operations: [...] }`, that every admission and every state change
 * parsed, re-validated and rewrote whole: a namespace takes admissions for
 * seven days, so the cost of each update grew with every operation in that
 * window. On a busy run that was 16 to 20 MiB of WAL a minute, each write a
 * FULL-synced commit on the event-loop thread (to-do 7562). A row layout makes
 * an update cost the same at the 5,000th record as at the first.
 */
export const PUBLIC_OPERATION_NAMESPACE_STORE = /^public-operations\/ns-[0-9]{13}-[a-f0-9]{8}$/;
export const PUBLIC_OPERATION_NAMESPACE_LAYOUT: StoreLayout = { kind: "record" };
export const PUBLIC_OPERATION_ROWS_VERSION = 9;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The record map a version-1 namespace document becomes, or `null` when the
 * document is not one whose records can be keyed (a duplicate, missing or
 * malformed `operationId`). Records are carried over unchanged: the reader
 * validates them exactly as it validated the document.
 *
 * Only well-formed operation ids become keys. Anything else is left in the
 * document for the reader to refuse; a key such as `__proto__` would otherwise
 * set the map's prototype instead of adding a row, and the record would vanish
 * from a namespace that then looked valid.
 */
export function namespaceDocumentRows(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !Array.isArray(value.operations)) return null;
  const rows: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const operation of value.operations) {
    if (!isPlainRecord(operation)) return null;
    const id = operation.operationId;
    if (typeof id !== "string" || namespaceOfOperationId(id) === null || Object.hasOwn(rows, id)) {
      return null;
    }
    rows[id] = operation;
  }
  return rows;
}

/**
 * A retired copy of a version-1 namespace document with the record
 * `operationId` replaced by `replace(record)` (dropped when that returns
 * `undefined`), or `undefined` when `copy` is not such a document. A copy
 * nothing changed in is returned as it was.
 *
 * The migration converts only the live store: copies in `legacy-json/` keep the
 * document layout they were archived in, so a row's cleanup cannot find its
 * record under a top-level key. Without this, content a later update removed
 * from an imported record would stay in those copies.
 */
export function mapNamespaceDocumentRecord(
  copy: unknown,
  operationId: string,
  replace: (record: Record<string, unknown>) => unknown,
): unknown {
  if (!isPlainRecord(copy) || !Array.isArray(copy.operations)) return undefined;
  let changed = false;
  const operations: unknown[] = [];
  for (const operation of copy.operations as unknown[]) {
    if (!isPlainRecord(operation) || operation.operationId !== operationId) {
      operations.push(operation);
      continue;
    }
    const next = replace(operation);
    if (next !== operation) changed = true;
    if (next !== undefined) operations.push(next);
  }
  return changed ? { ...copy, operations } : copy;
}

/**
 * Rewrites every version-1 namespace document as rows. A namespace that is
 * unreadable, or whose records cannot be keyed, is left exactly as it was: the
 * reader refuses admissions on it, as it did before, rather than this
 * migration guessing at its content.
 */
export const publicOperationRowsMigration: StorageMigration = {
  version: PUBLIC_OPERATION_ROWS_VERSION,
  name: "public-operation-rows",
  up({ database }) {
    for (const store of database.listStores("public-operations/ns-")) {
      if (!PUBLIC_OPERATION_NAMESPACE_STORE.test(store)) continue;
      const current = database.readStoreValueInTransaction(store);
      if (!current) continue;
      const rows = namespaceDocumentRows(current.value);
      if (rows) database.writeStoreInTransaction(store, rows);
    }
  },
};

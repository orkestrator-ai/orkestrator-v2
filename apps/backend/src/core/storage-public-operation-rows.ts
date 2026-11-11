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
 * document is not one whose records can be keyed (a duplicate or missing
 * `operationId`). Records are carried over unchanged: the reader validates
 * them exactly as it validated the document.
 */
export function namespaceDocumentRows(value: unknown): Record<string, unknown> | null {
  if (!isPlainRecord(value) || !Array.isArray(value.operations)) return null;
  const rows: Record<string, unknown> = {};
  for (const operation of value.operations) {
    if (!isPlainRecord(operation)) return null;
    const id = operation.operationId;
    if (typeof id !== "string" || !id || Object.hasOwn(rows, id)) return null;
    rows[id] = operation;
  }
  return rows;
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

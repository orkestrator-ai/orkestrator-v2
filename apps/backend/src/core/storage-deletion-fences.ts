import type { StorageDatabase } from "./storage-database.js";

// Content-free tombstones outlive deleted rows and are shared by every connection.
// Never retire an environment tombstone: ids are not reused.
const STORE = "storage-deletion-fences";
export function deletionFence(database: StorageDatabase): number {
  return database.storeRevision(STORE) ?? 0;
}
export function deletionMarker(database: StorageDatabase, scope: string, id: string): number {
  const stored = database.rows(STORE).get(`${scope}/${id}`);
  if (stored === undefined) return 0;
  const sequence = Number(stored);
  // A damaged tombstone cannot prove that deletion never happened.
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : Number.POSITIVE_INFINITY;
}
/** Caller holds the deleting transaction. */
export function markDeletion(database: StorageDatabase, scope: string, id: string): void {
  const rows = database.rows(STORE);
  const key = `${scope}/${id}`;
  rows.put(key, "0");
  rows.put(key, JSON.stringify(deletionFence(database)));
}

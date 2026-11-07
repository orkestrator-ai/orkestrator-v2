/**
 * Per-node persistence keys and the one-time moves that put existing data
 * under them (report §7.5, plan item 3015).
 *
 * `nodeStorageKey(baseKey, node)` is the key a store persists `node`'s state
 * under. Before it returns, it applies the migration registered for
 * `baseKey` in `PERSISTENCE_KEY_MIGRATIONS`, at most once per storage. Store
 * items add an entry here when they convert, instead of each writing its own
 * copy-once code.
 *
 * Existing data always belongs to the command node: a migration only moves
 * data into the command node's key, never into a leaf's.
 */

import { desktopConnectionStorageKey, type StorageNode } from "./desktop-storage-key";

export { COMMAND_STORAGE_NODE, type StorageNode } from "./desktop-storage-key";

export interface PersistenceKeyMigration {
  /** Keys earlier releases wrote the command node's data under, newest first. */
  readonly legacyKeys: readonly string[];
  /**
   * Delete the legacy keys once moved. Keep them only when an older client
   * still sharing this storage must keep reading them.
   */
  readonly removeLegacy: boolean;
}

/** The local copy of unsaved annotation editor text (`web-annotations/local-drafts.ts`). */
export const LOCAL_DRAFTS_STORAGE_KEY = "orkestrator.web-annotations.local-drafts.v2";

/** Base key → its migration. */
export const PERSISTENCE_KEY_MIGRATIONS: Readonly<Record<string, PersistenceKeyMigration>> =
  Object.freeze({
    // v1 had no node in its key; its drafts were the command node's.
    [LOCAL_DRAFTS_STORAGE_KEY]: {
      legacyKeys: ["orkestrator.web-annotations.local-drafts.v1"],
      removeLegacy: true,
    },
  });

function migrationMarker(baseKey: string): string {
  return `${baseKey}:node-keys-migrated-v1`;
}

function defaultStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/**
 * Moves the command node's legacy data for `baseKey` into `targetKey`, once.
 * A target that already holds data wins; the legacy copy is still retired.
 */
export function migratePersistenceKey(
  baseKey: string,
  targetKey: string,
  storage: Storage | null = defaultStorage(),
  migrations: Readonly<Record<string, PersistenceKeyMigration>> = PERSISTENCE_KEY_MIGRATIONS,
): void {
  const migration = migrations[baseKey];
  if (!migration || !storage) return;
  try {
    const marker = migrationMarker(baseKey);
    if (storage.getItem(marker) !== null) return;
    if (storage.getItem(targetKey) === null) {
      for (const legacyKey of migration.legacyKeys) {
        const value = storage.getItem(legacyKey);
        if (value === null) continue;
        storage.setItem(targetKey, value);
        break;
      }
    }
    if (migration.removeLegacy) {
      for (const legacyKey of migration.legacyKeys) storage.removeItem(legacyKey);
    }
    storage.setItem(marker, "1");
  } catch {
    // Full or unavailable storage: the key stays usable and the move is
    // retried next time.
  }
}

/** The key `node`'s state for `baseKey` lives under, after any one-time move. */
export function nodeStorageKey(baseKey: string, node: StorageNode): string {
  const key = desktopConnectionStorageKey(baseKey, node);
  if (node.role === "command") migratePersistenceKey(baseKey, key);
  return key;
}

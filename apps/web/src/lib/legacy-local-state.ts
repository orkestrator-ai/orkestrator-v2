import { COMMAND_STORAGE_NODE, nodeStorageKey, type StorageNode } from "@/lib/persistence-keys";

/**
 * Browser-local copies of state the backend now owns.
 *
 * Earlier releases persisted these with Zustand's `persist` middleware under a
 * per-machine key (`{ state, version }`). Against a backend that owns the
 * state, a client imports its copy once and then deletes it; against an older
 * backend it keeps reading and writing the copy exactly as before. Each copy
 * is the named node's (the command node until the owning store is scoped).
 */

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

/** The persisted `state` object under `baseKey` for `node`, or null. */
export function readLegacyPersistedState(
  baseKey: string,
  node: StorageNode = COMMAND_STORAGE_NODE,
): Record<string, unknown> | null {
  try {
    const raw = storage()?.getItem(nodeStorageKey(baseKey, node));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: unknown } | null;
    const state = parsed?.state;
    return state && typeof state === "object" && !Array.isArray(state)
      ? (state as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Write-through for an older backend, in the format earlier releases read. */
export function writeLegacyPersistedState(
  baseKey: string,
  state: Record<string, unknown>,
  node: StorageNode = COMMAND_STORAGE_NODE,
): void {
  try {
    storage()?.setItem(nodeStorageKey(baseKey, node), JSON.stringify({ state, version: 0 }));
  } catch {
    // Full or unavailable storage only loses the copy; the session keeps working.
  }
}

/** Deletes the copy once the backend holds it. */
export function clearLegacyPersistedState(
  baseKey: string,
  node: StorageNode = COMMAND_STORAGE_NODE,
): void {
  try {
    storage()?.removeItem(nodeStorageKey(baseKey, node));
  } catch {
    // Nothing more to do; the next session retries the import.
  }
}

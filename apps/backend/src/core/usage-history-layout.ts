import type { StoreLayout } from "./storage-database.js";

/**
 * Database store holding recorded agent usage, one row per agent session.
 * Imported by the store registry (storage-stores.ts), so keep this module free
 * of other imports.
 */
export const USAGE_HISTORY_STORE = "usage-history";

/**
 * The session's environment: the indexed row owner. A report filters in its
 * own pass (it needs one unfiltered scan regardless, for `recordingSince` and
 * `recordedPlatforms`); this index is what a per-environment delete uses.
 */
export function usageHistoryRowOwner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const environmentId = (value as Record<string, unknown>).environmentId;
  return typeof environmentId === "string" && environmentId ? environmentId : undefined;
}

export const USAGE_HISTORY_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [USAGE_HISTORY_STORE]: { kind: "record", owner: usageHistoryRowOwner },
};

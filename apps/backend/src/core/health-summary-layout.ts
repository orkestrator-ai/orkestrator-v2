import type { StoreLayout } from "./storage-database.js";

/**
 * Database store holding the rolling health summary, one row per sample or
 * marker. Imported by the store registry and the snapshot code, so keep this
 * module free of other imports.
 */
export const HEALTH_SUMMARY_STORE = "health-summary";

export const HEALTH_SUMMARY_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [HEALTH_SUMMARY_STORE]: { kind: "record" },
};

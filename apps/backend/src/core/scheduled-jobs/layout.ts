import type { StoreLayout } from "../storage-database.js";

/**
 * Database store holding scheduled jobs, one row per schedule. Imported by
 * the store registry (storage-stores.ts), so keep this module free of other
 * runtime imports.
 */
export const SCHEDULED_JOBS_STORE = "scheduled-jobs";

/** The schedule's owner key (`scheduleOwnerKey`), denormalized on the record. */
export function scheduledJobRowOwner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ownerKey = (value as Record<string, unknown>).ownerKey;
  return typeof ownerKey === "string" && ownerKey ? ownerKey : undefined;
}

export const SCHEDULED_JOBS_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [SCHEDULED_JOBS_STORE]: { kind: "record", owner: scheduledJobRowOwner },
};

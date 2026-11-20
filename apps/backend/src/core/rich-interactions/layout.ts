import type { StoreLayout } from "../storage-database.js";

/**
 * Database stores behind rich interactions (docs/architecture/rich-interactions.md).
 * Imported by the store registry (storage-stores.ts), so keep this module free
 * of other runtime imports. Every row is owned by its environment, so deleting
 * an environment removes its requests, receipts, drafts and deliverable
 * metadata in one owner sweep.
 */

/** One row per request, keyed by interaction id. */
export const RICH_INTERACTION_REQUESTS_STORE = "rich-interaction-requests";
/** Content-free creation keys of retired requests, so their retries cannot create new work. */
export const RICH_INTERACTION_RETIRED_STORE = "rich-interaction-retired";
/**
 * One row per committed action, keyed by receipt id. The receipt id is a
 * digest of the interaction id and the client's idempotency key, so a retry
 * finds the same row and a changed payload under the same key conflicts.
 */
export const RICH_INTERACTION_RECEIPTS_STORE = "rich-interaction-receipts";
/** One row per request with a synchronized, non-secret draft. */
export const RICH_INTERACTION_DRAFTS_STORE = "rich-interaction-drafts";
/** User organization of session deliverables (pins, labels), keyed by conversation and artifact. */
export const RICH_DELIVERABLES_STORE = "rich-interaction-deliverables";

function ownerOf(field: string) {
  return (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const direct = record[field];
    if (typeof direct === "string" && direct) return direct;
    const owner = record.owner;
    if (owner && typeof owner === "object" && !Array.isArray(owner)) {
      const nested = (owner as Record<string, unknown>)[field];
      if (typeof nested === "string" && nested) return nested;
    }
    return undefined;
  };
}

export const RICH_INTERACTION_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [RICH_INTERACTION_RETIRED_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [RICH_INTERACTION_REQUESTS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [RICH_INTERACTION_RECEIPTS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [RICH_INTERACTION_DRAFTS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [RICH_DELIVERABLES_STORE]: { kind: "record", owner: ownerOf("environmentId") },
};

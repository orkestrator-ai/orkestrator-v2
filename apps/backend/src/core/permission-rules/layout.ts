import type { StoreLayout } from "../storage-database.js";

/**
 * Database stores behind Orkestrator's permission rules (todo 0723). Imported
 * by the store registry (storage-stores.ts), so keep this module free of other
 * runtime imports.
 */

/** One row per rule, keyed by rule id, owned by its project. */
export const PERMISSION_RULES_STORE = "permission-rules";
/**
 * One row per request a rule answered (or was claimed to answer), keyed by a
 * digest of the session and interaction, owned by the environment. The claim
 * is what makes an automatic answer at-most-once across sweeps and processes.
 */
export const PERMISSION_RULE_APPLICATIONS_STORE = "permission-rule-applications";

function ownerOf(field: string) {
  return (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = (value as Record<string, unknown>)[field];
    return typeof owner === "string" && owner ? owner : undefined;
  };
}

export const PERMISSION_RULE_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [PERMISSION_RULES_STORE]: { kind: "record", owner: ownerOf("projectId") },
  [PERMISSION_RULE_APPLICATIONS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
};

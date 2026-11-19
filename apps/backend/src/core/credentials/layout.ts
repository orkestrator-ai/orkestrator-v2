import type { StoreLayout } from "../storage-database.js";

/**
 * Database stores behind agent credentials (docs/architecture/agent-credentials.md).
 * Imported by the store registry (storage-stores.ts), so keep this module free
 * of other runtime imports.
 *
 * Every row is metadata. Values live in the credential vault (`vault.ts`),
 * never in the database, so neither the database, its WAL nor its hourly
 * snapshots ever hold one.
 */

/** One row per saved connection, keyed by connection id. */
export const CREDENTIAL_CONNECTIONS_STORE = "credential-connections";
/** One row per access request, owned by its environment. */
export const CREDENTIAL_REQUESTS_STORE = "credential-requests";
/** One row per grant, owned by its environment. Holds the reference digest. */
export const CREDENTIAL_GRANTS_STORE = "credential-grants";
/** One row per use of a grant, owned by its environment. */
export const CREDENTIAL_OPERATIONS_STORE = "credential-operations";

function ownerOf(field: string) {
  return (value: unknown): string | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const owner = (value as Record<string, unknown>)[field];
    return typeof owner === "string" && owner ? owner : undefined;
  };
}

export const CREDENTIAL_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [CREDENTIAL_CONNECTIONS_STORE]: { kind: "record" },
  [CREDENTIAL_REQUESTS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [CREDENTIAL_GRANTS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
  [CREDENTIAL_OPERATIONS_STORE]: { kind: "record", owner: ownerOf("environmentId") },
};

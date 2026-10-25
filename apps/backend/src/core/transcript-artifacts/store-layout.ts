import type { StoreLayout } from "../storage-database.js";

/**
 * Database layout of the transcript-artifact stores. Imported by the store
 * registry (storage-stores.ts), so keep this module free of other imports.
 *
 * One envelope store per environment, `transcript-artifacts/<environmentId>`,
 * so environment deletion removes every record in one transaction behind the
 * shared deletion fence. Binary bytes stay files under
 * `<dataDir>/transcript-artifacts/<environmentId>/assets/<sha256>`; `assets`
 * rows are their metadata and quota accounting.
 *
 * Collections (one row per entry; row owner = conversation key where noted):
 * - `heads`: mutable head metadata per artifact (owner = conversation).
 * - `revisions`: immutable revisions keyed `<artifactId>/<revision>`.
 * - `derived`: prepared/derived representations per revision, keyed like
 *   `revisions` (the revision itself is never rewritten).
 * - `operations`: verification operations (owner = conversation).
 * - `receipts`: immutable successful receipts.
 * - `publications`: immutable publications (owner = conversation).
 * - `publication-keys`: `<artifactId>/<revision>` → publication id (uniqueness).
 * - `idempotency`: request records keyed by a digest of
 *   (conversation, operation kind, request key) (owner = conversation).
 * - `outbox`: publication events awaiting delivery hints.
 * - `conversations`: per-conversation publication sequence (ledger revision).
 * - `assets`: content-addressed asset metadata keyed by SHA-256.
 * - `repairs`: repair-budget counters keyed `<artifactId>/<turnKey digest>`.
 * - `staged-assets`: uploads staged for use as assets, keyed by staged id
 *   (owner = conversation); bytes live in `assets/` like everything else.
 * - `meta`: `quota` (asset bytes).
 */
export const TRANSCRIPT_ARTIFACT_STORE_PREFIX = "transcript-artifacts/";

export const TRANSCRIPT_ARTIFACT_COLLECTIONS = [
  "heads",
  "revisions",
  "derived",
  "operations",
  "receipts",
  "publications",
  "publication-keys",
  "idempotency",
  "outbox",
  "conversations",
  "assets",
  "repairs",
  "meta",
  "staged-assets",
] as const;
export type TranscriptArtifactCollection = (typeof TRANSCRIPT_ARTIFACT_COLLECTIONS)[number];

export const TRANSCRIPT_ARTIFACT_STORE_LAYOUT: StoreLayout = {
  kind: "envelope",
  collections: TRANSCRIPT_ARTIFACT_COLLECTIONS,
};

/** The artifact grant signing identity (`{ version, secret }`). Separate from workflow results. */
export const TRANSCRIPT_ARTIFACT_AUTHORITY_STORE = "transcript-artifact-authority";

/**
 * Artifact scope grants keyed by grant id: digest and binding only, never the
 * bearer value. Row owner = environment id, so deletion is one owner sweep.
 */
export const TRANSCRIPT_ARTIFACT_GRANTS_STORE = "transcript-artifact-grants";

function grantOwner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = (value as { owner?: { environmentId?: unknown } }).owner;
  return typeof owner?.environmentId === "string" ? owner.environmentId : undefined;
}

export const TRANSCRIPT_ARTIFACT_ENGINE_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [TRANSCRIPT_ARTIFACT_AUTHORITY_STORE]: { kind: "document" },
  [TRANSCRIPT_ARTIFACT_GRANTS_STORE]: { kind: "record", owner: grantOwner },
};

export function transcriptArtifactStoreName(environmentId: string): string {
  return `${TRANSCRIPT_ARTIFACT_STORE_PREFIX}${environmentId}`;
}

/** Deletion-fence scope shared with `storage-deletion-fences.ts`. */
export const TRANSCRIPT_ARTIFACT_DELETION_SCOPE = "transcript-artifacts";

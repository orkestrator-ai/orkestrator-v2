import type { StoreLayout } from "./storage-database.js";

/**
 * Database stores holding build-pipeline transcript metadata (chunk blobs stay
 * files). Imported by the store registry (storage-stores.ts), so keep this
 * module free of other imports.
 */

/**
 * One row per pipeline session, keyed `<pipeline tag>/<session tag>`: the
 * committed manifest (session metadata plus the ordered chunk references).
 * The row owner is the pipeline tag, so a pipeline's transcripts are deleted
 * through the owner index without assembling the store.
 */
export const BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE = "build-pipeline-transcripts/manifests";

/** `{ v, sessions, bytes }`: quota totals, kept in the same transaction as the rows. */
export const BUILD_PIPELINE_TRANSCRIPT_TOTALS_STORE = "build-pipeline-transcripts/totals";

/** Progress of the background import of the pre-database `.rec` manifests. */
export const BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE =
  "build-pipeline-transcripts/legacy-manifest-migration";

function manifestOwner(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const owner = (value as Record<string, unknown>).pipeline;
  return typeof owner === "string" ? owner : undefined;
}

export const BUILD_PIPELINE_TRANSCRIPT_STORE_LAYOUTS: Record<string, StoreLayout> = {
  [BUILD_PIPELINE_TRANSCRIPT_MANIFEST_STORE]: { kind: "record", owner: manifestOwner },
  [BUILD_PIPELINE_TRANSCRIPT_TOTALS_STORE]: { kind: "document" },
  [BUILD_PIPELINE_TRANSCRIPT_LEGACY_MIGRATION_STORE]: { kind: "document" },
};

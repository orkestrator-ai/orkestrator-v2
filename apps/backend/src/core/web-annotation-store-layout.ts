import type { StoreLayout } from "./storage-database.js";

/**
 * Database layout of the web-annotation stores: one store per environment,
 * named `${WEB_ANNOTATION_STORE_PREFIX}<environmentId>`. Imported by the store
 * registry (storage-stores.ts), so keep this module free of other imports.
 *
 * Every field lives in a collection (one row per item); the envelope document
 * holds only collection markers. PNG bytes stay files under
 * `web-annotations/<environmentId>/assets/`; `assets` rows are their metadata.
 */
export const WEB_ANNOTATION_STORE_PREFIX = "web-annotations/";

/**
 * - `meta`: `state` (format version, environment revision, record bytes,
 *   storage status, import provenance) and `migration` (legacy browser-note
 *   migration receipts).
 * - `annotations`, `captures`, `entries` (one row per entry index, keyed by
 *   entry id), `requests` (with instruction and response excerpt), `results`,
 *   `assets` (image metadata), `receipts` (keyed by operation id, ordered by
 *   row position), `drafts` (keyed by editor id), `changed` (environment
 *   revision at which each annotation last changed).
 * - `records`: immutable bodies keyed `${id}/${revision}` (captures, entries,
 *   briefs, results, draft text).
 * - `unreadable`: records an import found missing or damaged, keyed like
 *   `records`; the items that depend on them are read-only.
 */
export const WEB_ANNOTATION_INDEX_COLLECTIONS = [
  "meta",
  "annotations",
  "changed",
  "captures",
  "entries",
  "requests",
  "results",
  "assets",
  "receipts",
  "drafts",
  "unreadable",
] as const;

export const WEB_ANNOTATION_RECORDS_COLLECTION = "records";

export const WEB_ANNOTATION_STORE_LAYOUT: StoreLayout = {
  kind: "envelope",
  collections: [...WEB_ANNOTATION_INDEX_COLLECTIONS, WEB_ANNOTATION_RECORDS_COLLECTION],
};

export function webAnnotationStoreName(environmentId: string): string {
  return `${WEB_ANNOTATION_STORE_PREFIX}${environmentId}`;
}

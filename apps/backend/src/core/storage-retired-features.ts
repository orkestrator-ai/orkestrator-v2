import type { StorageMigration } from "./storage-database.js";
import { isRecord } from "./storage-shared-core.js";

/**
 * Data of features that no longer exist.
 *
 * Looped Review was removed in favour of Review and Multi Review. Its workflow
 * store is deleted, and the records it left in shared stores are dropped:
 * nothing reads them any more, and a looped-review claim in the interaction
 * resolution journal would make the whole journal fail validation, which the
 * Build pipeline's interaction handling reads on every claim.
 *
 * The `looped-review` session origin was also used by Multi Review and the
 * Build pipeline's review fan-out. Those sessions are kept and relabelled with
 * the `automated-review` origin that replaced it; only sessions Looped Review
 * itself started (`looped-review:` logical keys) are dropped.
 */

/** Stores no build writes any more; stray legacy JSON copies are still archived. */
export const RETIRED_LEGACY_STORES: readonly string[] = ["looped-reviews"];

const LOOPED_REVIEW = "looped-review";

function isLoopedReviewSession(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.logicalSessionKey === "string" &&
    value.logicalSessionKey.startsWith(`${LOOPED_REVIEW}:`)
  );
}

/**
 * Native sessions without the ones Looped Review started, and with the Multi
 * Review and review fan-out sessions that shared its origin relabelled.
 */
export function withoutLoopedReviewSessions(stored: unknown): unknown {
  if (!isRecord(stored)) return stored;
  let changed = false;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stored)) {
    if (isLoopedReviewSession(value)) {
      changed = true;
      continue;
    }
    if (isRecord(value) && value.origin === LOOPED_REVIEW) {
      changed = true;
      kept[key] = { ...value, origin: "automated-review" };
      continue;
    }
    kept[key] = value;
  }
  return changed ? kept : stored;
}

/** The interaction resolution journal without Looped Review claims. */
export function withoutLoopedReviewJournalEntries(stored: unknown): unknown {
  if (!isRecord(stored) || !Array.isArray(stored.entries)) return stored;
  const entries = stored.entries.filter(
    (entry) =>
      !isRecord(entry) || !isRecord(entry.claim) || entry.claim.workflowType !== LOOPED_REVIEW,
  );
  return entries.length === stored.entries.length ? stored : { ...stored, entries };
}

const RETIRED_RECORD_FILTERS: ReadonlyArray<readonly [string, (stored: unknown) => unknown]> = [
  ["native-agent-sessions", withoutLoopedReviewSessions],
  ["agent-interaction-resolution-journal", withoutLoopedReviewJournalEntries],
];

export const RETIRE_LOOPED_REVIEWS_VERSION = 5;

export const retireLoopedReviewsMigration: StorageMigration = {
  version: RETIRE_LOOPED_REVIEWS_VERSION,
  name: "retire-looped-reviews",
  up({ database }) {
    for (const store of RETIRED_LEGACY_STORES) database.deleteStoreInTransaction(store);
    for (const [store, filter] of RETIRED_RECORD_FILTERS) {
      const current = database.readStoreValueInTransaction(store);
      // Absent or unreadable: nothing to drop, and an unreadable store stays as it is.
      if (!current) continue;
      const next = filter(current.value);
      if (next !== current.value) database.writeStoreInTransaction(store, next);
    }
  },
};

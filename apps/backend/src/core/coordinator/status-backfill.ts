/**
 * A resource first seen in a non-terminal settled state that has not changed
 * for this long, on an association at least
 * {@link STATUS_BACKFILL_ASSOCIATION_AGE_MS} old, is recorded without a wake.
 * That is a workflow from before status wakes existed, sitting at `ready` for
 * days; reporting it now would be a surprise turn about old news.
 */
const STATUS_BACKFILL_LIMIT_MS = 24 * 60 * 60 * 1_000;
/**
 * Only an association this old can predate status wakes (2026-10-16). A newer
 * one is owed its notice however long it waited for a main to open. Records
 * this old age out, after which the rule does nothing and can be removed.
 */
export const STATUS_BACKFILL_ASSOCIATION_AGE_MS = 14 * 24 * 60 * 60 * 1_000;

/** Whether this first notice is old news about work from before status wakes. */
export function isStatusBackfill(input: {
  now: number;
  associationCreatedAt: string;
  resourceUpdatedAt: number;
  terminal: boolean;
  alreadyNoticed: boolean;
}): boolean {
  return (
    !input.terminal &&
    !input.alreadyNoticed &&
    Number.isFinite(input.resourceUpdatedAt) &&
    input.now - input.resourceUpdatedAt > STATUS_BACKFILL_LIMIT_MS &&
    input.now - Date.parse(input.associationCreatedAt) > STATUS_BACKFILL_ASSOCIATION_AGE_MS
  );
}

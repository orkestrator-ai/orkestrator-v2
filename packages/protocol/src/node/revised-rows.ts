import { createHash } from "node:crypto";

/**
 * The rows a bridge changed most recently, for `revisedMessages`.
 *
 * A transcript row is one model response, so a late update — a background
 * tool's result, a subagent's report, a measured command change — can land on
 * a row newer responses have already pushed out of the live window. Readers
 * only re-read the window, so each bridge notes every row it changes here and
 * passes {@link RecentlyRevisedRows.ids} to its transcript source; the summary
 * then carries the noted rows that fall before the window.
 *
 * Bounded by count, oldest note first out. A reader that misses more than this
 * many changes while not reading must invalidate retained history using the
 * overflow version, then page it again.
 */
export const RECENTLY_REVISED_ROWS_MAX = 128;

export class RecentlyRevisedRows {
  private readonly order = new Set<string>();
  /** Moves when a revision note is lost. Cleared with a new history epoch. */
  overflowVersion = 0;
  version = 0;

  constructor(private readonly maximum: number = RECENTLY_REVISED_ROWS_MAX) {}

  /** Record that the row `id` changed; it becomes the newest note. */
  note(id: string): void {
    this.version += 1;
    this.order.delete(id);
    this.order.add(id);
    while (this.order.size > this.maximum) {
      const oldest = this.order.values().next().value;
      if (oldest === undefined) break;
      this.order.delete(oldest);
      this.overflowVersion += 1;
    }
  }

  /** Forget a row the transcript no longer holds. */
  forget(id: string): void {
    this.order.delete(id);
  }

  clear(): void {
    this.order.clear();
    this.overflowVersion = 0;
    this.version = 0;
  }

  /** Noted ids, newest change first. */
  ids(): string[] {
    return [...this.order].reverse();
  }
}

/** Content-free, stable recovery signal for revisions omitted by a bound. */
export function revisedRowsReconciliationToken(
  overflowVersion: number,
  omitted: readonly unknown[],
): string | undefined {
  if (overflowVersion === 0 && omitted.length === 0) return undefined;
  const digest = createHash("sha256").update(String(overflowVersion));
  for (const row of omitted) digest.update(JSON.stringify(row) ?? "null");
  return digest.digest("hex");
}

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
 * many changes while not reading keeps its older copies until it pages them
 * again or reloads.
 */
export const RECENTLY_REVISED_ROWS_MAX = 128;

export class RecentlyRevisedRows {
  private readonly order = new Set<string>();

  constructor(private readonly maximum: number = RECENTLY_REVISED_ROWS_MAX) {}

  /** Record that the row `id` changed; it becomes the newest note. */
  note(id: string): void {
    this.order.delete(id);
    this.order.add(id);
    while (this.order.size > this.maximum) {
      const oldest = this.order.values().next().value;
      if (oldest === undefined) break;
      this.order.delete(oldest);
    }
  }

  /** Forget a row the transcript no longer holds. */
  forget(id: string): void {
    this.order.delete(id);
  }

  clear(): void {
    this.order.clear();
  }

  /** Noted ids, newest change first. */
  ids(): string[] {
    return [...this.order].reverse();
  }
}

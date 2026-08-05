/**
 * Bounds for the durable navigation history of a browser tab.
 *
 * The renderer editor (`BrowserTab`), the pane-layout store and layout restore
 * all write or read the same durable record, so the cap and the cursor clamp
 * have to agree exactly. A cap applied in one place and a cursor rebased in
 * another produces a stored index that points outside the stored history.
 */
export const MAX_BROWSER_HISTORY_ENTRIES = 100;

export interface BoundedBrowserHistory {
  history?: string[];
  historyIndex?: number;
}

export function boundBrowserHistory(
  history: string[],
  historyIndex: number,
): Required<BoundedBrowserHistory>;
export function boundBrowserHistory(
  history: string[] | undefined,
  historyIndex: number | undefined,
  existingHistory?: string[],
): BoundedBrowserHistory;
/**
 * Caps `history` to the newest {@link MAX_BROWSER_HISTORY_ENTRIES} entries and
 * rebases `historyIndex` onto whichever array the cursor ends up stored against.
 *
 * When no new history is supplied the cursor is clamped against
 * `existingHistory`, because that is the array it will address. With neither
 * array there is nothing to point into, so the cursor is dropped instead of
 * being stored unvalidated.
 */
export function boundBrowserHistory(
  history: string[] | undefined,
  historyIndex: number | undefined,
  existingHistory?: string[],
): BoundedBrowserHistory {
  const boundedHistory = history?.slice(-MAX_BROWSER_HISTORY_ENTRIES);
  const droppedEntries = Math.max(
    0,
    (history?.length ?? 0) - MAX_BROWSER_HISTORY_ENTRIES,
  );
  const cursorTarget = boundedHistory ?? existingHistory;
  if (historyIndex === undefined || cursorTarget === undefined) {
    return { history: boundedHistory };
  }
  return {
    history: boundedHistory,
    historyIndex: Math.min(
      Math.max(historyIndex - droppedEntries, cursorTarget.length === 0 ? -1 : 0),
      cursorTarget.length - 1,
    ),
  };
}

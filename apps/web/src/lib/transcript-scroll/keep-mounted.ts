/**
 * Keep-mounted bounds. While a row holds the reader's text selection or
 * focused element, Virtuoso renders at least `KEEP_MOUNTED_MARGIN_ROWS`
 * beyond the visible range on each side, and enough rows toward the protected
 * row to keep it in the render window — at most `KEEP_MOUNTED_MAX_ROWS` rows
 * away. Farther than that, protection is released and the row unmounts like
 * any other (its DOM selection does not survive; view state does). Only one
 * row is protected at a time; virtualization stays on for the rest.
 */
export const KEEP_MOUNTED_MAX_ROWS = 8;
export const KEEP_MOUNTED_MARGIN_ROWS = 2;

/**
 * Virtuoso's `minOverscanItemCount` that keeps `protectedIndex` rendered for
 * the visible `range`, or null when there is nothing to protect or the row is
 * beyond the keep-mounted bound (release).
 */
export function keepMountedOverscan(
  protectedIndex: number | null,
  range: { startIndex: number; endIndex: number } | null,
): { top: number; bottom: number } | null {
  if (protectedIndex === null || protectedIndex < 0) return null;
  if (!range) return { top: KEEP_MOUNTED_MARGIN_ROWS, bottom: KEEP_MOUNTED_MARGIN_ROWS };
  const above = range.startIndex - protectedIndex;
  const below = protectedIndex - range.endIndex;
  if (above > KEEP_MOUNTED_MAX_ROWS || below > KEEP_MOUNTED_MAX_ROWS) return null;
  return {
    top: Math.max(0, above) + KEEP_MOUNTED_MARGIN_ROWS,
    bottom: Math.max(0, below) + KEEP_MOUNTED_MARGIN_ROWS,
  };
}

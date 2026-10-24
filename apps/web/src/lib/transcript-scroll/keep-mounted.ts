import { useState } from "react";

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

/**
 * Protection overscan for one protected row only grows. A larger overscan
 * re-renders the list, and the visible range measured during that re-render
 * can momentarily need less, which would shrink it, re-render again and need
 * more: a feedback loop. Growing only (to at most the bound) settles in a
 * few steps. `null` (nothing protected, or released) always wins.
 */
export function ratchetOverscan(
  previous: { top: number; bottom: number } | null,
  next: { top: number; bottom: number } | null,
): { top: number; bottom: number } | null {
  if (next === null || previous === null) return next;
  const top = Math.max(previous.top, next.top);
  const bottom = Math.max(previous.bottom, next.bottom);
  return top === next.top && bottom === next.bottom ? next : { top, bottom };
}

/**
 * `ratchetOverscan` across renders, per protected row: a new protected row
 * (or a release) starts again from what it needs now.
 */
export function useRatchetedOverscan(
  protectedKey: string | null,
  overscan: { top: number; bottom: number } | null,
): { top: number; bottom: number } | null {
  const [held, setHeld] = useState<{
    key: string | null;
    overscan: { top: number; bottom: number } | null;
  }>({ key: protectedKey, overscan });
  const next = ratchetOverscan(held.key === protectedKey ? held.overscan : null, overscan);
  if (
    held.key !== protectedKey ||
    held.overscan?.top !== next?.top ||
    held.overscan?.bottom !== next?.bottom
  ) {
    // Derived from the previous render's value; React re-renders before commit.
    setHeld({ key: protectedKey, overscan: next });
  }
  return next;
}

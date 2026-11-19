/**
 * The palette's highlight is a row identity, never an index. Two ids feed it:
 * the row the user chose (arrow keys, pointer), and the row the palette
 * pinned when the current query's results first appeared. A late answer that
 * inserts or reorders rows leaves both in place, so Enter opens what was
 * highlighted when the user pressed it. A missing explicit History choice stays
 * inactive until the row returns or the user selects another one.
 */

/** The row Enter would activate: the chosen row, else the pinned row, else the first. */
export function resolveActiveRow(
  rowIds: readonly string[],
  chosenId: string | null,
  pinnedId: string | null,
  retainChosenWhenMissing = false,
): string | null {
  if (chosenId !== null && rowIds.includes(chosenId)) return chosenId;
  if (chosenId !== null && retainChosenWhenMissing) return null;
  if (pinnedId !== null && rowIds.includes(pinnedId)) return pinnedId;
  return rowIds[0] ?? null;
}

/** The row `delta` steps from `activeId`, clamped to the list. */
export function moveActiveRow(
  rowIds: readonly string[],
  activeId: string | null,
  delta: number,
): string | null {
  if (rowIds.length === 0) return null;
  const current = activeId === null ? -1 : rowIds.indexOf(activeId);
  const from = current < 0 ? 0 : current;
  const next = Math.max(0, Math.min(from + (current < 0 ? 0 : delta), rowIds.length - 1));
  return rowIds[next] ?? null;
}

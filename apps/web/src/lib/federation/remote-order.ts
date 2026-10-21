/**
 * Ordering for another machine's sidebar rows.
 *
 * The owner's order is authoritative; a drag here is sent to the owner and
 * shown optimistically until its summary reflects it.
 */

/** The ids after dragging `activeId` onto `overId`, or null for a no-op drop. */
export function moveId(ids: readonly string[], activeId: string, overId: string): string[] | null {
  if (activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, activeId);
  return next;
}

/**
 * `items` in the order `ids` names. Items it does not name (created since)
 * keep their own order after the named ones; named ids that are gone are
 * skipped.
 */
export function withOrder<T>(
  items: readonly T[],
  ids: readonly string[] | undefined,
  idOf: (item: T) => string,
): readonly T[] {
  if (!ids) return items;
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) =>
      (position.get(idOf(left)) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(idOf(right)) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Rows whose order is checked before a change is trusted as a pure prepend. */
const VERIFIED_ROWS = 8;

/**
 * How many display rows `next` added in front of `previous`, when the change
 * is a pure prepend (possibly with live rows appended or the streaming tail
 * row replaced); 0 for anything else.
 *
 * Counts come from the final display projection, never raw provider records:
 * deduplicated pages, coalesced tools and split prose/tool rows make those
 * differ. A page that merges into the old first row renames it; the second
 * row then locates the boundary, and the merged row's growth is a measured
 * residual rather than a row count.
 *
 * Reads keys only from the front of each list, so a normal streaming update
 * (`next` begins with the same row) costs one comparison.
 */
export function pureprependCount<T>(
  previous: readonly T[],
  next: readonly T[],
  keyAt: (list: readonly T[], index: number) => string,
): number {
  if (previous.length === 0 || next.length <= 1) return 0;
  const firstKey = keyAt(previous, 0);
  if (keyAt(next, 0) === firstKey) return 0;
  const locate = (key: string, from: number) => {
    for (let index = from; index < next.length; index += 1) {
      if (keyAt(next, index) === key) return index;
    }
    return -1;
  };
  let added = locate(firstKey, 1);
  let verifyFrom = 0;
  if (added < 0 && previous.length > 1) {
    const second = locate(keyAt(previous, 1), 1);
    if (second > 1) {
      added = second - 1;
      verifyFrom = 1;
    }
  }
  if (added <= 0) return 0;
  const checked = Math.min(previous.length, VERIFIED_ROWS);
  // The last previous row may be the streaming tail, replaced in place.
  const lastStable = previous.length - 1;
  for (let index = verifyFrom; index < checked; index += 1) {
    if (index === lastStable && index > verifyFrom) break;
    if (added + index >= next.length) return 0;
    if (keyAt(next, added + index) !== keyAt(previous, index)) return 0;
  }
  return added;
}

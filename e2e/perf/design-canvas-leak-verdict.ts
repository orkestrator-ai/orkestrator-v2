/**
 * Pure leak-check arithmetic for `design-canvas-perf.ts`: no browser, so the
 * verdicts are unit-tested on their own (`tests/unit/design-canvas-leak-verdict.test.ts`).
 */

/** The second half's peak exceeds the first half's peak beyond the slack. */
export function peakGrowth(
  early: readonly number[],
  late: readonly number[],
  absolute: number,
  relative: number,
): { from: number; to: number } | null {
  if (early.length === 0 || late.length === 0) return null;
  const earlyMax = Math.max(...early);
  const lateMax = Math.max(...late);
  return lateMax > earlyMax * (1 + relative) + absolute ? { from: earlyMax, to: lateMax } : null;
}

/**
 * The second half's floor exceeds the first half's floor beyond the slack.
 *
 * For a counter whose every reading lands on one of two values at random, the
 * halves alone cannot tell a raised floor from a second half that happened to
 * read only the high value. `confirmations` are further readings of the same
 * counter taken after the last cycle with no page action between them: a leak
 * keeps every one of them at the raised floor, while noise drops one back to
 * the low value, which clears the verdict. With p the chance of a high
 * reading, a false failure needs every late and every confirming reading to
 * be high: p^(late + confirmations).
 */
export function floorGrowth(
  early: readonly number[],
  late: readonly number[],
  absolute: number,
  confirmations: readonly number[] = [],
): { from: number; to: number } | null {
  if (early.length === 0 || late.length === 0) return null;
  const earlyMin = Math.min(...early);
  const lateMin = Math.min(...late, ...confirmations);
  return lateMin > earlyMin + absolute ? { from: earlyMin, to: lateMin } : null;
}

/**
 * Takes confirming readings only while the floor still looks raised, up to
 * `limit`, so a passing run costs nothing and a real leak costs `limit` reads.
 */
export async function confirmFloor(
  early: readonly number[],
  late: readonly number[],
  absolute: number,
  limit: number,
  read: () => Promise<number>,
): Promise<{ growth: { from: number; to: number } | null; confirmations: number[] }> {
  const confirmations: number[] = [];
  let growth = floorGrowth(early, late, absolute, confirmations);
  while (growth && confirmations.length < limit) {
    confirmations.push(await read());
    growth = floorGrowth(early, late, absolute, confirmations);
  }
  return { growth, confirmations };
}

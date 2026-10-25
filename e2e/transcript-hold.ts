import { expect } from "@playwright/test";

/**
 * Where the list must stand to hold the reader's row: the scroll position
 * that puts the row back at its old offset, as far as the list can scroll.
 * A transcript shorter than its viewport after the page (a whole conversation
 * folded into one tool group) cannot scroll at all: the rows above push the
 * held row down and nothing can hold it, so the measure is the list's
 * position, not a loosened offset limit.
 */
export function holdPosition(
  before: { offset: number; scrollTop: number },
  after: { offset: number; scrollTop: number; maxScrollTop: number },
) {
  const needed = after.offset + after.scrollTop - before.offset;
  const reachable = Math.min(Math.max(needed, 0), after.maxScrollTop);
  return {
    reachable,
    // Signed displacement: negative at the top, positive at the bottom.
    clampedPx: needed - reachable,
    errorPx: Math.abs(after.scrollTop - reachable),
  };
}

type PlaceMeasurement = {
  anchorStop: number | undefined;
  anchorIndexBefore: number | undefined;
  anchorAfter: { visible: boolean; index: number; maxScrollTop: number } | null;
  hold: ReturnType<typeof holdPosition> | null;
  scrollTopAfter: number | undefined;
};

/**
 * The row that was first on screen is still on screen after the click. When
 * the page put rows above it, the list must also have moved off the top: a
 * list that keeps its offset shows the loaded page and pushes the reader's
 * row down by the page's height, which short rows alone can keep on screen.
 * A list that cannot scroll far enough (a transcript that fits its viewport)
 * must stand at the end of its range instead.
 */
export function expectPlaceHeld(measured: PlaceMeasurement, label: string) {
  expect(measured.anchorStop, `${label}: no observable trail tool to anchor`).toBeDefined();
  expect(measured.anchorAfter?.visible, `${label}: lost the reader's place`).toBe(true);
  // The row's offset is held exactly, unless the list cannot scroll that far;
  // then it must stand at the end of its range (see `holdPosition`).
  expect(
    measured.hold?.errorPx,
    `${label}: the original tool moved within the viewport`,
  ).toBeLessThanOrEqual(8);
  const landedAbove =
    measured.anchorAfter !== null &&
    measured.anchorIndexBefore !== undefined &&
    measured.anchorAfter.index > measured.anchorIndexBefore;
  if (landedAbove && measured.anchorAfter!.maxScrollTop > 0) {
    expect(
      measured.scrollTopAfter,
      `${label}: stayed at the top of the loaded page`,
    ).toBeGreaterThan(0);
  }
}

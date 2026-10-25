import { expect, test } from "@playwright/test";
import { expectPlaceHeld, holdPosition } from "./transcript-hold";

for (const { name, before, after, expected } of [
  {
    name: "an exact hold within the scroll range",
    before: { offset: 69, scrollTop: 0 },
    after: { offset: 69, scrollTop: 124, maxScrollTop: 300 },
    expected: { reachable: 124, clampedPx: 0, errorPx: 0 },
  },
  {
    name: "an upward clamp after the history header disappears",
    before: { offset: 69, scrollTop: 0 },
    after: { offset: 13, scrollTop: 0, maxScrollTop: 300 },
    expected: { reachable: 0, clampedPx: -56, errorPx: 0 },
  },
  {
    name: "a downward clamp at the end of a scrollable list",
    before: { offset: 69, scrollTop: 0 },
    after: { offset: 93, scrollTop: 100, maxScrollTop: 100 },
    expected: { reachable: 100, clampedPx: 24, errorPx: 0 },
  },
  {
    name: "a downward clamp when the transcript fits its viewport",
    before: { offset: 69, scrollTop: 0 },
    after: { offset: 193, scrollTop: 0, maxScrollTop: 0 },
    expected: { reachable: 0, clampedPx: 124, errorPx: 0 },
  },
  {
    name: "drift inside the scroll range",
    before: { offset: 69, scrollTop: 40 },
    after: { offset: 81, scrollTop: 124, maxScrollTop: 300 },
    expected: { reachable: 136, clampedPx: 0, errorPx: 12 },
  },
  {
    name: "failure to reach a clamped boundary",
    before: { offset: 69, scrollTop: 0 },
    after: { offset: 113, scrollTop: 80, maxScrollTop: 100 },
    expected: { reachable: 100, clampedPx: 24, errorPx: 20 },
  },
]) {
  test(`holdPosition: ${name}`, () => {
    expect(holdPosition(before, after)).toEqual(expected);
  });
}

// Use the live assertion itself without requiring provider turns. In particular,
// a small offset error alone can pass even when prepending left the list at top.
function measurement() {
  return {
    anchorStop: 50,
    anchorIndexBefore: 0,
    anchorAfter: { visible: true, index: 1, maxScrollTop: 300 },
    hold: { reachable: 4, clampedPx: 0, errorPx: 4 },
    scrollTopAfter: 0,
  };
}

test("expectPlaceHeld rejects staying at top when rows landed above in a scrollable list", () => {
  expect(() => expectPlaceHeld(measurement(), "paging")).toThrow(
    "stayed at the top of the loaded page",
  );
});

test("expectPlaceHeld accepts rows landing above when the list cannot scroll", () => {
  const measured = measurement();
  measured.anchorAfter.maxScrollTop = 0;
  measured.hold = holdPosition(
    { offset: 69, scrollTop: 0 },
    { offset: 193, scrollTop: 0, maxScrollTop: 0 },
  );
  expectPlaceHeld(measured, "paging");
});

test("expectPlaceHeld accepts movement off the top after rows land above", () => {
  const measured = measurement();
  measured.scrollTopAfter = 4;
  measured.hold.errorPx = 0;
  expectPlaceHeld(measured, "paging");
});

test("expectPlaceHeld accepts the top clamp when the row index stays unchanged", () => {
  const measured = measurement();
  measured.anchorAfter.index = measured.anchorIndexBefore;
  measured.hold = holdPosition(
    { offset: 69, scrollTop: 0 },
    { offset: 13, scrollTop: 0, maxScrollTop: 300 },
  );
  expectPlaceHeld(measured, "paging");
});

test("expectPlaceHeld keeps the eight pixel error limit for scrollable and clamped lists", () => {
  for (const maxScrollTop of [0, 300]) {
    const measured = measurement();
    measured.anchorAfter.maxScrollTop = maxScrollTop;
    measured.scrollTopAfter = 20;
    measured.hold.errorPx = 8;
    expectPlaceHeld(measured, "paging");
    measured.hold.errorPx = 9;
    expect(() => expectPlaceHeld(measured, "paging")).toThrow(
      "the original tool moved within the viewport",
    );
  }
});

test("expectPlaceHeld rejects a missing anchor, a lost row, and a missing measurement", () => {
  const measured = measurement();
  expect(() => expectPlaceHeld({ ...measured, anchorStop: undefined }, "paging")).toThrow(
    "no observable trail tool to anchor",
  );
  expect(() => expectPlaceHeld({ ...measured, anchorAfter: null }, "paging")).toThrow(
    "lost the reader's place",
  );
  measured.anchorAfter.visible = false;
  expect(() => expectPlaceHeld(measured, "paging")).toThrow("lost the reader's place");
  measured.anchorAfter.visible = true;
  expect(() => expectPlaceHeld({ ...measured, hold: null }, "paging")).toThrow();
});

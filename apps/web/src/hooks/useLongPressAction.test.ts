import { afterEach, expect, test } from "bun:test";
import {
  CLICK_SUPPRESSION_MS,
  getLongPressTimingsForTests,
  LONG_PRESS_MS,
  restoreLongPressTimingsForTests,
  setLongPressTimingsForTests,
} from "./useLongPressAction";

afterEach(() => {
  restoreLongPressTimingsForTests();
});

test("defaults to the production long-press and click-suppression timings", () => {
  expect(LONG_PRESS_MS).toBe(550);
  expect(CLICK_SUPPRESSION_MS).toBe(1_000);
  expect(getLongPressTimingsForTests()).toEqual({
    pressMs: LONG_PRESS_MS,
    suppressionMs: CLICK_SUPPRESSION_MS,
  });
});

test("restores the production timings after a test override", () => {
  setLongPressTimingsForTests(15, 20);
  expect(getLongPressTimingsForTests()).toEqual({ pressMs: 15, suppressionMs: 20 });
  restoreLongPressTimingsForTests();
  expect(getLongPressTimingsForTests()).toEqual({
    pressMs: LONG_PRESS_MS,
    suppressionMs: CLICK_SUPPRESSION_MS,
  });
});

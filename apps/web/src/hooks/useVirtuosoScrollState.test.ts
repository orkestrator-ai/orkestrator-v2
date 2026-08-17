import { describe, expect, test } from "bun:test";
import type { StateSnapshot } from "react-virtuoso";
import { isRestorableStateSnapshot } from "./useVirtuosoScrollState";

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    ranges: [{ startIndex: 0, endIndex: 12, size: 34 }],
    scrollTop: 1764,
    ...overrides,
  } as StateSnapshot;
}

describe("isRestorableStateSnapshot", () => {
  test("accepts a well-formed getState snapshot", () => {
    expect(isRestorableStateSnapshot(snapshot())).toBe(true);
    expect(isRestorableStateSnapshot(snapshot({ ranges: [], scrollTop: 0 }))).toBe(true);
  });

  test("rejects missing or non-object snapshots", () => {
    expect(isRestorableStateSnapshot(undefined)).toBe(false);
    expect(isRestorableStateSnapshot(null as unknown as StateSnapshot)).toBe(false);
  });

  test("rejects non-finite or negative scrollTop", () => {
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: Number.NaN }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: Infinity }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: -1 }))).toBe(false);
  });

  test("rejects ranges Virtuoso's size tree cannot order", () => {
    // These exact shapes throw "Failed binary finding record in array" from
    // inside a render when handed to restoreStateFrom.
    expect(isRestorableStateSnapshot(snapshot({
      ranges: [{ startIndex: -3, endIndex: Number.NaN, size: Number.NaN }],
    }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({
      ranges: [{ startIndex: 5, endIndex: 2, size: 10 }],
    }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({
      ranges: [{ startIndex: 0, endIndex: 3, size: -1 }],
    }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({
      ranges: [{ startIndex: 0.5, endIndex: 3, size: 10 }],
    }))).toBe(false);
    expect(isRestorableStateSnapshot(
      snapshot({ ranges: undefined as unknown as StateSnapshot["ranges"] }),
    )).toBe(false);
  });
});

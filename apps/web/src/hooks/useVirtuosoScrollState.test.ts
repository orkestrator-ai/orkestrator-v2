import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { StateSnapshot } from "react-virtuoso";
import { isRestorableStateSnapshot, useVirtuosoScrollState } from "./useVirtuosoScrollState";

afterEach(() => cleanup());

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    // Virtuoso serializes the final size-tree entry as an open-ended range.
    // This is the real getState() shape, not a finite test-only substitute.
    ranges: [
      { startIndex: 0, endIndex: 11, size: 34 },
      { startIndex: 12, endIndex: Number.POSITIVE_INFINITY, size: 36 },
    ],
    scrollTop: 1764,
    ...overrides,
  } as StateSnapshot;
}

describe("isRestorableStateSnapshot", () => {
  test("accepts a well-formed getState snapshot", () => {
    expect(isRestorableStateSnapshot(snapshot())).toBe(true);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: 0, endIndex: 12, size: 34 }],
        }),
      ),
    ).toBe(true);
    expect(isRestorableStateSnapshot(snapshot({ ranges: [], scrollTop: 0 }))).toBe(true);
  });

  test("rejects missing or non-object snapshots", () => {
    expect(isRestorableStateSnapshot(undefined)).toBe(false);
    expect(isRestorableStateSnapshot(null as unknown as StateSnapshot)).toBe(false);
  });

  test("rejects non-finite scrollTop", () => {
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: Number.NaN }))).toBe(false);
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: Infinity }))).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          scrollTop: Number.NEGATIVE_INFINITY,
        }),
      ),
    ).toBe(false);
  });

  test("accepts the negative scrollTop a view with a Header persists", () => {
    // getState() records `scrollTop - headerHeight`, and restore feeds it back
    // as `{ align: "start", index: 0, offset }`. A transcript that renders a
    // Virtuoso Header — the agent tab's "load earlier messages" banner — is
    // therefore *expected* to persist a negative value once the reader scrolls
    // into that header, and rejecting the sign would throw the position away.
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: -48 }))).toBe(true);
    expect(isRestorableStateSnapshot(snapshot({ scrollTop: -0.5 }))).toBe(true);
  });

  test("rejects ranges Virtuoso's size tree cannot order", () => {
    // These exact shapes throw "Failed binary finding record in array" from
    // inside a render when handed to restoreStateFrom.
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: -3, endIndex: Number.NaN, size: Number.NaN }],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: 5, endIndex: 2, size: 10 }],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: 0, endIndex: 3, size: -1 }],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: 0.5, endIndex: 3, size: 10 }],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [
            { startIndex: 0, endIndex: Number.POSITIVE_INFINITY, size: 10 },
            { startIndex: 4, endIndex: 8, size: 12 },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [
            { startIndex: 0, endIndex: 5, size: 10 },
            { startIndex: 5, endIndex: Number.POSITIVE_INFINITY, size: 12 },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({
          ranges: [{ startIndex: 0, endIndex: Number.NEGATIVE_INFINITY, size: 10 }],
        }),
      ),
    ).toBe(false);
    expect(
      isRestorableStateSnapshot(
        snapshot({ ranges: undefined as unknown as StateSnapshot["ranges"] }),
      ),
    ).toBe(false);
  });
});

describe("useVirtuosoScrollState scrollToIndex", () => {
  function fakeHandle() {
    return {
      scrollToIndex: mock((_location: unknown) => {}),
      scrollTo: mock((_location: unknown) => {}),
      getState: mock(() => {}),
    };
  }

  test("is false until the list handle exists, and rejects a bad index", () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    expect(result.current.scrollToIndex(2)).toBe(false);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    expect(result.current.scrollToIndex(-1)).toBe(false);
    expect(result.current.scrollToIndex(1.5)).toBe(false);
    expect(handle.scrollToIndex).not.toHaveBeenCalled();
  });

  test("centres the row, releases stick intent, and corrects once rows measure", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;

    expect(result.current.scrollProps.followOutput(true)).toBe("auto");
    expect(result.current.scrollToIndex(3)).toBe(true);

    expect(handle.scrollToIndex).toHaveBeenCalledWith({
      index: 3,
      align: "center",
      behavior: "auto",
    });
    // New output no longer drags the reader back to the tail.
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    await waitFor(() => expect(handle.scrollToIndex.mock.calls.length).toBeGreaterThan(1));
    expect(handle.scrollTo).not.toHaveBeenCalled();
  });
});

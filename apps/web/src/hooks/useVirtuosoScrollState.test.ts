import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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

  function mountScroller(result: { current: ReturnType<typeof useVirtuosoScrollState> }) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 2000 });
    Object.defineProperty(el, "clientHeight", { value: 500 });
    el.scrollTop = 500;
    act(() => result.current.scrollProps.scrollerRef(el));
    return el;
  }

  test("a jump ending at the tail resumes following without another bottom callback", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    act(() => result.current.scrollProps.atBottomStateChange(false));
    expect(result.current.scrollToIndex(3)).toBe(true);
    el.scrollTop = 1500;
    // The sole false-to-true transition arrives while corrections are guarded.
    act(() => result.current.scrollProps.atBottomStateChange(true));
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    await waitFor(() => expect(result.current.scrollProps.followOutput(true)).toBe("auto"));
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(4);
    Object.defineProperty(el, "scrollHeight", { value: 2200 });
    act(() => result.current.scrollProps.totalListHeightChanged(2200));
    expect(el.scrollTop).toBe(1700);
  });

  test("a transient bottom landing followed by correction away stays released", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    expect(result.current.scrollToIndex(3)).toBe(true);
    el.scrollTop = 1500;
    act(() => {
      // A cached-height correction can arrive at the bottom through a native
      // scroll event before Virtuoso reports its at-bottom transition.
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.scrollProps.followOutput(false)).toBe(false);
    act(() => result.current.scrollProps.totalListHeightChanged(2000));
    expect(result.current.scrollProps.followOutput(false)).toBe(false);
    act(() => result.current.scrollProps.atBottomStateChange(true));
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    el.scrollTop = 500;
    // Even a stale at-bottom boolean cannot override the final geometry.
    await waitFor(() => expect(handle.scrollToIndex).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 240));
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
  });

  test("a user scroll cancels corrections and their final stick reconciliation", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    result.current.scrollToIndex(3);
    await waitFor(() => expect(handle.scrollToIndex).toHaveBeenCalledTimes(2));
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));
    // Bottom geometry later changes without a new arrival transition.
    el.scrollTop = 1500;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
  });

  test("settles a held tool from actual geometry after cached header estimates change", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    el.innerHTML =
      '<div data-chat-message-index="0"><div data-transcript-part-id="call52"></div></div>';
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const row = el.firstElementChild as HTMLElement;
    const tool = row.firstElementChild as HTMLElement;
    row.getBoundingClientRect = () => ({ top: 600 - el.scrollTop }) as DOMRect;
    tool.getBoundingClientRect = () => ({ top: 676 - el.scrollTop }) as DOMRect;
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    result.current.scrollToIndex(0, { partId: "call52", offset: 20 });
    await waitFor(() => expect(el.scrollTop).toBe(556));
    expect(tool.getBoundingClientRect().top - el.getBoundingClientRect().top).toBe(20);
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
  });

  test("recalculates the source tool offset after row measurement", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    el.innerHTML =
      '<div data-chat-message-index="0"><div data-transcript-part-id="call52"></div></div>';
    const row = el.firstElementChild as HTMLElement;
    const tool = row.firstElementChild as HTMLElement;
    row.getBoundingClientRect = () => ({ top: -500 }) as DOMRect;
    let toolTop = 120;
    tool.getBoundingClientRect = () => ({ top: toolTop }) as DOMRect;
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    result.current.scrollToIndex(0, { partId: "call52", offset: 20 });
    expect(handle.scrollToIndex).toHaveBeenLastCalledWith({
      index: 0,
      align: "start",
      behavior: "auto",
      offset: 600,
    });
    toolTop = 220;
    await waitFor(() =>
      expect(handle.scrollToIndex).toHaveBeenLastCalledWith({
        index: 0,
        align: "start",
        behavior: "auto",
        offset: 700,
      }),
    );
  });
});

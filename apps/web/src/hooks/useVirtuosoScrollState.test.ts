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
      cancelPendingNavigation: mock(() => {}),
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

  test("centres an unrendered row through one index navigation and releases follow", () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    mountScroller(result);

    expect(result.current.scrollProps.followOutput(true)).toBe("auto");
    expect(result.current.scrollToIndex(3)).toBe(true);

    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(handle.scrollToIndex).toHaveBeenCalledWith({
      index: 3,
      align: "center",
      behavior: "auto",
    });
    // New output no longer drags the reader back to the tail.
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
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

  test("an unresolved target re-issues index navigation a bounded number of times, then stops", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    mountScroller(result);
    result.current.scrollToIndex(3);
    // 30 frames or 750 ms, whichever first; let both pass.
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    const calls = handle.scrollToIndex.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(handle.scrollToIndex.mock.calls.length).toBe(calls);
    expect(result.current.getScrollDiagnostics().lastOutcome).toBe("unresolved");
  });

  test("a jump that lands at the tail leaves the reader detached until they arrive themselves", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    expect(result.current.scrollToIndex(3)).toBe(true);
    el.scrollTop = 1500;
    act(() => {
      el.dispatchEvent(new Event("scroll"));
      result.current.scrollProps.atBottomStateChange(true);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    // Neither a measurement landing at the end nor an at-bottom report is intent.
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    expect(result.current.scrollProps.followEnabled).toBe(false);
    // The reader's own arrival is.
    el.scrollTop = 1400;
    act(() => el.dispatchEvent(new Event("scroll")));
    act(() => {
      el.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
      el.scrollTop = 1500;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(result.current.scrollProps.followOutput(true)).toBe("auto");
    Object.defineProperty(el, "scrollHeight", { value: 2200 });
    act(() => result.current.scrollProps.totalListHeightChanged(2200));
    expect(el.scrollTop).toBe(1700);
  });

  test("a user scroll retires the navigation: no later index writes, follow stays released", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    result.current.scrollToIndex(3);
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));
    expect(handle.cancelPendingNavigation).toHaveBeenCalled();
    // Bottom geometry later changes without a new arrival transition.
    el.scrollTop = 1500;
    await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
    expect(handle.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(result.current.scrollProps.followOutput(true)).toBe(false);
    expect(result.current.getScrollDiagnostics().lastOutcome).toBe("cancelled");
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

  test("converges a mounted source tool on measured geometry as its row re-measures", async () => {
    const { result } = renderHook(() => useVirtuosoScrollState({ isActive: true }));
    const el = mountScroller(result);
    el.innerHTML =
      '<div data-chat-message-index="0"><div data-transcript-part-id="call52"></div></div>';
    el.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const row = el.firstElementChild as HTMLElement;
    const tool = row.firstElementChild as HTMLElement;
    // Once the first correction lands, content above the tool measures 100px
    // taller (rows rendering in around it), before the operation converges.
    const toolDocumentTop = () => (el.scrollTop >= 556 ? 776 : 676);
    row.getBoundingClientRect = () => ({ top: 600 - el.scrollTop }) as DOMRect;
    tool.getBoundingClientRect = () =>
      ({ top: toolDocumentTop() - el.scrollTop, height: 40 }) as DOMRect;
    const handle = fakeHandle();
    result.current.virtuosoRef.current = handle as never;
    result.current.scrollToIndex(0, { partId: "call52", offset: 20 });
    // Mounted: no index navigation, only measured writes.
    expect(handle.scrollToIndex).not.toHaveBeenCalled();
    // The same bounded operation follows the re-measure to the held offset.
    await waitFor(() => expect(el.scrollTop).toBe(656));
    await waitFor(() =>
      expect(result.current.getScrollDiagnostics().lastOutcome).toBe("converged"),
    );
    expect(tool.getBoundingClientRect().top - el.getBoundingClientRect().top).toBe(20);
  });
});

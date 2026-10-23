import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVirtuosoScrollState } from "./useVirtuosoScrollState";
import { installControlledTimeout } from "../../../../tests/helpers/controlled-timeout";

afterEach(() => cleanup());

/**
 * The real hook around a fake Virtuoso handle and a scroller with controllable
 * geometry. `writeCount()` counts every application positioning write: handle
 * commands and direct `scrollTop` assignments. `setBrowserScrollTop` simulates
 * native movement and is not counted.
 */
function mountScrollHarness(geometry: { scrollTop: number; height: number; viewport: number }) {
  const hook = renderHook(() => useVirtuosoScrollState({ isActive: true }));
  let scrollTop = geometry.scrollTop;
  let height = geometry.height;
  let appWrites = 0;
  const element = document.createElement("div");
  Object.defineProperty(element, "scrollHeight", { get: () => height, configurable: true });
  Object.defineProperty(element, "clientHeight", {
    get: () => geometry.viewport,
    configurable: true,
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => scrollTop,
    set: (value: number) => {
      appWrites += 1;
      scrollTop = Math.max(0, Math.min(value, height - geometry.viewport));
    },
    configurable: true,
  });
  element.getBoundingClientRect = () => ({ top: 0, bottom: geometry.viewport }) as DOMRect;
  document.body.appendChild(element);
  const handle = {
    scrollToIndex: mock((_location: unknown) => {
      appWrites += 1;
    }),
    scrollTo: mock((_location: unknown) => {
      appWrites += 1;
    }),
    scrollBy: mock((_location: unknown) => {
      appWrites += 1;
    }),
    getState: mock(() => {}),
    cancelPendingNavigation: mock(() => {}),
  };
  hook.result.current.virtuosoRef.current = handle as never;
  act(() => hook.result.current.scrollProps.scrollerRef(element));
  return {
    hook,
    element,
    handle,
    writeCount: () => appWrites,
    setBrowserScrollTop(value: number) {
      scrollTop = value;
    },
    setHeight(value: number) {
      height = value;
    },
    unmount() {
      hook.unmount();
      element.remove();
    },
  };
}

/** Lets scheduled animation frames (happy-dom runs them on timers) drain. */
async function frames(count = 4) {
  for (let index = 0; index < count; index += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

describe("transcript scroll ownership", () => {
  test("downward navigation cancels pending restoration", async () => {
    const correction = installControlledTimeout(120, { label: "row restoration correction" });
    const settle = installControlledTimeout(200, { label: "row restoration settle" });
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 500, height: 4000, viewport: 600 });
      act(() => {
        view!.hook.result.current.scrollToIndex(20);
      });

      act(() => {
        view!.element.dispatchEvent(new WheelEvent("wheel", { deltaY: 80 }));
        view!.setBrowserScrollTop(580); // native movement; not an app write
        view!.element.dispatchEvent(new Event("scroll"));
      });
      // An immediate same-position write may stop browser smooth motion.
      // Count after interruption, then forbid writes from the retired operation.
      const afterInterruption = view.writeCount();
      act(() => {
        correction.advance();
        settle.advance();
        correction.advance();
        settle.advance();
      });
      await frames();

      expect(view.writeCount()).toBe(afterInterruption);
      expect(view.element.scrollTop).toBe(580);
      expect(correction.pendingCount()).toBe(0);
      expect(settle.pendingCount()).toBe(0);
      correction.assertDrained();
      settle.assertDrained();
    } finally {
      view?.unmount();
      settle.restore();
      correction.restore();
    }
  });

  test("acquiring a follow pause retires an in-flight bottom journey", async () => {
    const retry = installControlledTimeout(16, { label: "bottom retry" });
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 500, height: 4000, viewport: 600 });
      act(() => view!.hook.result.current.scrollToBottom());
      expect(view.writeCount()).toBeGreaterThan(0);
      act(() => view!.hook.result.current.scrollProps.setFollowPaused("selection", true));
      const afterPause = view.writeCount();
      // Growth and retries delivered after the pause cannot move the reader.
      view.setHeight(4600);
      act(() => {
        for (let index = 0; index < 12; index += 1) retry.advance();
        view!.hook.result.current.scrollProps.totalListHeightChanged(4600);
      });
      await frames(30);
      expect(view.writeCount()).toBe(afterPause);
      expect(retry.pendingCount()).toBe(0);
    } finally {
      view?.unmount();
      retry.restore();
    }
  });

  test("a row navigation settling 20-40 px above the tail leaves the reader detached", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 0, height: 4000, viewport: 600 });
      act(() => {
        view!.hook.result.current.scrollToIndex(30);
      });
      // The library lands the row 30 px above the end.
      view.setBrowserScrollTop(4000 - 600 - 30);
      act(() => view!.element.dispatchEvent(new Event("scroll")));
      // Let any bounded reconciliation and the old settle deadline expire.
      await act(() => new Promise((resolve) => setTimeout(resolve, 900)));
      await frames();
      expect(view.hook.result.current.scrollProps.followOutput(true)).toBe(false);
      // Growth does not drag the reader to the tail.
      view.setHeight(4400);
      const before = view.element.scrollTop;
      act(() => view!.hook.result.current.scrollProps.totalListHeightChanged(4400));
      expect(view.element.scrollTop).toBe(before);
    } finally {
      view?.unmount();
    }
  });

  const interruptions: Array<[string, (element: HTMLElement) => void]> = [
    ["wheel up", (el) => el.dispatchEvent(new WheelEvent("wheel", { deltaY: -60 }))],
    ["PageDown", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }))],
    ["End", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "End" }))],
    ["ArrowDown", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))],
    ["Home", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }))],
    ["PageUp", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp" }))],
    ["Space", (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: " " }))],
    [
      "Shift+Space",
      (el) => el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true })),
    ],
  ];

  test.each(interruptions)(
    "%s retires a row navigation before any later write",
    async (_name, interrupt) => {
      let view: ReturnType<typeof mountScrollHarness> | undefined;
      try {
        view = mountScrollHarness({ scrollTop: 500, height: 4000, viewport: 600 });
        act(() => {
          view!.hook.result.current.scrollToIndex(20);
        });
        act(() => interrupt(view!.element));
        const after = view.writeCount();
        await frames(40);
        expect(view.writeCount()).toBe(after);
        expect(view.handle.cancelPendingNavigation).toHaveBeenCalled();
        expect(view.hook.result.current.getScrollDiagnostics().lastOutcome).toBe("cancelled");
      } finally {
        view?.unmount();
      }
    },
  );

  test("a scrollbar drag (movement while a pointer is held) retires navigation", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 500, height: 4000, viewport: 600 });
      act(() => {
        view!.hook.result.current.scrollToIndex(20);
      });
      act(() => {
        view!.element.dispatchEvent(new Event("pointerdown"));
        view!.setBrowserScrollTop(900);
        view!.element.dispatchEvent(new Event("scroll"));
      });
      const after = view.writeCount();
      await frames(40);
      expect(view.writeCount()).toBe(after);
      expect(view.hook.result.current.getScrollDiagnostics().lastOutcome).toBe("cancelled");
    } finally {
      view?.unmount();
    }
  });

  test("an upward touch drag retires navigation and leaves the reader detached", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 3400, height: 4000, viewport: 600 });
      act(() => view!.hook.result.current.scrollToBottom());
      act(() => {
        view!.element.dispatchEvent(new Event("touchstart"));
        view!.setBrowserScrollTop(3200);
        view!.element.dispatchEvent(new Event("touchmove"));
        view!.element.dispatchEvent(new Event("scroll"));
      });
      const after = view.writeCount();
      await frames(40);
      expect(view.writeCount()).toBe(after);
      expect(view.hook.result.current.scrollProps.followOutput(true)).toBe(false);
    } finally {
      view?.unmount();
    }
  });

  test("a fresh navigation supersedes an older one; the old frames refuse to write", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 500, height: 4000, viewport: 600 });
      act(() => {
        view!.hook.result.current.scrollToIndex(5);
        view!.hook.result.current.scrollToIndex(40);
      });
      await frames(40);
      const diagnostics = view.hook.result.current.getScrollDiagnostics();
      expect(diagnostics.superseded).toBe(1);
      // Only the current target was ever re-issued.
      const indices = view.handle.scrollToIndex.mock.calls.map(
        ([location]) => (location as { index: number }).index,
      );
      expect(indices[0]).toBe(5);
      expect(indices.slice(1).every((index) => index === 40)).toBe(true);
    } finally {
      view?.unmount();
    }
  });

  test("find navigates while find pauses follow; closing find leaves a detached reader in place", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 3400, height: 4000, viewport: 600 });
      const { controller } = view.hook.result.current.scrollProps;
      act(() => view!.hook.result.current.scrollToBottom());
      act(() => view!.hook.result.current.scrollProps.setFollowPaused("find", true));
      // Taking the find pause retired the latest journey.
      expect(controller.currentOwner).toBeNull();
      act(() => {
        controller.navigateTo({ kind: "row", index: 3, align: "center" }, "find");
      });
      expect(controller.currentOwner).toBe("find");
      view.setBrowserScrollTop(400);
      await frames(40);
      act(() => view!.hook.result.current.scrollProps.setFollowPaused("find", false));
      expect(view.element.scrollTop).toBe(400);
      expect(view.hook.result.current.scrollProps.followOutput(true)).toBe(false);
    } finally {
      view?.unmount();
    }
  });

  test("content shrink and browser clamping are not reader intent", () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 3400, height: 4000, viewport: 600 });
      // The list shrinks; the browser clamps scrollTop with no input.
      view.setHeight(3000);
      view.setBrowserScrollTop(2400);
      act(() => view!.element.dispatchEvent(new Event("scroll")));
      expect(view.hook.result.current.scrollProps.followOutput(true)).toBe("auto");
      // A subpixel wobble at the end is not a departure either.
      view.setBrowserScrollTop(2399.6);
      act(() => view!.element.dispatchEvent(new Event("scroll")));
      expect(view.hook.result.current.scrollProps.followOutput(true)).toBe("auto");
    } finally {
      view?.unmount();
    }
  });

  test("deactivation retires navigation; its late frames cannot write while inactive", async () => {
    const hook = renderHook(({ isActive }) => useVirtuosoScrollState({ isActive }), {
      initialProps: { isActive: true },
    });
    const element = document.createElement("div");
    let writes = 0;
    let top = 0;
    Object.defineProperty(element, "scrollHeight", { value: 4000 });
    Object.defineProperty(element, "clientHeight", { value: 600 });
    Object.defineProperty(element, "scrollTop", {
      get: () => top,
      set: (value: number) => {
        writes += 1;
        top = value;
      },
    });
    const handle = {
      scrollToIndex: mock(() => {
        writes += 1;
      }),
      scrollTo: mock(() => {
        writes += 1;
      }),
      getState: mock(() => {}),
      cancelPendingNavigation: mock(() => {}),
    };
    hook.result.current.virtuosoRef.current = handle as never;
    act(() => hook.result.current.scrollProps.scrollerRef(element));
    act(() => {
      hook.result.current.scrollToIndex(12);
    });
    hook.rerender({ isActive: false });
    const after = writes;
    act(() => hook.result.current.scrollProps.totalListHeightChanged(5000));
    await frames(40);
    expect(writes).toBe(after);
    expect(handle.cancelPendingNavigation).toHaveBeenCalled();
    hook.unmount();
  });

  test("many growth reports in one frame pin once each and leave no frame loop behind", async () => {
    let view: ReturnType<typeof mountScrollHarness> | undefined;
    try {
      view = mountScrollHarness({ scrollTop: 3400, height: 4000, viewport: 600 });
      const before = view.writeCount();
      act(() => {
        for (let index = 1; index <= 5; index += 1) {
          view!.setHeight(4000 + index * 10);
          view!.hook.result.current.scrollProps.totalListHeightChanged(4000 + index * 10);
        }
      });
      expect(view.writeCount() - before).toBe(5);
      expect(view.element.scrollTop).toBe(4050 - 600);
      const idle = view.writeCount();
      await frames(20);
      expect(view.writeCount()).toBe(idle);
      expect(view.hook.result.current.getScrollDiagnostics().operationsStarted).toBe(0);
    } finally {
      view?.unmount();
    }
  });
});

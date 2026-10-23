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
});

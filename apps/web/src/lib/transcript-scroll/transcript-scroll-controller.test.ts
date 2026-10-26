import { afterEach, describe, expect, mock, test } from "bun:test";
import { TranscriptScrollController } from "./transcript-scroll-controller";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

/** One measured row with controllable reflow and native scroll movement. */
function harness() {
  let top = 4400;
  let height = 5000;
  let rowTop = 2000;
  let width = 800;
  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => height },
    clientHeight: { get: () => 600 },
    clientWidth: { get: () => width },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(height - 600, value));
      },
    },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
  scroller.innerHTML = '<div data-chat-message-index="5" data-chat-message-key="k5"></div>';
  const row = scroller.firstElementChild as HTMLElement;
  row.getBoundingClientRect = () =>
    ({ top: rowTop - top, bottom: rowTop - top + 200, height: 200 }) as DOMRect;
  document.body.appendChild(scroller);
  const controller = new TranscriptScrollController({
    current: {
      scrollToIndex: mock(() => {}),
      scrollTo: mock(() => {}),
      cancelPendingNavigation: mock(() => {}),
    },
  });
  controller.attachScroller(scroller);
  disposals.push(() => {
    controller.dispose();
    scroller.remove();
  });
  return {
    controller,
    scroller,
    row,
    scrollTo(value: number) {
      top = value;
      scroller.dispatchEvent(new Event("scroll"));
    },
    grow(delta: number) {
      height += delta;
    },
    changeHeightAbove(delta: number) {
      rowTop += delta;
    },
    reflow() {
      width = 600;
      rowTop += 150;
    },
  };
}

async function frames(count = 5) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

/** Advance operation frames explicitly, without allowing native convergence. */
function controlledFrames() {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pending.set(++id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (frame) => {
    pending.delete(frame);
  };
  disposals.push(() => {
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    expect(pending.size).toBe(0);
  });
  return () => {
    const due = Array.from(pending.entries());
    for (const [frame, callback] of due) {
      if (!pending.delete(frame)) continue;
      callback(performance.now());
    }
  };
}

describe("transcript at-bottom UI state", () => {
  test("a bare scroll away exposes return-to-latest without growth or classified input", () => {
    const frame = controlledFrames();
    const view = harness();
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
    view.scrollTo(2000);
    expect(view.controller.wantsFollow).toBe(false);
    expect(view.controller.getSnapshot().isAtBottom).toBe(false);
    expect(view.controller.isAtBottomRef.current).toBe(false);
    view.controller.notifyLayout("resize"); // The button changes the dock's height.
    frame();
    expect(view.scroller.scrollTop).toBe(2000);
    expect(view.controller.getSnapshot().isAtBottom).toBe(false);
    expect(view.controller.diagnostics().writes).toBe(0);
  });

  test("growth stays at-bottom until its frame pin, then bare movement exposes the control", () => {
    const frame = controlledFrames();
    const view = harness();
    view.grow(120);
    view.controller.reportAtBottom(false);
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
    expect(view.scroller.scrollTop).toBe(4400);
    view.controller.notifyLayout("resize");
    frame();
    expect(view.scroller.scrollTop).toBe(4520);
    view.scrollTo(4520); // Deliver the pin's native scroll event.
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
    view.scrollTo(2000);
    expect(view.controller.getSnapshot().isAtBottom).toBe(false);
  });

  test("bare size compensation during growth keeps follow intent", () => {
    controlledFrames();
    const view = harness();
    view.grow(120);
    view.scrollTo(4390);
    expect(view.controller.wantsFollow).toBe(true);
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
  });

  test("a shrinking end preserves follow for compensation but releases a real departure", () => {
    controlledFrames();
    const view = harness();
    view.grow(-120);
    view.scrollTo(4280);
    expect(view.controller.wantsFollow).toBe(true);
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
    view.grow(-120);
    view.scrollTo(2000);
    expect(view.controller.wantsFollow).toBe(false);
    expect(view.controller.getSnapshot().isAtBottom).toBe(false);
  });

  for (const retirement of ["pause", "cancel", "supersede", "inactive", "converge"] as const) {
    test(`latest arrival survives growth only until ${retirement}`, () => {
      const frame = controlledFrames();
      const view = harness();
      view.scrollTo(2000);
      // Keep automatic follow disabled even after retirement, isolating the
      // operation's arrived latch from the separate follow override.
      view.controller.setFollowPause("expanded-artifact", true);
      expect(view.controller.navigateToLatest("smooth")).toBe(true);
      expect(view.controller.getSnapshot().followAllowed).toBe(false);
      expect(view.controller.getSnapshot().isAtBottom).toBe(false);
      frame(); // Issue smooth motion; the handle mock does not move the viewport.
      expect(view.controller.getSnapshot().isAtBottom).toBe(false);
      view.scrollTo(4400); // Measured arrival, before convergence.
      expect(view.controller.getSnapshot().isAtBottom).toBe(true);
      expect(view.controller.currentOwner).toBe("latest");
      if (retirement === "converge") {
        frame(); // Consume the arrival scroll's measurement invalidation.
        frame();
        frame();
        expect(view.controller.currentOwner).toBeNull();
        expect(view.controller.diagnostics().lastOutcome).toBe("converged");
        view.scrollTo(2000);
      } else {
        view.grow(120);
        view.controller.reportAtBottom(false);
        expect(view.controller.getSnapshot().followAllowed).toBe(false);
        expect(view.controller.getSnapshot().isAtBottom).toBe(true);
        expect(view.controller.isAtBottomRef.current).toBe(true);
        expect(view.controller.currentOwner).toBe("latest");
        if (retirement === "pause") view.controller.setFollowPause("selection", true);
        if (retirement === "cancel") {
          view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
        }
        if (retirement === "supersede") {
          view.controller.navigateTo({ kind: "row", index: 5, key: "k5" }, "find");
        }
        if (retirement === "inactive") view.controller.setActive(false);
      }
      expect(view.controller.getSnapshot().isAtBottom).toBe(false);
      expect(view.controller.isAtBottomRef.current).toBe(false);
      expect(view.controller.currentOwner).toBe(retirement === "supersede" ? "find" : null);
    });
  }
});

describe("transcript reading ownership", () => {
  test("one departure scroll captures a settled anchor and restores it across a width reflow", async () => {
    const original = globalThis.ResizeObserver;
    let resize: ResizeObserverCallback | undefined;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    disposals.push(() => {
      globalThis.ResizeObserver = original;
    });
    const idle = installControlledTimeout(150, { label: "reading anchor" });
    // Restore after controller disposal cancels its pending capture timer.
    disposals.unshift(() => {
      idle.assertDrained();
      idle.restore();
    });
    const view = harness();
    view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    view.scrollTo(1920);
    expect(view.controller.wantsFollow).toBe(false);
    expect(idle.advance()).toBe(1);
    expect(view.controller.readingAnchor).toEqual({
      rowKey: "k5",
      index: 5,
      partId: undefined,
      offsetPx: 80,
    });
    const operations = view.controller.diagnostics().operationsStarted;
    view.reflow();
    resize?.(
      [
        {
          target: view.scroller,
          contentRect: view.scroller.getBoundingClientRect(),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
    expect(view.controller.currentOwner).toBe("reflow");
    await frames();
    expect(view.controller.diagnostics().operationsStarted).toBe(operations + 1);
    expect(view.row.getBoundingClientRect().top).toBe(80);
    expect(view.scroller.scrollTop).toBe(2070);
  });

  test("a settled reader keeps their place throughout a tool-group fold above them", async () => {
    const view = harness();
    view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find");
    await frames();
    expect(view.controller.currentOwner).toBeNull();
    view.controller.notifyLayout("tool-group-fold");
    for (const delta of [-8, -12, -20, -10, 10, 20]) {
      view.changeHeightAbove(delta);
      view.controller.notifyLayout("resize");
      // Corrected before paint, and still correct after the virtualizer's frame.
      expect(view.row.getBoundingClientRect().top).toBe(80);
      await frames(1);
      expect(view.row.getBoundingClientRect().top).toBe(80);
    }
    await frames();
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.wantsFollow).toBe(false);
  });

  test("history restoration holds the group when folding removes the captured member", async () => {
    const view = harness();
    view.row.innerHTML =
      '<div data-transcript-group-frame data-state="open"><div data-transcript-part-id="first"></div><div data-transcript-part-id="latest"></div></div>';
    const group = view.row.firstElementChild as HTMLElement;
    group.getBoundingClientRect = () =>
      new DOMRect(0, view.row.getBoundingClientRect().top + 10, 300, 100);
    const first = group.firstElementChild as HTMLElement;
    first.getBoundingClientRect = () =>
      new DOMRect(0, group.getBoundingClientRect().top + 3, 300, 40);
    const latest = group.lastElementChild as HTMLElement;
    latest.getBoundingClientRect = () =>
      new DOMRect(0, group.getBoundingClientRect().top + 43, 300, 40);
    view.controller.navigateTo(
      { kind: "row", index: 5, key: "k5", partId: "first", offsetPx: 80 },
      "find",
    );
    await frames();
    const anchor = view.controller.captureAnchor()!;
    expect(anchor.foldedGroup).toEqual({ partId: "latest", offsetPx: 77 });
    group.dataset.state = "closed";
    first.remove();
    // Both the message header and the load-earlier header can change here.
    view.changeHeightAbove(-56);
    view.controller.navigateTo(
      {
        kind: "row",
        index: 5,
        key: "k5",
        partId: anchor.partId,
        offsetPx: anchor.offsetPx,
        foldedGroup: anchor.foldedGroup,
      },
      "history",
    );
    view.controller.notifyLayout("resize");
    expect(group.getBoundingClientRect().top).toBe(77);
    await frames();
    expect(group.getBoundingClientRect().top).toBe(77);
    expect(view.controller.diagnostics().partFallbacks).toBe(0);
    expect(view.controller.captureAnchor()?.foldedGroup).toBeUndefined();
  });

  test("height changes do not pull back a reader who has just scrolled", async () => {
    const view = harness();
    view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find");
    await frames();
    view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    view.scrollTo(2000);
    const writes = view.controller.diagnostics().writes;
    view.changeHeightAbove(-40);
    view.controller.notifyLayout("tool-group-fold");
    view.controller.notifyLayout("resize");
    await frames(1);
    expect(view.scroller.scrollTop).toBe(2000);
    expect(view.controller.diagnostics().writes).toBe(writes);
  });

  test("pointer noise at the end does not release follow", () => {
    const view = harness();
    view.scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    view.scrollTo(4399);
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(view.controller.wantsFollow).toBe(true);
  });

  test("scrollbar movement after completed find invalidates late match refinement", async () => {
    const view = harness();
    expect(
      view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find"),
    ).toBe(true);
    await frames();
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.diagnostics().lastOutcome).toBe("converged");
    const findGeneration = view.controller.generation;
    view.scroller.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    view.scrollTo(3000);
    window.dispatchEvent(new Event("pointerup"));
    expect(view.controller.generation).toBeGreaterThan(findGeneration);
    const writes = view.controller.diagnostics().writes;
    expect(
      view.controller.retarget(
        "find",
        { kind: "rect", rect: () => view.row.getBoundingClientRect() },
        findGeneration,
      ),
    ).toBe(false);
    view.controller.notifyLayout("mutation");
    await frames();
    expect(view.scroller.scrollTop).toBe(3000);
    expect(view.controller.diagnostics().writes).toBe(writes);
  });
});

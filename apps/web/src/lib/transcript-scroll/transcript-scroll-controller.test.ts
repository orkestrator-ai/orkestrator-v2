import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { INNER_SEEK_EVENT, TranscriptScrollController } from "./transcript-scroll-controller";
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
  const scrollToIndex = mock((_location: unknown) => {});
  const controller = new TranscriptScrollController({
    current: {
      scrollToIndex,
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
    scrollToIndex,
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
    setWidth(value: number) {
      width = value;
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

  // WebKit's animated wheel tick (to-do 7766, retired; transcript-scroll.md, "Reader input"): its first step meets a list that
  // shrinks by about as much, so the offset is clamped to the new end; the
  // virtualizer's compensation then moves it up, and the resize delivery that
  // reports the shrink arrives before that movement's scroll event.
  function shrinkUnderFirstStep(
    view: ReturnType<typeof harness>,
    deltaY: number,
    beforeCompensation = () => {},
  ) {
    view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY }));
    view.grow(-200);
    view.scroller.scrollTop = 4210; // The tick's first step, clamped to the new end.
    view.scroller.dispatchEvent(new Event("scroll"));
    expect(view.scroller.scrollTop).toBe(4200);
    expect(view.controller.wantsFollow).toBe(true);
    beforeCompensation();
    view.scroller.scrollTop = 4010; // Size compensation, its scroll event still queued.
    view.controller.notifyLayout("resize");
  }

  test("a wheel tick up whose first step meets a shrinking end still leaves the end", () => {
    const frame = controlledFrames();
    const view = harness();
    shrinkUnderFirstStep(view, -190);
    expect(view.scroller.scrollTop).toBe(4010);
    expect(view.controller.wantsFollow).toBe(false);
    expect(view.controller.getSnapshot().isAtBottom).toBe(false);
    view.scrollTo(4010); // The compensation's scroll event.
    frame();
    expect(view.scroller.scrollTop).toBe(4010);
    expect(view.controller.wantsFollow).toBe(false);
    expect(view.controller.diagnostics().writes).toBe(0);
  });

  test("compensation that a loaded host delays past the input window is still the reader's", () => {
    let clock = 1_000;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => clock);
    disposals.push(() => nowSpy.mockRestore());
    controlledFrames();
    const view = harness();
    shrinkUnderFirstStep(view, -190, () => {
      clock += 600; // Seen in WebKit under load: 555 ms after the wheel event.
    });
    expect(view.scroller.scrollTop).toBe(4010);
    expect(view.controller.wantsFollow).toBe(false);
  });

  test("an unrelated compensation long after upward input is pinned back to the end", () => {
    let clock = 1_000;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => clock);
    disposals.push(() => nowSpy.mockRestore());
    controlledFrames();
    const view = harness();
    shrinkUnderFirstStep(view, -190, () => {
      clock += 5_000;
    });
    expect(view.scroller.scrollTop).toBe(4200);
    expect(view.controller.wantsFollow).toBe(true);
  });

  test("the same compensation without upward input is pinned back to the end", () => {
    controlledFrames();
    const view = harness();
    shrinkUnderFirstStep(view, 190);
    expect(view.scroller.scrollTop).toBe(4200);
    expect(view.controller.wantsFollow).toBe(true);
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

  test("a width reflow leaves a pending history recovery in charge of the reader's place", () => {
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
    disposals.unshift(() => {
      idle.assertDrained();
      idle.restore();
    });
    const view = harness();
    view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    view.scrollTo(1920);
    expect(idle.advance()).toBe(1);
    expect(view.controller.readingAnchor).not.toBeNull();
    const resized = () =>
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
    // The reader's history was dropped and is being paged back in; the
    // shorter list lost its scrollbar, so the scroller is wider now.
    view.controller.setWaitingForHistory(true);
    const generation = view.controller.generation;
    const operations = view.controller.diagnostics().operationsStarted;
    view.reflow();
    resized();
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.generation).toBe(generation);
    expect(view.controller.diagnostics().operationsStarted).toBe(operations);
    // Once the recovery is over, a later width change holds the place again.
    view.controller.setWaitingForHistory(false);
    view.setWidth(700);
    resized();
    expect(view.controller.currentOwner).toBe("reflow");
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

  test("rows mounted above for a focused link do not move a settled reader", async () => {
    const view = harness();
    view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find");
    await frames();
    expect(view.controller.currentOwner).toBeNull();
    // A click on a link inside a row holds the pointer while focus moves.
    view.row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    view.controller.holdPlaceAcrossOverscan();
    expect(view.controller.currentOwner).toBe("reflow");
    // Estimated rows measure shorter: everything below moves up, no scroll event.
    view.changeHeightAbove(-464);
    view.controller.notifyLayout("resize");
    expect(view.row.getBoundingClientRect().top).toBe(80);
    await frames();
    expect(view.row.getBoundingClientRect().top).toBe(80);
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.wantsFollow).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerup"));
  });

  test("keep-mounted growth holds neither a scrollbar drag nor a follower", async () => {
    const follower = harness();
    follower.controller.holdPlaceAcrossOverscan();
    expect(follower.controller.currentOwner).toBeNull();

    const view = harness();
    view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find");
    await frames();
    const writes = view.controller.diagnostics().writes;
    view.scroller.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    view.controller.holdPlaceAcrossOverscan();
    expect(view.controller.currentOwner).toBeNull();
    await frames(1);
    expect(view.controller.diagnostics().writes).toBe(writes);
    window.dispatchEvent(new PointerEvent("pointerup"));
  });

  test("history restoration asks an open group for a member it virtualized away, then holds it", async () => {
    const view = harness();
    view.row.innerHTML =
      '<div data-transcript-group-frame data-state="open"><div data-transcript-part-id="latest"></div>' +
      '<div data-transcript-inner-viewport="true"><div data-virtuoso-scroller></div></div></div>';
    const group = view.row.firstElementChild as HTMLElement;
    group.getBoundingClientRect = () =>
      new DOMRect(0, view.row.getBoundingClientRect().top + 10, 300, 300);
    const frameHead = group.firstElementChild as HTMLElement;
    frameHead.getBoundingClientRect = () =>
      new DOMRect(0, group.getBoundingClientRect().top, 300, 30);
    const innerViewport = group.lastElementChild as HTMLElement;
    const innerScroller = innerViewport.firstElementChild as HTMLElement;
    let innerTop = 4000;
    Object.defineProperties(innerScroller, {
      scrollHeight: { get: () => 6000 },
      clientHeight: { get: () => 260 },
      scrollTop: {
        get: () => innerTop,
        set: (value: number) => {
          innerTop = Math.max(0, Math.min(6000 - 260, value));
        },
      },
    });
    // The member at local offset 1200 renders only once the inner list seeks it.
    const seeks: string[] = [];
    innerViewport.addEventListener(INNER_SEEK_EVENT, (event) => {
      const partId = (event as CustomEvent<{ partId: string }>).detail.partId;
      seeks.push(partId);
      if (innerScroller.querySelector("[data-transcript-part-id]")) return;
      innerTop = 1200;
      const member = document.createElement("div");
      member.dataset.transcriptPartId = partId;
      member.getBoundingClientRect = () =>
        new DOMRect(0, group.getBoundingClientRect().top + 40 + 1200 - innerTop, 300, 40);
      innerScroller.appendChild(member);
    });
    view.controller.navigateTo(
      {
        kind: "row",
        index: 5,
        key: "k5",
        partId: "latest",
        offsetPx: 80,
        inner: { partId: "call-1", screenOffsetPx: 150 },
      },
      "history",
    );
    await frames(12);
    expect(seeks).toEqual(["call-1"]);
    const member = innerScroller.querySelector<HTMLElement>('[data-transcript-part-id="call-1"]')!;
    expect(member.getBoundingClientRect().top).toBe(150);
  });

  test("an inner member that never renders stops seeking and settles on the group", async () => {
    const view = harness();
    view.row.innerHTML =
      '<div data-transcript-group-frame data-state="open"><div data-transcript-part-id="latest"></div>' +
      '<div data-transcript-inner-viewport="true"><div data-virtuoso-scroller></div></div></div>';
    const group = view.row.firstElementChild as HTMLElement;
    group.getBoundingClientRect = () =>
      new DOMRect(0, view.row.getBoundingClientRect().top + 10, 300, 300);
    (group.firstElementChild as HTMLElement).getBoundingClientRect = () =>
      new DOMRect(0, group.getBoundingClientRect().top, 300, 30);
    const innerViewport = group.lastElementChild as HTMLElement;
    let seeks = 0;
    innerViewport.addEventListener(INNER_SEEK_EVENT, () => {
      seeks += 1;
    });
    view.controller.navigateTo(
      {
        kind: "row",
        index: 5,
        key: "k5",
        partId: "latest",
        offsetPx: 80,
        inner: { partId: "gone", screenOffsetPx: 150 },
      },
      "history",
    );
    await frames(40);
    expect(seeks).toBeGreaterThan(0);
    expect(seeks).toBeLessThanOrEqual(20);
    expect(view.controller.currentOwner).toBeNull();
    expect(group.getBoundingClientRect().top).toBe(80);
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

  test("a match box whose row unmounts brings that row back by index", () => {
    const frame = controlledFrames();
    const view = harness();
    expect(view.controller.navigateTo({ kind: "row", index: 5, key: "k5" }, "find")).toBe(true);
    const generation = view.controller.generation;
    // The rows above measured smaller and the list moved the match's row out
    // of the rendered window: its box no longer resolves.
    let lost = true;
    const box = () => (lost ? null : view.row.getBoundingClientRect());
    expect(
      view.controller.retarget(
        "find",
        { kind: "rect", rect: box, row: { kind: "row", index: 5, key: "k5", align: "center" } },
        generation,
      ),
    ).toBe(true);
    expect(view.scrollToIndex).not.toHaveBeenCalled();
    frame();
    expect(view.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(view.scrollToIndex.mock.calls[0]![0]).toMatchObject({ index: 5, align: "center" });
    expect(view.controller.currentOwner).toBe("find");
    // The row is back and its owner resolves the box again: the navigation lands.
    lost = false;
    for (let index = 0; index < 10 && view.controller.currentOwner === "find"; index += 1) frame();
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.diagnostics().lastOutcome).toBe("converged");
    const rect = view.row.getBoundingClientRect();
    expect(rect.top).toBe(200);
  });

  test("a match box lost after its index navigation reissues it on the row's bound, then stops", () => {
    const frame = controlledFrames();
    const view = harness();
    // The row was not rendered when find began: the navigation went by index.
    expect(view.controller.navigateTo({ kind: "row", index: 9, key: "k9" }, "find")).toBe(true);
    expect(view.scrollToIndex).toHaveBeenCalledTimes(1);
    // The row mounted, find refined onto its match box, and the row left the
    // rendered window again: the box no longer resolves.
    view.controller.retarget(
      "find",
      {
        kind: "rect",
        rect: () => null,
        row: { kind: "row", index: 9, key: "k9", align: "center" },
      },
      view.controller.generation,
    );
    // An index navigation was already issued, so the box waits a few frames
    // before going back by index, exactly as a row target would.
    for (let index = 0; index < 7; index += 1) frame();
    expect(view.scrollToIndex).toHaveBeenCalledTimes(1);
    frame();
    expect(view.scrollToIndex).toHaveBeenCalledTimes(2);
    expect(view.scrollToIndex.mock.calls[1]![0]).toMatchObject({ index: 9, align: "center" });
    for (let index = 0; index < 8; index += 1) frame();
    expect(view.scrollToIndex).toHaveBeenCalledTimes(3);
    // The reissue bound holds: no more index navigations, and the budget ends it.
    for (let index = 0; index < 40 && view.controller.currentOwner === "find"; index += 1) frame();
    expect(view.scrollToIndex).toHaveBeenCalledTimes(3);
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.diagnostics().lastOutcome).toBe("unresolved");
  });

  test("a match box with no row to return to waits out its budget", () => {
    const frame = controlledFrames();
    const view = harness();
    expect(view.controller.navigateTo({ kind: "row", index: 5, key: "k5" }, "find")).toBe(true);
    view.controller.retarget(
      "find",
      { kind: "rect", rect: () => null },
      view.controller.generation,
    );
    for (let index = 0; index < 40 && view.controller.currentOwner === "find"; index += 1) frame();
    expect(view.scrollToIndex).not.toHaveBeenCalled();
    expect(view.controller.diagnostics().lastOutcome).toBe("unresolved");
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

test("reading input and scroller readiness publish even when the viewport mode is unchanged", () => {
  const { controller, scroller } = harness();
  controller.seed(false);
  const listener = mock(() => {});
  const unsubscribe = controller.subscribe(listener);
  const before = controller.generation;
  scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
  expect(controller.generation).toBeGreaterThan(before);
  expect(listener).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot().generation).toBe(controller.generation);
  controller.attachScroller(null);
  expect(controller.getSnapshot().hasScroller).toBe(false);
  expect(listener).toHaveBeenCalledTimes(2);
  unsubscribe();
});

/**
 * A scroller whose pane can be hidden. `show(clampTo)` mimics WebKit, which
 * puts a re-shown scroller's offset back during a layout that has not sized a
 * container query container inside it yet, so the offset arrives clamped.
 */
function hideableHarness(initialTop: number) {
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
  let top = initialTop;
  let shown = true;
  let width = 800;
  let rowTop = 4000;
  const height = 5000;
  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => (shown ? height : 0) },
    clientHeight: { get: () => (shown ? 600 : 0) },
    clientWidth: { get: () => (shown ? width : 0) },
    scrollTop: {
      get: () => (shown ? top : 0),
      set: (value: number) => {
        if (shown) top = Math.max(0, Math.min(height - 600, value));
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
    globalThis.ResizeObserver = original;
  });
  const deliverResize = () =>
    resize?.([{ target: scroller } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  const deliverScroll = () => scroller.dispatchEvent(new Event("scroll"));
  return {
    controller,
    scroller,
    deliverResize,
    deliverScroll,
    changeHeightAbove(delta: number) {
      rowTop += delta;
    },
    /** A reader's own wheel movement to `value`. */
    readTo(value: number) {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
      top = value;
      deliverScroll();
    },
    hide() {
      shown = false;
      deliverResize();
    },
    /** Show again; the engine either keeps the offset or clamps it and fires `scroll`. */
    show(clampTo?: number, options: { width?: number; scroll?: boolean } = {}) {
      shown = true;
      width = options.width ?? width;
      if (clampTo !== undefined && clampTo < top) {
        top = clampTo;
        if (options.scroll !== false) deliverScroll();
      }
    },
  };
}

describe("an offset across a hide", () => {
  for (const following of [false, true]) {
    test(`hidden scroll events preserve ${following ? "follow intent" : "the reading offset"}`, () => {
      controlledFrames();
      const view = hideableHarness(4400);
      if (!following) view.readTo(3800);
      const snapshot = view.controller.getSnapshot();
      view.hide();
      view.deliverScroll(); // A hidden box reports zero for every scroll metric.
      view.deliverScroll();
      expect(view.scroller.scrollTop).toBe(0);
      expect(view.controller.diagnostics().writes).toBe(0);
      expect(view.controller.wantsFollow).toBe(following);
      expect(view.controller.getSnapshot().isAtBottom).toBe(snapshot.isAtBottom);
      view.show(3334);
      view.deliverResize();
      expect(view.scroller.scrollTop).toBe(following ? 4400 : 3800);
      expect(view.controller.diagnostics().writes).toBe(1);
      expect(view.controller.wantsFollow).toBe(following);
    });
  }

  test("showing at a new width restores the offset before reflow navigation", () => {
    const frame = controlledFrames();
    const view = hideableHarness(4400);
    view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 80 }, "find");
    for (let index = 0; index < 5; index += 1) frame();
    expect(view.controller.currentOwner).toBeNull();
    expect(view.scroller.scrollTop).toBe(3920);
    view.deliverScroll(); // Observe the navigation write before hiding.
    const anchor = view.controller.readingAnchor;
    expect(anchor).toMatchObject({ rowKey: "k5", offsetPx: 80 });
    const before = view.controller.diagnostics();
    view.hide();
    view.changeHeightAbove(150);
    // No scroll event: both the clamp restore and width handling run in resize.
    view.show(3334, { width: 600, scroll: false });
    view.deliverResize();
    expect(view.scroller.scrollTop).toBe(3920);
    expect(view.controller.diagnostics().writes).toBe(before.writes + 1);
    expect(view.controller.currentOwner).toBe("reflow");
    expect(view.controller.readingAnchor).toEqual(anchor);
    for (let index = 0; index < 5; index += 1) frame();
    expect(view.scroller.scrollTop).toBe(4070);
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.diagnostics().operationsStarted).toBe(before.operationsStarted + 1);
    expect(view.controller.wantsFollow).toBe(false);
  });

  test("a reader the engine clamped on show is put back before activation's frame", () => {
    const view = hideableHarness(4400);
    view.readTo(3800);
    expect(view.controller.wantsFollow).toBe(false);
    view.hide();
    view.show(3334);
    expect(view.scroller.scrollTop).toBe(3800);
    expect(view.controller.diagnostics().writes).toBe(1);
    // The write's own scroll event, then the resize delivery, change nothing.
    view.deliverScroll();
    view.deliverResize();
    expect(view.scroller.scrollTop).toBe(3800);
    expect(view.controller.diagnostics().writes).toBe(1);
    expect(view.controller.wantsFollow).toBe(false);
  });

  test("a follower the engine left short of the end is put back and keeps following", () => {
    const view = hideableHarness(4400);
    view.hide();
    // The clamped `scroll` is idle upward movement; it must not read as a departure.
    view.show(3934);
    expect(view.scroller.scrollTop).toBe(4400);
    expect(view.controller.wantsFollow).toBe(true);
    expect(view.controller.getSnapshot().isAtBottom).toBe(true);
  });

  test("an engine that keeps the offset gets no write", () => {
    const view = hideableHarness(4400);
    view.readTo(3800);
    view.hide();
    view.show();
    view.deliverResize();
    expect(view.scroller.scrollTop).toBe(3800);
    expect(view.controller.diagnostics().writes).toBe(0);
  });

  test("following growth since the show is not undone", () => {
    const view = hideableHarness(4000);
    view.hide();
    view.show();
    view.scroller.scrollTop = 4400; // The virtualizer following growth.
    view.deliverResize();
    expect(view.scroller.scrollTop).toBe(4400);
    expect(view.controller.diagnostics().writes).toBe(0);
    expect(view.controller.wantsFollow).toBe(true);
  });

  test("navigation to earlier content after the show survives the resize", () => {
    controlledFrames();
    const view = hideableHarness(4400);
    view.readTo(3800);
    view.hide();
    view.show();
    expect(
      view.controller.navigateTo({ kind: "row", index: 5, key: "k5", offsetPx: 2000 }, "find"),
    ).toBe(true);
    view.scroller.scrollTop = 2000; // The index navigation's write, below the saved 3800.
    view.deliverResize();
    expect(view.scroller.scrollTop).toBe(2000);
    expect(view.controller.diagnostics().writes).toBe(0);
    expect(view.controller.currentOwner).toBe("find");
  });
});

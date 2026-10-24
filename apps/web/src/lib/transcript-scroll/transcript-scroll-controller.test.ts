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
  let rowTop = 2000;
  let width = 800;
  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => 5000 },
    clientHeight: { get: () => 600 },
    clientWidth: { get: () => width },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(4400, value));
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

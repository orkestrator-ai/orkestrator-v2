import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { TranscriptScrollController } from "./transcript-scroll-controller";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).reverse()) dispose();
});

const VIEWPORT = 600;
const CONTENT = 20_000;

/** A scroller on a controlled clock and frame queue, with one row at `rowTop`. */
function harness({ scrollTop = 10_000, rowTop = 12_000, rendered = true } = {}) {
  let top = scrollTop;
  let clock = 1_000;
  spyOn(performance, "now").mockImplementation(() => clock);

  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pending.set(++frameId, callback);
    return frameId;
  };
  globalThis.cancelAnimationFrame = (frame) => {
    pending.delete(frame);
  };

  const scroller = document.createElement("div");
  Object.defineProperties(scroller, {
    scrollHeight: { get: () => CONTENT },
    clientHeight: { get: () => VIEWPORT },
    clientWidth: { get: () => 800 },
    scrollTop: {
      get: () => top,
      set: (value: number) => {
        top = Math.max(0, Math.min(CONTENT - VIEWPORT, value));
      },
    },
  });
  scroller.getBoundingClientRect = () =>
    ({ top: 0, bottom: VIEWPORT, height: VIEWPORT }) as DOMRect;
  document.body.appendChild(scroller);

  // A rendered neighbour: it is how a glide tells which way an unrendered row lies.
  const neighbour = document.createElement("div");
  neighbour.dataset.chatMessageIndex = "5";
  neighbour.dataset.chatMessageKey = "neighbour";
  scroller.appendChild(neighbour);

  const row = document.createElement("div");
  row.dataset.chatMessageIndex = "9";
  row.dataset.chatMessageKey = "prompt";
  let currentRowTop = rowTop;
  row.getBoundingClientRect = () =>
    ({ top: currentRowTop - top, bottom: currentRowTop - top + 80, height: 80 }) as DOMRect;
  const mountRow = () => scroller.appendChild(row);
  if (rendered) mountRow();

  const scrollToIndex = mock(() => {});
  const cancelPendingNavigation = mock(() => {});
  const controller = new TranscriptScrollController({
    current: { scrollToIndex, scrollTo: mock(() => {}), cancelPendingNavigation },
  });
  controller.attachScroller(scroller);

  disposals.push(() => {
    controller.dispose();
    scroller.remove();
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
    mock.restore();
  });

  return {
    controller,
    scroller,
    scrollToIndex,
    cancelPendingNavigation,
    mountRow,
    pendingFrames: () => Array.from(pending.values()),
    get rowOffset() {
      return currentRowTop - top;
    },
    get top() {
      return top;
    },
    changeHeightAbove(delta: number) {
      currentRowTop += delta;
    },
    /** Advance the clock by one frame's worth and run what is due. */
    frame(ms = 16) {
      clock += ms;
      for (const [id, callback] of Array.from(pending.entries())) {
        if (pending.delete(id)) callback(clock);
      }
    },
    run(totalMs: number, ms = 16) {
      for (let elapsed = 0; elapsed < totalMs; elapsed += ms) this.frame(ms);
    },
  };
}

const glide = (view: ReturnType<typeof harness>) =>
  view.controller.glideTo({ kind: "row", index: 9, key: "prompt", offsetPx: 16 }, "row");

describe("gliding to a transcript row", () => {
  test("a rendered row eases in and out, and lands at the requested offset", () => {
    const view = harness();
    expect(glide(view)).toBe(true);
    expect(view.controller.wantsFollow).toBe(false);

    const steps: number[] = [];
    for (let elapsed = 0; elapsed < 560; elapsed += 16) {
      const before = view.top;
      view.frame();
      steps.push(view.top - before);
    }
    view.run(100);

    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
    expect(view.controller.currentOwner).toBeNull();
    // Slow at both ends, fast in the middle: not a jump and not a constant speed.
    const fastest = Math.max(...steps);
    const peak = steps.indexOf(fastest);
    expect(peak).toBeGreaterThan(2);
    expect(steps[1]!).toBeLessThan(fastest / 4);
    expect(steps.filter((step) => step > 0).at(-1)!).toBeLessThan(fastest / 4);
    expect(steps.every((step) => step >= 0)).toBe(true);
  });

  test("the row keeps to its curve while rows above it are measured", () => {
    const view = harness();
    glide(view);
    view.run(160);
    const midway = view.rowOffset;
    expect(midway).toBeGreaterThan(16);
    // A row above measures taller: the row moves, the correction follows it.
    view.changeHeightAbove(900);
    view.frame();
    expect(view.rowOffset).toBeLessThan(midway);
    view.run(600);
    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
  });

  test("a destination past the end decelerates into where the transcript stops", () => {
    const view = harness({ rowTop: CONTENT - 200 });
    glide(view);
    const steps: number[] = [];
    for (let elapsed = 0; elapsed < 560; elapsed += 16) {
      const before = view.top;
      view.frame();
      steps.push(view.top - before);
    }
    view.run(100);
    expect(CONTENT - VIEWPORT - view.top).toBeLessThanOrEqual(1);
    const moving = steps.filter((step) => step > 0);
    // No abrupt stop against the clamp.
    expect(moving.at(-1)!).toBeLessThan(Math.max(...moving) / 4);
  });

  test("a distant row departs towards it, seeks one leg short, then eases in", () => {
    const view = harness({ rendered: false });
    const start = view.top;
    expect(glide(view)).toBe(true);

    view.run(128);
    // Accelerating away in the row's direction; nothing asked of the list yet.
    expect(view.top).toBeGreaterThan(start);
    expect(view.scrollToIndex).not.toHaveBeenCalled();

    view.run(128);
    expect(view.scrollToIndex).toHaveBeenCalledTimes(1);
    const leg = Math.min(320, VIEWPORT * 0.6);
    expect(view.scrollToIndex).toHaveBeenCalledWith({
      index: 9,
      align: "start",
      behavior: "auto",
      offset: -(16 + leg),
    });

    // The virtualizer places the row a leg away; the library is then told to stop.
    view.scroller.scrollTop = 12_000 - (16 + leg);
    view.mountRow();
    view.frame();
    expect(view.cancelPendingNavigation).toHaveBeenCalled();
    view.run(400);
    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
    expect(view.controller.currentOwner).toBeNull();
  });

  test("a distant row near the end still decelerates into where the transcript stops", () => {
    // The last prompt: the transcript ends before it can reach the requested offset.
    const view = harness({ rendered: false, rowTop: CONTENT - 200 });
    glide(view);
    view.run(256);
    // The virtualizer lands past the end of the transcript's reach for that row.
    view.scroller.scrollTop = CONTENT - VIEWPORT;
    view.mountRow();

    const steps: number[] = [];
    for (let elapsed = 0; elapsed < 320; elapsed += 16) {
      const before = view.top;
      view.frame();
      steps.push(view.top - before);
    }
    expect(CONTENT - VIEWPORT - view.top).toBeLessThanOrEqual(1);
    // A whole leg back, then down into the end, slowing all the way.
    const moving = steps.filter((step) => step > 0);
    expect(moving.length).toBeGreaterThan(6);
    expect(moving.at(-1)!).toBeLessThan(moving[0]! / 4);
  });

  test("a distant row above departs upwards", () => {
    const view = harness({ rendered: false });
    view.controller.glideTo({ kind: "row", index: 2, key: "prompt", offsetPx: 16 }, "row");
    const start = view.top;
    view.run(128);
    expect(view.top).toBeLessThan(start);
  });

  test("the reader's own scrolling stops a glide where it stands", () => {
    const view = harness();
    glide(view);
    view.run(160);
    view.scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
    expect(view.controller.currentOwner).toBeNull();
    const stopped = view.top;
    view.run(600);
    expect(view.top).toBe(stopped);
  });

  test("an unmounted destination retries within a bounded budget and ignores a late mount", () => {
    const view = harness({ rendered: false });
    glide(view);
    view.run(2400);
    expect(view.scrollToIndex).toHaveBeenCalledTimes(3);
    view.run(200);
    expect(view.controller.currentOwner).toBeNull();
    expect(view.controller.diagnostics().lastOutcome).toBe("unresolved");
    const stopped = view.top;
    view.mountRow();
    view.run(600);
    expect(view.top).toBe(stopped);
    expect(view.cancelPendingNavigation).toHaveBeenCalled();
  });

  for (const phaseMs of [80, 320]) {
    test(`reader input retires unmounted navigation at ${phaseMs}ms`, () => {
      const view = harness({ rendered: false });
      glide(view);
      view.run(phaseMs);
      const lateFrames = view.pendingFrames();
      view.controller.forwardWheel(new WheelEvent("wheel", { deltaY: -40 }));
      for (const callback of lateFrames) callback(performance.now());
      expect(view.controller.diagnostics().staleCallbacksRefused).toBeGreaterThan(0);
      expect(view.controller.currentOwner).toBeNull();
      const stopped = view.top;
      const seeks = view.scrollToIndex.mock.calls.length;
      view.mountRow();
      view.run(3000);
      expect(view.top).toBe(stopped);
      expect(view.scrollToIndex).toHaveBeenCalledTimes(seeks);
      expect(view.controller.diagnostics().lastOutcome).toBe("cancelled");
    });
  }

  test("a seek superseded by another glide cannot resume on a late mount", () => {
    const view = harness({ rendered: false });
    glide(view);
    view.run(320);
    const row = document.createElement("div");
    row.dataset.chatMessageKey = "replacement";
    row.getBoundingClientRect = () => ({ top: 8000 - view.top, height: 80 }) as DOMRect;
    view.scroller.appendChild(row);
    view.controller.glideTo({ kind: "row", index: 4, key: "replacement", offsetPx: 16 }, "row");
    view.mountRow();
    view.run(1000);
    expect(Math.abs(view.top - 7984)).toBeLessThanOrEqual(1);
    expect(view.controller.diagnostics().superseded).toBe(1);
    expect(view.scrollToIndex).toHaveBeenCalledTimes(1);
  });

  test("an upward seek uses the resolved row index and completes its measured final leg", () => {
    const view = harness({ rendered: false, rowTop: 8000 });
    view.controller.setRowIndexResolver(() => 2);
    glide(view); // The stale index is below the neighbour; the key resolves above it.
    view.run(256);
    expect(view.scrollToIndex).toHaveBeenCalledWith({
      index: 2,
      align: "start",
      behavior: "auto",
      offset: 304,
    });
    view.scroller.scrollTop = 8304;
    view.mountRow();
    view.frame();
    view.changeHeightAbove(240);
    view.run(600);
    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
    expect(view.controller.currentOwner).toBeNull();
  });

  test("overscan mounting before mid-departure switches to a whole curve without a seek", () => {
    const view = harness({ rendered: false });
    glide(view);
    view.run(48);
    view.mountRow();
    view.run(800);
    expect(view.scrollToIndex).not.toHaveBeenCalled();
    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
  });

  test("forwarded wheels classify zoom and horizontal input and convert line/page units", () => {
    const view = harness();
    glide(view);
    for (const init of [{ deltaY: 80, ctrlKey: true }, { deltaY: 10, deltaX: 90 }, { deltaY: 0 }]) {
      const event = new WheelEvent("wheel", init);
      for (const [key, value] of Object.entries(init)) Object.defineProperty(event, key, { value });
      view.controller.forwardWheel(event);
      expect(view.controller.currentOwner).toBe("row");
      expect(view.top).toBe(10000);
    }
    view.controller.forwardWheel(new WheelEvent("wheel", { deltaY: -2, deltaMode: 1 }));
    expect(view.top).toBe(9968);
    expect(view.controller.currentOwner).toBeNull();
    view.controller.forwardWheel(new WheelEvent("wheel", { deltaY: 1, deltaMode: 2 }));
    expect(view.top).toBe(10568);
  });

  test("reduced motion goes straight there", () => {
    const view = harness();
    const original = globalThis.matchMedia;
    globalThis.matchMedia = (() => ({ matches: true })) as unknown as typeof matchMedia;
    disposals.push(() => {
      globalThis.matchMedia = original;
    });
    glide(view);
    view.frame();
    expect(Math.abs(view.rowOffset - 16)).toBeLessThanOrEqual(1);
  });

  test("a hidden transcript does not start one", () => {
    const view = harness();
    view.controller.setActive(false);
    expect(glide(view)).toBe(false);
  });
});

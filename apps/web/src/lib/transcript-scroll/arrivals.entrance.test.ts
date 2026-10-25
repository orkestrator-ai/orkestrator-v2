import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  LIVE_ARRIVAL_ATTRIBUTE,
  LIVE_ARRIVAL_WINDOW_MS,
  useLiveArrivalEntrance,
  type LiveArrivalBatch,
} from "./arrivals";

const batch = (): LiveArrivalBatch => ({
  keys: new Set(["row"]),
  stampedAt: null,
  taken: new Set(),
});

function setup({ hidden = false, overflow = false, reduced = false } = {}) {
  const parent = document.createElement("div");
  const element = document.createElement("div");
  parent.append(element);
  document.body.append(parent);
  element.hidden = hidden;
  const rects = spyOn(element, "getClientRects").mockReturnValue(
    (hidden ? [] : [new DOMRect(0, 0, 100, 40)]) as unknown as DOMRectList,
  );
  Object.defineProperties(parent, {
    scrollHeight: { value: overflow ? 200 : 40 },
    clientHeight: { value: 40 },
  });
  spyOn(window, "matchMedia").mockReturnValue({ matches: reduced } as MediaQueryList);
  const ref = { current: element as HTMLElement | null };
  const mount = (arrival: LiveArrivalBatch | null = batch()) =>
    renderHook(({ update }) => useLiveArrivalEntrance(ref, update, "row"), {
      initialProps: { update: arrival },
    });
  return { element, parent, rects, ref, mount };
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  mock.restore();
});

describe("useLiveArrivalEntrance", () => {
  test("skips a hidden element or an element with no layout rects", () => {
    const hidden = setup({ hidden: true });
    hidden.mount();
    expect(hidden.element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
    const zero = setup();
    zero.rects.mockReturnValue([] as unknown as DOMRectList);
    zero.mount();
    expect(zero.element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
  });

  test("skips an already overflowing parent", () => {
    const { element, mount } = setup({ overflow: true });
    mount();
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
  });

  test("honors reduced motion at the hook level", () => {
    const { element, mount } = setup({ reduced: true });
    mount();
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
  });

  test("skips arrivals mounted after the live window", () => {
    const { element, mount } = setup();
    const update = batch();
    update.stampedAt = performance.now() - LIVE_ARRIVAL_WINDOW_MS - 1;
    mount(update);
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
    expect(update.taken.size).toBe(0);
  });

  test("tolerates a missing element or batch", () => {
    const { element, ref, mount } = setup();
    mount(null);
    ref.current = null;
    mount();
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
  });

  test("keeps an active entrance across content updates and newer batches", () => {
    const { element, mount } = setup();
    const update = batch();
    const hook = mount(update);
    const newer = batch();
    hook.rerender({ update: newer });
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(true);
    expect(update.taken.has("row")).toBe(true);
    expect(newer.taken.size).toBe(0);
  });

  test.each(["animationend", "animationcancel"])(
    "%s clears the attribute and keeps a completed key consumed",
    (eventName) => {
      const { element, mount } = setup();
      const update = batch();
      const hook = mount(update);
      const child = element.appendChild(document.createElement("span"));
      act(() => child.dispatchEvent(new Event(eventName, { bubbles: true })));
      expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(true);
      act(() => element.dispatchEvent(new Event(eventName)));
      expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
      hook.unmount();
      expect(update.taken.has("row")).toBe(true);
      mount(update);
      expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
    },
  );

  test("releases an interrupted key and removes its listeners before remount", () => {
    const { element, mount } = setup();
    const update = batch();
    const hook = mount(update);
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(true);
    hook.unmount();
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(false);
    expect(update.taken.size).toBe(0);
    // A stale animation event cannot consume a key after cleanup.
    act(() => element.dispatchEvent(new Event("animationend")));
    mount(update);
    expect(element.hasAttribute(LIVE_ARRIVAL_ATTRIBUTE)).toBe(true);
    expect(update.taken.has("row")).toBe(true);
  });
});

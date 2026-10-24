import { afterEach, describe, expect, test } from "bun:test";
import { classifyKey, classifyWheel, nestedScrollerConsumes } from "./scroll-input";

afterEach(() => {
  document.body.innerHTML = "";
});

function scrollable(
  element: HTMLElement,
  { height, client, top }: { height: number; client: number; top: number },
) {
  element.style.overflowY = "auto";
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: height });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: client });
  element.scrollTop = top;
}

function setup() {
  const scroller = document.createElement("div");
  const inner = document.createElement("pre");
  const leaf = document.createElement("span");
  inner.appendChild(leaf);
  scroller.appendChild(inner);
  document.body.appendChild(scroller);
  return { scroller, inner, leaf };
}

function wheelOn(target: Element, init: WheelEventInit) {
  const event = new WheelEvent("wheel", { bubbles: true, ...init });
  // happy-dom drops some inherited init fields; state them on the event.
  Object.defineProperty(event, "target", { value: target });
  Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey ?? false });
  Object.defineProperty(event, "deltaX", { value: init.deltaX ?? 0 });
  Object.defineProperty(event, "deltaY", { value: init.deltaY ?? 0 });
  return event;
}

describe("classifyWheel", () => {
  test("reports both directions for the transcript", () => {
    const { scroller, leaf } = setup();
    expect(classifyWheel(wheelOn(leaf, { deltaY: 40 }), scroller)).toBe("down");
    expect(classifyWheel(wheelOn(leaf, { deltaY: -40 }), scroller)).toBe("up");
  });

  test("ignores pinch-zoom and mostly horizontal motion", () => {
    const { scroller, leaf } = setup();
    expect(classifyWheel(wheelOn(leaf, { deltaY: 40, ctrlKey: true }), scroller)).toBeNull();
    expect(classifyWheel(wheelOn(leaf, { deltaY: 10, deltaX: 40 }), scroller)).toBeNull();
    expect(classifyWheel(wheelOn(leaf, { deltaY: 0 }), scroller)).toBeNull();
  });

  test("a nested scroller that can move that way consumes the wheel", () => {
    const { scroller, inner, leaf } = setup();
    scrollable(inner, { height: 600, client: 200, top: 100 });
    expect(classifyWheel(wheelOn(leaf, { deltaY: 40 }), scroller)).toBeNull();
    expect(classifyWheel(wheelOn(leaf, { deltaY: -40 }), scroller)).toBeNull();
  });

  test("at its edge a nested scroller chains to the transcript unless containment forbids it", () => {
    const { scroller, inner, leaf } = setup();
    scrollable(inner, { height: 600, client: 200, top: 0 });
    expect(classifyWheel(wheelOn(leaf, { deltaY: -40 }), scroller)).toBe("up");
    inner.style.overscrollBehaviorY = "contain";
    expect(nestedScrollerConsumes(wheelOn(leaf, { deltaY: -40 }), scroller, "up")).toBe(true);
  });
});

describe("classifyKey", () => {
  function key(target: Element, init: KeyboardEventInit) {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, "target", { value: target });
    return event;
  }

  test("scroll keys targeted inside the transcript", () => {
    const { scroller, leaf } = setup();
    for (const [name, direction] of [
      ["ArrowUp", "up"],
      ["PageUp", "up"],
      ["Home", "up"],
      ["ArrowDown", "down"],
      ["PageDown", "down"],
      ["End", "down"],
    ] as const) {
      expect(classifyKey(key(leaf, { key: name }), scroller, false)).toBe(direction);
    }
    expect(classifyKey(key(leaf, { key: " " }), scroller, false)).toBe("down");
    expect(classifyKey(key(leaf, { key: " ", shiftKey: true }), scroller, false)).toBe("up");
  });

  test("focus on the body scrolls the transcript the reader last clicked", () => {
    const { scroller } = setup();
    expect(classifyKey(key(document.body, { key: "PageDown" }), scroller, true)).toBe("down");
    expect(classifyKey(key(document.body, { key: "PageDown" }), scroller, false)).toBeNull();
  });

  test("editors, prevented events, composition, modifiers and buttons keep their keys", () => {
    const { scroller } = setup();
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    expect(classifyKey(key(composer, { key: "ArrowUp" }), scroller, true)).toBeNull();
    const button = document.createElement("button");
    scroller.appendChild(button);
    expect(classifyKey(key(button, { key: " " }), scroller, true)).toBeNull();
    const prevented = key(scroller, { key: "End" });
    prevented.preventDefault();
    expect(classifyKey(prevented, scroller, true)).toBeNull();
    expect(classifyKey(key(scroller, { key: "End", metaKey: true }), scroller, true)).toBeNull();
    expect(classifyKey(key(scroller, { key: "a" }), scroller, true)).toBeNull();
  });

  test("an open modal outside the transcript owns the keyboard", () => {
    const { scroller } = setup();
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    expect(classifyKey(key(document.body, { key: "PageDown" }), scroller, true)).toBeNull();
  });
});

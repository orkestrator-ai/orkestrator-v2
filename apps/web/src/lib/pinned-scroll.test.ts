import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pinLayoutRootScroll, PINNED_SCROLL_ATTRIBUTE, pinnedScroll } from "./pinned-scroll";

/** Scrolls `element` the way the browser does: offset first, then the event. */
function scroll(element: Element, top: number, left = 0, target: EventTarget = element) {
  element.scrollTop = top;
  element.scrollLeft = left;
  target.dispatchEvent(new Event("scroll"));
}

describe("pinLayoutRootScroll", () => {
  let stop: (() => void) | null = null;
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    stop = pinLayoutRootScroll(document);
  });

  afterEach(() => {
    stop?.();
    stop = null;
    root.remove();
  });

  test("undoes a scroll of html, body and #root", () => {
    for (const element of [document.documentElement, document.body, root]) {
      scroll(element, 440, 12);
      expect(element.scrollTop).toBe(0);
      expect(element.scrollLeft).toBe(0);
    }
  });

  test("undoes the viewport's scroll, which is reported on the document", () => {
    const viewport = document.scrollingElement ?? document.documentElement;
    scroll(viewport, 300, 0, document);
    expect(viewport.scrollTop).toBe(0);
  });

  test("undoes a scroll of an element marked as pinned", () => {
    const shell = document.createElement("div");
    shell.setAttribute(PINNED_SCROLL_ATTRIBUTE, "");
    root.appendChild(shell);
    scroll(shell, 250);
    expect(shell.scrollTop).toBe(0);
    expect(pinnedScroll).toEqual({ [PINNED_SCROLL_ATTRIBUTE]: "" });
  });

  test("leaves every other scroller alone", () => {
    const list = document.createElement("div");
    root.appendChild(list);
    scroll(list, 250);
    expect(list.scrollTop).toBe(250);
  });

  test("stops pinning once its owner stops it", () => {
    stop?.();
    stop = null;
    scroll(root, 440);
    expect(root.scrollTop).toBe(440);
  });
});

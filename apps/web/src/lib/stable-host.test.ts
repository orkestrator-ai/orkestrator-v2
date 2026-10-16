import { afterEach, describe, expect, test } from "bun:test";
import { parkHost, placeHost } from "./stable-host";

/**
 * Happy DOM has no `moveBefore` and keeps scroll offsets through
 * `appendChild`. Browsers without `moveBefore` reset them, so the fallback
 * cases emulate that reset to prove the offsets are put back.
 */
function resetScrollOnAppend(parent: HTMLElement) {
  const append = parent.appendChild.bind(parent);
  parent.appendChild = <T extends Node>(node: T): T => {
    if (node instanceof Element) {
      for (const element of [node, ...Array.from(node.querySelectorAll("*"))]) {
        element.scrollTop = 0;
        element.scrollLeft = 0;
      }
    }
    return append(node);
  };
}

/** Detaching a node drops the selection inside it. */
function resetSelectionOnAppend(parent: HTMLElement) {
  const append = parent.appendChild.bind(parent);
  parent.appendChild = <T extends Node>(node: T): T => {
    const selection = document.getSelection();
    if (selection?.anchorNode && node.contains(selection.anchorNode)) selection.removeAllRanges();
    return append(node);
  };
}

/** Chromium's `moveBefore` keeps focus and scroll offsets but collapses a selection inside the node. */
function withMoveBefore(parent: HTMLElement, moves: Array<[Node, Node | null]>) {
  Object.defineProperty(parent, "moveBefore", {
    configurable: true,
    value(node: Node, child: Node | null) {
      moves.push([node, child]);
      parent.insertBefore(node, child);
      const selection = document.getSelection();
      if (selection?.anchorNode && node.contains(selection.anchorNode)) {
        selection.collapse(parent, 0);
      }
    },
  });
}

function buildHost() {
  const host = document.createElement("div");
  host.innerHTML = `<div data-scroller></div><textarea></textarea><p contenteditable="true">draft text</p>`;
  return {
    host,
    scroller: host.querySelector<HTMLElement>("[data-scroller]")!,
    textarea: host.querySelector("textarea")!,
    paragraph: host.querySelector<HTMLElement>("p")!,
  };
}

function slot() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("stable hosts", () => {
  test("moves a connected host with moveBefore, which keeps state natively", () => {
    const { host } = buildHost();
    const from = slot();
    const park = slot();
    const to = slot();
    from.appendChild(host);
    const parkMoves: Array<[Node, Node | null]> = [];
    const slotMoves: Array<[Node, Node | null]> = [];
    withMoveBefore(park, parkMoves);
    withMoveBefore(to, slotMoves);

    parkHost(host, park);
    placeHost(host, to);

    expect(parkMoves).toEqual([[host, null]]);
    expect(slotMoves).toEqual([[host, null]]);
    expect(host.parentNode).toBe(to);
  });

  test("puts back the caret of an editable element that moveBefore collapses", () => {
    const { host, paragraph } = buildHost();
    const from = slot();
    const park = slot();
    const to = slot();
    from.appendChild(host);
    withMoveBefore(park, []);
    withMoveBefore(to, []);
    paragraph.focus();
    const text = paragraph.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 8, text, 3);

    parkHost(host, park);
    placeHost(host, to);

    const selection = document.getSelection()!;
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([text, 8]);
    expect([selection.focusNode, selection.focusOffset]).toEqual([text, 3]);
  });

  test("falls back to appendChild for a detached host, which moveBefore rejects", () => {
    const { host } = buildHost();
    const to = slot();
    const moves: Array<[Node, Node | null]> = [];
    withMoveBefore(to, moves);

    placeHost(host, to);

    expect(moves).toEqual([]);
    expect(host.parentNode).toBe(to);
  });

  test("puts back scroll offsets, focus and the caret through a fallback park", () => {
    const { host, scroller, textarea } = buildHost();
    const from = slot();
    const park = slot();
    const to = slot();
    resetScrollOnAppend(park);
    resetScrollOnAppend(to);
    from.appendChild(host);
    scroller.scrollTop = 240;
    scroller.scrollLeft = 12;
    textarea.value = "unsent draft";
    textarea.focus();
    textarea.setSelectionRange(3, 6);

    parkHost(host, park);
    // A park is invisible, so focus cannot be put back until a slot holds the host.
    textarea.blur();
    placeHost(host, to);

    expect(host.parentNode).toBe(to);
    expect(scroller.scrollTop).toBe(240);
    expect(scroller.scrollLeft).toBe(12);
    expect(document.activeElement).toBe(textarea);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([3, 6]);
    expect(textarea.value).toBe("unsent draft");
  });

  test("puts back a text selection inside an editable element", () => {
    const { host, paragraph } = buildHost();
    const from = slot();
    const to = slot();
    from.appendChild(host);
    paragraph.focus();
    const text = paragraph.firstChild!;
    document.getSelection()!.setBaseAndExtent(text, 2, text, 5);
    resetSelectionOnAppend(to);

    placeHost(host, to);

    const selection = document.getSelection()!;
    expect([selection.anchorNode, selection.anchorOffset]).toEqual([text, 2]);
    expect([selection.focusNode, selection.focusOffset]).toEqual([text, 5]);
    expect(document.activeElement).toBe(paragraph);
  });

  test("leaves a host that is already in its slot alone", () => {
    const { host } = buildHost();
    const to = slot();
    to.appendChild(host);
    const moves: Array<[Node, Node | null]> = [];
    withMoveBefore(to, moves);

    placeHost(host, to);

    expect(moves).toEqual([]);
    expect(host.parentNode).toBe(to);
  });
});

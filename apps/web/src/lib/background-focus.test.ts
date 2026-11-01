import { afterEach, describe, expect, test } from "bun:test";
import { isFocusHeldElsewhere } from "./background-focus";

function mount(html: string): void {
  document.body.innerHTML = html;
}

function focus(id: string): void {
  (document.getElementById(id) as HTMLElement).focus();
}

describe("isFocusHeldElsewhere", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("nothing focused, or a plain control focused, does not hold focus", () => {
    mount(`<button id="tab">Tab</button><div id="composer" tabindex="0"></div>`);
    const composer = document.getElementById("composer");
    expect(isFocusHeldElsewhere(composer)).toBe(false);
    focus("tab");
    expect(isFocusHeldElsewhere(composer)).toBe(false);
    expect(isFocusHeldElsewhere()).toBe(false);
  });

  test("an open dialog, alert or menu holds focus", () => {
    for (const role of ["dialog", "alertdialog", "menu"]) {
      mount(
        `<section role="${role}" aria-hidden="false"><button id="close">Close</button></section>` +
          `<div id="composer" tabindex="0"></div>`,
      );
      focus("close");
      expect(isFocusHeldElsewhere(document.getElementById("composer"))).toBe(true);
      expect(isFocusHeldElsewhere()).toBe(true);
    }
  });

  test("a closing or hidden surface no longer holds focus", () => {
    mount(
      `<div role="dialog" data-state="closed"><button id="closing">Launch</button></div>` +
        `<section role="dialog" aria-hidden="true"><button id="hidden">Close</button></section>`,
    );
    focus("closing");
    expect(isFocusHeldElsewhere()).toBe(false);
    focus("hidden");
    expect(isFocusHeldElsewhere()).toBe(false);
  });

  test("an open surface around a closed one still holds focus", () => {
    mount(
      `<div role="dialog" data-state="open">` +
        `<div role="menu" data-state="closed"><button id="item">Item</button></div></div>`,
    );
    focus("item");
    expect(isFocusHeldElsewhere()).toBe(true);
  });

  test("a target inside the focused surface, or holding focus itself, may take it", () => {
    mount(
      `<div role="dialog"><button id="action">Send</button>` +
        `<div id="composer" tabindex="0"><span id="inner" tabindex="0"></span></div></div>`,
    );
    const composer = document.getElementById("composer");
    focus("action");
    expect(isFocusHeldElsewhere(composer)).toBe(false);
    focus("composer");
    expect(isFocusHeldElsewhere(composer)).toBe(false);
    focus("inner");
    expect(isFocusHeldElsewhere(composer)).toBe(false);
  });
});

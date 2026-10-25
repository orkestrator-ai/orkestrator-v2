import { describe, expect, test, mock } from "bun:test";
import type { WebAnnotationTarget } from "@orkestrator/protocol/web-annotations";
import type { HTMLElement, Element } from "happy-dom";
import {
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  BROWSER_PREVIEW_PINS_CLEAR_SCRIPT,
  browserPreviewPinsShowScript,
  type BrowserPreviewPinsScriptLimits,
} from "../electron/browser-preview-pins-script";
import { BrowserPreviewPinSessions } from "../electron/browser-preview-capture-pins";
import { captureElement, page, type Json } from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;

const FAST: Partial<BrowserPreviewPinsScriptLimits> = { throttleMs: 20, maxPasses: 50 };

function show(
  harness: Harness,
  queries: Array<{ annotationId: string; number: number; label: string; target: unknown }>,
  limits: Partial<BrowserPreviewPinsScriptLimits> = FAST,
): Json {
  return JSON.parse(
    harness.window.eval(
      browserPreviewPinsShowScript({
        queries,
        focusedAnnotationId: null,
        scrollIntoView: false,
        limits,
      }),
    ) as string,
  ) as Json;
}

function snapshot(harness: Harness): Json {
  return JSON.parse(harness.window.eval(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT) as string) as Json;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function badges(harness: Harness): HTMLElement[] {
  return Array.from(
    harness.document.querySelectorAll<HTMLElement>("[data-orkestrator-pins] [role='img']"),
  );
}

describe("live pin layer", () => {
  test("pins have target-specific accessible names and stay out of the tab order", () => {
    const harness = page(`<button data-testid="save">Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    show(harness, [{ annotationId: "annotation-1", number: 7, label: target.label, target }]);
    const layer = harness.document.querySelector("[data-orkestrator-pins]")!;
    expect(layer.getAttribute("role")).toBe("group");
    expect(layer.getAttribute("aria-label")).toBe("Orkestrator annotation pins");
    const [badge] = badges(harness);
    expect(badge!.getAttribute("aria-label")).toBe("Annotation 7: button “Save”");
    expect(badge!.hasAttribute("tabindex")).toBe(false);
    expect(badge!.style.display).toBe("block");
    const outline = badge!.previousElementSibling!;
    expect(outline.getAttribute("aria-hidden")).toBe("true");
  });

  test("a matched target that renders no box (a closed dialog) gets no pin", () => {
    const harness = page(`<dialog><button data-testid="confirm">Save</button></dialog>`);
    const button = harness.document.querySelector("button")!;
    const target = captureElement(harness, button);
    // Chromium's answer for an element inside a closed <dialog>.
    Object.assign(button, { checkVisibility: () => false });
    const result = show(harness, [
      { annotationId: "annotation-1", number: 1, label: target.label, target },
    ]);
    expect(result.results[0]).toMatchObject({ state: "matched", rule: "stable-id" });
    expect(badges(harness)[0]!.style.display).toBe("none");
    Object.assign(button, { checkVisibility: () => true });
    show(harness, [{ annotationId: "annotation-1", number: 1, label: target.label, target }]);
    expect(badges(harness).at(-1)!.style.display).toBe("block");
  });

  test("a font swap that reflows the page without a DOM mutation moves the drawn pin", async () => {
    const harness = page(`<h1>Release notes</h1><button data-testid="read">Read</button>`);
    const button = harness.document.querySelector("button")!;
    let top = 40;
    Object.assign(button, {
      getBoundingClientRect: () => ({ left: 10, top, width: 80, height: 24, x: 10, y: top }),
    });
    const fonts = new harness.window.EventTarget();
    Object.defineProperty(harness.document, "fonts", { value: fonts, configurable: true });
    const target = captureElement(harness, button);
    const events: unknown[] = [];
    const sessions = new BrowserPreviewPinSessions({
      livePollIntervalMs: 0,
      emit: (event) => events.push(event),
      preview: () => ({
        generation: 1,
        visible: true,
        contents: {
          executeJavaScript: async (script) => harness.window.eval(script),
          capturePage: async () => {
            throw new Error("unused");
          },
          getURL: () => "http://localhost:3000/dashboard",
          isDestroyed: () => false,
        },
      }),
    });
    const [initial] = await sessions.showPins({
      tabId: "browser-1",
      pins: [
        {
          annotationId: "annotation-1",
          number: 1,
          route: "/dashboard",
          target: target as WebAnnotationTarget,
        },
      ],
    });
    expect(initial!.resolution.rect).toMatchObject({ y: 40 });
    const before = snapshot(harness);
    const outline = badges(harness)[0]!.previousElementSibling as HTMLElement;
    expect(outline.style.top).toBe("40px");
    // The web font arrives: the heading grows and the button moves down.
    top = 84;
    fonts.dispatchEvent(new harness.window.Event("loadingdone"));
    await wait(50);
    expect(outline.style.top).toBe("84px");
    expect(snapshot(harness).results[0].rect).toMatchObject({ y: 84 });
    expect(snapshot(harness).revision).toBe(before.revision + 1);
    expect(snapshot(harness).diagnostics.passes).toBe(before.diagnostics.passes);
    await sessions.pollOnce();
    expect((await sessions.getPinResults("browser-1"))!.results[0]!.resolution.rect).toMatchObject({
      y: 84,
    });
    expect(events).toEqual([expect.objectContaining({ status: "pins-changed" })]);
    await sessions.pollOnce();
    expect(events).toHaveLength(1);
    await sessions.clearPins("browser-1");
    sessions.dispose();
  });

  test("document resize alone redraws pins and destroy disconnects the observer", async () => {
    const harness = page(`<button data-testid="read">Read</button>`);
    const button = harness.document.querySelector("button")!;
    let top = 40;
    Object.assign(button, {
      getBoundingClientRect: () => ({ left: 10, top, width: 80, height: 24 }),
    });
    let resized = () => {};
    const observe = mock((_element: Element) => {});
    const disconnect = mock(() => {});
    Object.defineProperty(harness.window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe = observe;
        disconnect = disconnect;
      },
    });
    const target = captureElement(harness, button);
    const before = show(harness, [
      { annotationId: "annotation-1", number: 1, label: target.label, target },
    ]);
    expect(observe.mock.calls.map((call) => call[0])).toEqual([
      harness.document.documentElement,
      harness.document.body,
    ]);
    top = 100;
    resized();
    resized();
    await wait(50);
    const after = snapshot(harness);
    expect(after.results[0].rect.y).toBe(100);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.diagnostics.passes).toBe(before.diagnostics.passes);
    const outline = badges(harness)[0]!.previousElementSibling as HTMLElement;
    harness.window.eval(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
    expect(disconnect).toHaveBeenCalledTimes(1);
    top = 200;
    resized();
    await wait(50);
    expect(outline.style.top).toBe("100px");
    expect(badges(harness)).toHaveLength(0);
  });

  test("a replaced element (hot reload) is re-resolved and the pin follows the new node", async () => {
    const markup = `<main><h2>Settings</h2><button data-testid="save">Save</button></main>`;
    const harness = page(markup);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    const initial = show(harness, [
      { annotationId: "annotation-1", number: 1, label: target.label, target },
    ]);
    expect(initial.results[0]).toMatchObject({ state: "matched", rule: "stable-id" });
    const before = initial.revision;

    // Hot module replacement swaps the DOM without a navigation.
    harness.document.body.innerHTML = markup;
    await wait(80);

    const after = snapshot(harness);
    expect(after.revision).toBeGreaterThan(before);
    expect(after.results[0]).toMatchObject({ state: "matched", rule: "stable-id" });
    expect(after.diagnostics.passes).toBeGreaterThanOrEqual(2);
    expect(badges(harness)[0]!.style.display).toBe("block");
  });

  test("a target that renders late is matched once it appears; a removed one is hidden", async () => {
    const harness = page(`<main><button data-testid="save">Save</button></main>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<main></main>`;
    const initial = show(harness, [
      { annotationId: "annotation-1", number: 1, label: target.label, target },
    ]);
    expect(initial.results[0].state).toBe("missing");
    expect(badges(harness)[0]!.style.display).toBe("none");

    harness.document.querySelector("main")!.innerHTML = `<button data-testid="save">Save</button>`;
    await wait(80);
    expect(snapshot(harness).results[0].state).toBe("matched");
    expect(badges(harness)[0]!.style.display).toBe("block");

    harness.document.querySelector("main")!.innerHTML = ``;
    await wait(80);
    expect(snapshot(harness).results[0].state).toBe("missing");
    expect(badges(harness)[0]!.style.display).toBe("none");
  });

  test("a mutation storm is coalesced, throttled, and capped", async () => {
    const harness = page(
      `<main><ul id="feed"></ul><button data-testid="save">Save</button></main>`,
    );
    const target = captureElement(harness, harness.document.querySelector("button")!);
    show(harness, [{ annotationId: "annotation-1", number: 1, label: target.label, target }], {
      throttleMs: 30,
      maxPasses: 3,
    });
    const feed = harness.document.getElementById("feed")!;
    for (let burst = 0; burst < 6; burst += 1) {
      for (let index = 0; index < 500; index += 1) {
        const item = harness.document.createElement("li");
        item.textContent = `update ${burst}-${index}`;
        feed.append(item);
        if (feed.children.length > 50) feed.firstElementChild!.remove();
      }
      await wait(45);
    }
    await wait(60);
    const { diagnostics } = snapshot(harness);
    // 3,000 insertions and removals: one initial pass plus at most the allowance.
    expect(diagnostics.passes).toBeLessThanOrEqual(1 + 3);
    expect(diagnostics.mutationBatches).toBeGreaterThan(0);
    expect(diagnostics.mutationBatches).toBeLessThan(3_000);
    expect(diagnostics.paused).toBe(true);
    // Counters are content-free: no selector or page text.
    expect(JSON.stringify(diagnostics)).not.toContain("Save");
    expect(JSON.stringify(diagnostics)).not.toContain("update");
    expect(diagnostics.byState).toEqual({ matched: 1 });
    expect(diagnostics.byRule).toEqual({ "stable-id": 1 });
  });

  test("no resolution work happens while the document is hidden", async () => {
    const harness = page(`<main><button data-testid="save">Save</button></main>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    show(harness, [{ annotationId: "annotation-1", number: 1, label: target.label, target }]);
    let visibility = "hidden";
    Object.defineProperty(harness.document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    harness.document.body.append(harness.document.createElement("div"));
    await wait(60);
    expect(snapshot(harness).diagnostics.passes).toBe(1);
    visibility = "visible";
    harness.document.dispatchEvent(new harness.window.Event("visibilitychange"));
    await wait(60);
    expect(snapshot(harness).diagnostics.passes).toBe(2);
  });

  test("the layer's own and the capture runtime's overlays do not trigger passes", async () => {
    const harness = page(`<main><button data-testid="save">Save</button></main>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    show(harness, [{ annotationId: "annotation-1", number: 1, label: target.label, target }]);
    harness.start("element");
    await wait(60);
    expect(snapshot(harness).diagnostics).toMatchObject({ passes: 1, mutationBatches: 0 });
  });
});

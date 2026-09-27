import { describe, expect, test } from "bun:test";
import {
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  browserPreviewPinsShowScript,
  type BrowserPreviewPinsScriptLimits,
} from "../../../apps/desktop/electron/browser-preview-pins-script";
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

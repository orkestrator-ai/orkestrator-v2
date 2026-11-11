/**
 * Shadow-root annotation follow-ups (todo 2580, retired): sensitive fields inside open
 * shadow roots are masked in screenshots, failing closed when the scan cannot
 * finish, and a pin whose host is defined (and attaches its root) after pins
 * were shown resolves without waiting for an unrelated DOM change.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { Element, ShadowRoot } from "happy-dom";
import { WEB_ANNOTATION_MAX_SHADOW_DEPTH } from "@orkestrator/protocol/web-annotations";
import { browserPreviewAnchorKit } from "../electron/browser-preview-anchor-script";
import { BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT } from "../electron/browser-preview-annotation-script";
import {
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  BROWSER_PREVIEW_PINS_CLEAR_SCRIPT,
  BROWSER_PREVIEW_PINS_KEY,
  browserPreviewPinsShowScript,
  type BrowserPreviewPinsScriptLimits,
} from "../electron/browser-preview-pins-script";
import { browserPreviewResponsiveProbeScript } from "../electron/browser-preview-capture-responsive";
import { browserPreviewCaptureProbeScript } from "../electron/browser-preview-annotation-script";
import { click, page, setRect, type Json } from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;
type Rect = { x: number; y: number; width: number; height: number };
type Kit = {
  createBudget: (visits: number, milliseconds: number) => unknown;
  sensitiveScan: (budget?: unknown) => { rects: Rect[]; complete: boolean };
};

const kitIn = (harness: Harness): Kit =>
  harness.window.eval(`(${browserPreviewAnchorKit.toString()})()`) as Kit;

const isMask = (node: { style: { background: string } }) =>
  node.style.background === "rgb(31, 35, 40)" || node.style.background === "#1f2328";

describe("sensitive-field masks inside open shadow roots", () => {
  test("prepare masks fields in open and nested open roots, in tree order", async () => {
    const harness = page(`
      <input type="password" id="pw">
      <x-form></x-form>
      <x-vault></x-vault>
      <button id="go">Go</button>`);
    const form = harness.document.querySelector("x-form")!.attachShadow({ mode: "open" });
    form.innerHTML = `
      <input type="password" id="inner-pw">
      <x-card></x-card>
      <input type="password" id="offscreen">
      <input type="hidden" id="hidden" data-sensitive>`;
    const card = form.querySelector("x-card")!.attachShadow({ mode: "open" });
    card.innerHTML = `<input autocomplete="cc-number" id="card"><input autocomplete="one-time-code" id="otp">`;
    // A closed root is invisible to page script: a known limitation.
    const vault = harness.document.querySelector("x-vault")!.attachShadow({ mode: "closed" });
    vault.innerHTML = `<input type="password" id="closed">`;
    const rects: Record<string, Rect> = {
      pw: { x: 10, y: 10, width: 100, height: 20 },
      "inner-pw": { x: 10, y: 40, width: 100, height: 20 },
      card: { x: 10, y: 70, width: 100, height: 20 },
      otp: { x: 10, y: 100, width: 100, height: 20 },
      offscreen: { x: 10, y: 5_000, width: 100, height: 20 },
      hidden: { x: 10, y: 130, width: 100, height: 20 },
      closed: { x: 10, y: 160, width: 100, height: 20 },
      go: { x: 200, y: 10, width: 40, height: 20 },
    };
    for (const [id, rect] of Object.entries(rects)) {
      const element =
        harness.document.getElementById(id) ??
        form.querySelector(`#${id}`) ??
        card.querySelector(`#${id}`) ??
        vault.querySelector(`#${id}`);
      setRect(element!, rect);
    }
    harness.start("element");
    click(harness, harness.document.getElementById("go")!);

    const probe = (await harness.prepare())!;

    expect(probe.sensitive).toEqual([rects.pw, rects["inner-pw"], rects.card, rects.otp]);
    expect(probe.sensitiveComplete).toBe(true);
    expect(harness.ui().filter(isMask)).toHaveLength(4);
  });

  test("a shadow field attached after prepare appears in the post-capture probe", async () => {
    const harness = page(`<x-form></x-form><button id="go">Go</button>`);
    harness.start("element");
    click(harness, harness.document.getElementById("go")!);
    expect((await harness.prepare())!.sensitive).toEqual([]);
    const root = harness.document.querySelector("x-form")!.attachShadow({ mode: "open" });
    root.innerHTML = `<input type="password">`;
    const rect = { x: 10, y: 40, width: 100, height: 20 };
    setRect(root.querySelector("input")!, rect);

    const after = JSON.parse(
      harness.window.eval(browserPreviewCaptureProbeScript("capture-1")) as string,
    );
    expect(after.sensitive).toEqual([rect]);
    expect(after.sensitiveComplete).toBe(true);
  });

  test.each([1, 33])(
    "responsive page script delivers scan rectangles and completeness for %i fields",
    async (count) => {
      const harness = page(`<x-form></x-form>`);
      const root = harness.document.querySelector("x-form")!.attachShadow({ mode: "open" });
      root.innerHTML = Array.from({ length: count }, () => `<input type="password">`).join("");
      const rect = { x: 10, y: 40, width: 100, height: 20 };
      for (const input of root.querySelectorAll("input")) setRect(input, rect);
      const encoded = await harness.window.eval(
        browserPreviewResponsiveProbeScript({
          target: null,
          deadlineMs: 100,
          quietMs: 1,
        }),
      );
      const probe = JSON.parse(encoded as string);
      expect(probe.sensitive).toEqual(Array.from({ length: Math.min(count, 32) }, () => rect));
      expect(probe.sensitiveComplete).toBe(count <= 32);
      expect(probe.viewport).toEqual({ width: 1024, height: 768 });
      expect(probe.state).toBe("none");
    },
  );

  test("a page with no sensitive fields and no roots scans complete", () => {
    const harness = page(`<main><p>Hello</p><button>Go</button></main>`);
    expect(kitIn(harness).sensitiveScan()).toEqual({ rects: [], complete: true });
  });

  test("an exhausted budget reports the scan incomplete instead of a partial list", () => {
    const rows = Array.from({ length: 200 }, (_, index) => `<div><span>${index}</span></div>`);
    const harness = page(`${rows.join("")}<x-late-form></x-late-form>`);
    const root = harness.document.querySelector("x-late-form")!.attachShadow({ mode: "open" });
    root.innerHTML = `<input type="password" id="late-pw">`;
    setRect(root.querySelector("#late-pw")!, { x: 10, y: 10, width: 100, height: 20 });
    const kit = kitIn(harness);

    // The field sits past the budget: an empty list must not read as "none".
    expect(kit.sensitiveScan(kit.createBudget(50, 1_000))).toEqual({ rects: [], complete: false });
    expect(kit.sensitiveScan()).toEqual({
      rects: [{ x: 10, y: 10, width: 100, height: 20 }],
      complete: true,
    });
  });

  test("roots nested past the shadow-depth limit make the scan incomplete", () => {
    const build = (levels: number) => {
      const harness = page(`<x-level></x-level>`);
      let host = harness.document.querySelector("x-level")!;
      let root: ShadowRoot | null = null;
      for (let level = 0; level < levels; level += 1) {
        root = host.attachShadow({ mode: "open" });
        root.innerHTML = level === levels - 1 ? `<p>Leaf</p>` : `<x-level></x-level>`;
        host = root.firstElementChild!;
      }
      return harness;
    };
    expect(kitIn(build(WEB_ANNOTATION_MAX_SHADOW_DEPTH)).sensitiveScan().complete).toBe(true);
    expect(kitIn(build(WEB_ANNOTATION_MAX_SHADOW_DEPTH + 1)).sensitiveScan().complete).toBe(false);
  });

  test("more visible fields than can be listed make the scan incomplete", () => {
    const harness = page(`<x-wall></x-wall>`);
    const root = harness.document.querySelector("x-wall")!.attachShadow({ mode: "open" });
    root.innerHTML = Array.from({ length: 33 }, () => `<input type="password">`).join("");
    Array.from(root.querySelectorAll("input")).forEach((input, index) =>
      setRect(input, { x: 0, y: index * 20, width: 50, height: 10 }),
    );
    const scan = kitIn(harness).sensitiveScan();
    expect(scan.rects).toHaveLength(32);
    expect(scan.complete).toBe(false);
  });
});

/** A capture of `#save` inside `<x-late>`'s open root, taken on a page where it was rendered. */
function lateTarget(): Json {
  const harness = page(`<main><x-late></x-late></main>`);
  const root = harness.document.querySelector("x-late")!.attachShadow({ mode: "open" });
  root.innerHTML = `<header><button id="save">Save</button><button id="cancel">Cancel</button></header>`;
  const save = root.querySelector("#save")!;
  Object.defineProperty(root, "elementFromPoint", { value: () => save, configurable: true });
  harness.start("element");
  click(harness, harness.document.querySelector("x-late")!);
  const selection = harness.status().selection as Json;
  harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  expect(selection.target.anchor.scope.kind).toBe("shadow");
  return selection.target as Json;
}

function showPins(
  harness: Harness,
  targets: Json[],
  limits: Partial<BrowserPreviewPinsScriptLimits> = {},
): Json {
  return JSON.parse(
    harness.window.eval(
      browserPreviewPinsShowScript({
        queries: targets.map((target, index) => ({
          annotationId: `annotation-${index + 1}`,
          number: index + 1,
          label: "Save",
          target,
        })),
        focusedAnnotationId: null,
        scrollIntoView: false,
        limits: { throttleMs: 20, maxPasses: 50, ...limits },
      }),
    ) as string,
  ) as Json;
}

const snapshotOf = (harness: Harness): Json =>
  JSON.parse(harness.window.eval(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT) as string) as Json;

async function waitFor(harness: Harness, predicate: (snapshot: Json) => boolean): Promise<Json> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((done) => setTimeout(done, 10));
    const current = snapshotOf(harness);
    if (predicate(current)) return current;
  }
  throw new Error(`pins never reconciled: ${JSON.stringify(snapshotOf(harness))}`);
}

/**
 * An isolated world sees `customElements` as null. happy-dom needs its own
 * registry to create elements, so take away the method the layer would use.
 */
function withoutRegistry(harness: Harness): void {
  Object.defineProperty(harness.window.customElements, "whenDefined", {
    value: undefined,
    configurable: true,
  });
}

const RENDER = `<header><button id="save">Save</button><button id="cancel">Cancel</button></header>`;

describe("pins on hosts that attach their shadow root late", () => {
  test("a host defined after pins were shown is resolved once, without a DOM mutation", async () => {
    const target = lateTarget();
    const harness = page(`<main><x-late></x-late></main>`);
    const shown = showPins(harness, [target, target]);
    expect(shown.results.map((result: Json) => result.state)).toEqual(["missing", "missing"]);
    expect(shown.diagnostics.passes).toBe(1);

    // The definition upgrades the host, which attaches and fills its root.
    // Neither step is a mutation the document observer can see.
    harness.window.eval(`customElements.define("x-late", class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(RENDER)};
      }
    });`);

    const settled = await waitFor(harness, (value) =>
      value.results.every((result: Json) => result.state === "matched"),
    );
    expect(settled.diagnostics.mutationBatches).toBe(0);
    // One tag, one definition: a single pass for both pins.
    expect(settled.diagnostics.passes).toBe(2);
    await new Promise((done) => setTimeout(done, 60));
    expect(snapshotOf(harness).diagnostics.passes).toBe(2);
  });

  test("without customElements (an isolated world) the host's :defined state is checked", async () => {
    const target = lateTarget();
    const harness = page(`<main><x-late></x-late></main>`);
    withoutRegistry(harness);
    const host = harness.document.querySelector("x-late")!;
    // happy-dom never matches `:defined`; Chromium does once the element upgrades.
    let defined = false;
    const matches = host.matches.bind(host);
    Object.defineProperty(host, "matches", {
      value: (selector: string) => (selector === ":defined" ? defined : matches(selector)),
      configurable: true,
    });
    expect(showPins(harness, [target], { definitionCheckMs: 10 }).results[0].state).toBe("missing");

    host.attachShadow({ mode: "open" }).innerHTML = RENDER;
    defined = true;

    const settled = await waitFor(harness, (value) => value.results[0].state === "matched");
    expect(settled.diagnostics.mutationBatches).toBe(0);
    expect(settled.diagnostics.passes).toBe(2);
  });

  test("the :defined check is bounded for a host that never upgrades", async () => {
    const target = lateTarget();
    const harness = page(`<main><x-late></x-late></main>`);
    withoutRegistry(harness);
    const host = harness.document.querySelector("x-late")! as Element;
    let checks = 0;
    const matches = host.matches.bind(host);
    Object.defineProperty(host, "matches", {
      value: (selector: string) => {
        if (selector !== ":defined") return matches(selector);
        checks += 1;
        return false;
      },
      configurable: true,
    });
    showPins(harness, [target], { definitionCheckMs: 5, definitionChecks: 3 });

    await new Promise((done) => setTimeout(done, 120));
    // One read when the resolver reported the host, then three timed checks.
    expect(checks).toBe(4);
    expect(snapshotOf(harness).diagnostics.passes).toBe(1);
  });

  test.each(["clear", "resend"])(
    "%s clears a pending isolated-world definition timer",
    async (action) => {
      const target = lateTarget();
      const harness = page(`<main><x-late></x-late></main>`);
      withoutRegistry(harness);
      const host = harness.document.querySelector("x-late")!;
      const matches = host.matches.bind(host);
      let checks = 0;
      Object.defineProperty(host, "matches", {
        value: (selector: string) => {
          if (selector !== ":defined") return matches(selector);
          checks += 1;
          return false;
        },
      });
      const timers = spyOn(harness.window, "setTimeout");
      const cleared = spyOn(harness.window, "clearTimeout");
      showPins(harness, [target], { definitionCheckMs: 20 });
      const definitionTimer = timers.mock.results.find(
        (_, index) => timers.mock.calls[index]?.[1] === 20,
      )!.value;
      expect(checks).toBe(1);
      if (action === "clear") harness.window.eval(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
      else showPins(harness, []);
      expect(cleared).toHaveBeenCalledWith(definitionTimer);
      await new Promise((done) => setTimeout(done, 80));
      expect(checks).toBe(1);
      if (action === "resend") expect(snapshotOf(harness).diagnostics.passes).toBe(1);
    },
  );

  test.each(["clear", "resend"])(
    "%s prevents a late whenDefined callback scheduling work",
    async (action) => {
      const target = lateTarget();
      const harness = page(`<main><x-late></x-late></main>`);
      let resolveDefinition!: () => void;
      let registrations = 0;
      Object.defineProperty(harness.window.customElements, "whenDefined", {
        value: () => {
          registrations += 1;
          return new Promise<void>((resolve) => {
            resolveDefinition = resolve;
          });
        },
      });
      showPins(harness, [target]);
      expect(registrations).toBe(1);
      const runtime = (harness.window as unknown as Record<string, { snapshot: () => string }>)[
        BROWSER_PREVIEW_PINS_KEY
      ];
      if (action === "clear") harness.window.eval(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
      else showPins(harness, []);
      resolveDefinition();
      await new Promise((done) => setTimeout(done, 80));
      expect(JSON.parse(runtime!.snapshot()).diagnostics.passes).toBe(1);
      if (action === "resend") expect(snapshotOf(harness).diagnostics.passes).toBe(1);
    },
  );

  test("a built-in host without a root is not waited on", async () => {
    const target = lateTarget();
    const builtIn = {
      ...target,
      anchor: {
        ...target.anchor,
        scope: {
          kind: "shadow",
          hosts: [{ tagName: "section", cssPath: "html > body > main > section" }],
        },
      },
    };
    const harness = page(`<main><section></section></main>`);
    let registered = 0;
    const registry = harness.window.customElements;
    const whenDefined = registry.whenDefined.bind(registry);
    Object.defineProperty(registry, "whenDefined", {
      value: (name: string) => {
        registered += 1;
        return whenDefined(name);
      },
      configurable: true,
    });
    expect(showPins(harness, [builtIn]).results[0].state).toBe("missing");
    expect(registered).toBe(0);
  });
});

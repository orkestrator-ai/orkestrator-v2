/**
 * Element targets inside open shadow roots (todo 0047 task 5): hit-testing
 * descends into open roots, the anchor carries the root path, and the
 * resolver re-finds the element by resolving each host and then running the
 * ordinary rules inside the innermost root. Closed roots and frames keep the
 * old behaviour.
 */
import { describe, expect, test } from "bun:test";
import type { Element, ShadowRoot } from "happy-dom";
import { WEB_ANNOTATION_MAX_SHADOW_DEPTH } from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationTarget } from "@orkestrator/protocol/web-annotations-validation";
import { browserPreviewAnchorKit } from "../electron/browser-preview-anchor-script";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCaptureStartScript,
} from "../electron/browser-preview-annotation-script";
import { parseCaptureRuntimeStatus } from "../electron/browser-preview-capture-parse";
import {
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  browserPreviewPinsShowScript,
} from "../electron/browser-preview-pins-script";
import { click, key, page, setRect, visiblePins, type Json } from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;

/** Attach an open (or closed) shadow root with `html` to the element matching `selector`. */
function shadow(
  harness: Harness,
  selector: string,
  html: string,
  mode: "open" | "closed" = "open",
  within: { querySelector: (selector: string) => Element | null } = harness.document,
): ShadowRoot {
  const host = within.querySelector(selector)!;
  const root = host.attachShadow({ mode });
  root.innerHTML = html;
  return root;
}

/**
 * A browser retargets a hit inside a shadow root to its host at the document
 * level and reports the real element only from that root. The harness mocks
 * the document's hit test; this mocks a root's.
 */
function hitInRoot(root: ShadowRoot, element: Element | null) {
  Object.defineProperty(root, "elementFromPoint", { value: () => element, configurable: true });
}

function selectAt(harness: Harness, documentHit: Element): Json {
  harness.start("element");
  click(harness, documentHit);
  const status = harness.status();
  expect(status.status).toBe("selected");
  return status.selection;
}

function captureAt(harness: Harness, documentHit: Element): Json {
  const selection = selectAt(harness, documentHit);
  harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  return selection.target as Json;
}

function resolve(harness: Harness, target: Json): Json {
  return harness.pins([{ annotationId: "annotation-1", number: 1, target }])[0]!;
}

const SHELL = `<main><app-shell id="shell"></app-shell></main><button id="save">Outside</button>`;
const SHELL_ROOT = `<header><button id="save">Save</button><button>Cancel</button></header>`;

function shellPage(): { harness: Harness; root: ShadowRoot; save: Element } {
  const harness = page(SHELL);
  const root = shadow(harness, "app-shell", SHELL_ROOT);
  const save = root.querySelector("#save")!;
  hitInRoot(root, save);
  return { harness, root, save };
}

describe("capturing targets inside open shadow roots", () => {
  test("a click on shadow content selects the element itself, with its root path", () => {
    const { harness } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);

    expect(target.label).toBe("button “Save”");
    expect(target.anchor.semantic).toEqual({ tagName: "button", role: "button", name: "Save" });
    expect(target.anchor.scope).toEqual({
      kind: "shadow",
      hosts: [
        {
          tagName: "app-shell",
          stableId: { kind: "id", value: "shell" },
          cssPath: "app-shell#shell",
        },
      ],
    });
    // Ids and paths are scoped to the innermost root: the document's own
    // #save does not make the shadow #save ambiguous.
    expect(target.anchor.stableId).toEqual({ kind: "id", value: "save" });
    expect(target.anchor.cssPath).toBe("button#save");
    // Ancestors follow the composed tree, so the host and its page context count.
    expect(target.anchor.ancestors.map((ancestor: Json) => ancestor.tagName)).toEqual([
      "main",
      "app-shell",
      "header",
    ]);
    expect(isWebAnnotationTarget(target)).toBe(true);
  });

  test("nested open roots record every host, outermost first", () => {
    const harness = page(`<app-shell></app-shell>`);
    const outer = shadow(harness, "app-shell", `<nav><app-menu></app-menu></nav>`);
    const inner = shadow(harness, "app-menu", `<a href="/settings">Settings</a>`, "open", outer);
    hitInRoot(outer, outer.querySelector("app-menu"));
    hitInRoot(inner, inner.querySelector("a"));
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);

    expect(target.label).toBe("link “Settings”");
    expect(resolve(harness, target).state).toBe("matched");
    expect(target.anchor.scope.hosts).toEqual([
      { tagName: "app-shell", cssPath: "html > body > app-shell" },
      { tagName: "app-menu", cssPath: "nav > app-menu" },
    ]);
  });

  test("a hit the root reports outside itself (slotted light content) is not followed", () => {
    const harness = page(`<x-card><span id="light">Hello</span></x-card>`);
    const root = shadow(harness, "x-card", `<div><slot></slot></div>`);
    hitInRoot(root, harness.document.querySelector("#light"));
    const host = harness.document.querySelector("x-card")!;
    expect(captureAt(harness, host).anchor.semantic.tagName).toBe("x-card");
  });

  test("closed shadow roots fall back to their host, as before", () => {
    const harness = page(`<secret-widget aria-label="Widget"></secret-widget>`);
    const root = shadow(harness, "secret-widget", `<button>Hidden</button>`, "closed");
    hitInRoot(root, root.querySelector("button"));
    const target = captureAt(harness, harness.document.querySelector("secret-widget")!);
    expect(target.label).toBe("secret-widget “Widget”");
    expect(target.anchor.scope).toEqual({ kind: "document" });
  });

  test("a root path deeper than the protocol limit is unsupported", () => {
    const harness = page(`<x-level></x-level>`);
    let within: { querySelector: (selector: string) => Element | null } = harness.document;
    let deepest: ShadowRoot | null = null;
    for (let level = 0; level <= WEB_ANNOTATION_MAX_SHADOW_DEPTH; level += 1) {
      const last = level === WEB_ANNOTATION_MAX_SHADOW_DEPTH;
      deepest = shadow(
        harness,
        "x-level",
        last ? `<button>Deep</button>` : `<x-level></x-level>`,
        "open",
        within,
      );
      within = deepest;
    }
    const kit = harness.window.eval(`(${browserPreviewAnchorKit.toString()})()`) as {
      MAX_SHADOW_DEPTH: number;
      anchorFor: (element: Element) => Json;
    };
    expect(kit.MAX_SHADOW_DEPTH).toBe(WEB_ANNOTATION_MAX_SHADOW_DEPTH);
    expect(kit.anchorFor(deepest!.querySelector("button")!).scope).toEqual({
      kind: "unsupported",
      reason: "shadow-root",
    });
  });

  test("keyboard navigation steps out to the host and back into its root", () => {
    const harness = page(`<x-panel aria-label="Panel"></x-panel>`);
    const root = shadow(
      harness,
      "x-panel",
      `<section aria-label="Body"><button>Go</button></section>`,
    );
    hitInRoot(root, root.querySelector("button"));
    harness.point(harness.document.querySelector("x-panel"));
    harness.start("element");
    // The keyboard start is the element at the centre, found inside the root.
    key(harness, "ArrowUp"); // section
    key(harness, "ArrowUp"); // host
    key(harness, "ArrowDown"); // back into the root
    key(harness, "Enter");
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.label).toBe("region “Body”");
    expect(status.selection.target.anchor.scope.kind).toBe("shadow");
  });

  test("recapture restores a shadow-scoped initial target", () => {
    const { harness, save } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);
    harness.point(harness.document.querySelector("#save"));
    harness.window.eval(
      browserPreviewCaptureStartScript({
        captureId: "recapture",
        nonce: "nonce-1",
        mode: "element",
        initialTarget: target,
      }),
    );
    key(harness, "Enter");
    expect(harness.status().selection.target.anchor).toEqual(target.anchor);
    expect(save.isConnected).toBe(true);
  });

  test("keyboard enters rendered content past a leading style node", () => {
    const harness = page("<x-panel tabindex='0'></x-panel>");
    const host = harness.document.querySelector("x-panel")!;
    const root = shadow(
      harness,
      "x-panel",
      "<style>button { color: red }</style><button>Go</button>",
    );
    (host as unknown as { focus(): void }).focus();
    harness.start("element");
    key(harness, "ArrowDown"); // initialize from focused host
    key(harness, "ArrowDown"); // enter its shadow root
    key(harness, "Enter");
    expect(harness.status().selection.target.label).toBe("button “Go”");
    expect(root.querySelector("button")).not.toBeNull();
  });

  test("keyboard starts from focus inside an open root rather than the centre hit", () => {
    const { harness, save } = shellPage();
    harness.point(harness.document.querySelector("#save"));
    (save as unknown as { focus(): void }).focus();
    harness.start("element");
    key(harness, "Enter");
    expect(harness.status().selection.target.anchor.scope.kind).toBe("shadow");
    expect(harness.status().selection.target.label).toBe("button “Save”");
  });

  test("source hints on the host apply to content inside its root", () => {
    const harness = page(`<x-card data-orkestrator-source="src/Card.ts:3"></x-card>`);
    const root = shadow(
      harness,
      "x-card",
      `<button data-orkestrator-source="src/Button.ts">Buy</button>`,
    );
    hitInRoot(root, root.querySelector("button"));
    const selection = selectAt(harness, harness.document.querySelector("x-card")!);
    expect(selection.evidence.sourceHints.map((hint: Json) => hint.path)).toEqual([
      "src/Button.ts",
      "src/Card.ts",
    ]);
  });

  test("Electron main keeps the root path and drops undeclared host fields", () => {
    const { harness, root } = shellPage();
    // The page is untrusted: add a field main must not pass on.
    const host = harness.document.querySelector("app-shell")!;
    harness.start("element");
    click(harness, host);
    const raw = JSON.parse(
      harness.window.eval(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT) as string,
    ) as Json;
    raw.selection.target.anchor.scope.hosts[0].selector = "#injected";
    const parsed = parseCaptureRuntimeStatus(JSON.stringify(raw), {
      captureId: "capture-1",
      nonce: "nonce-1",
      mode: "element",
    });
    expect(parsed.kind).toBe("selected");
    if (parsed.kind !== "selected" || parsed.selection.target.kind !== "element") return;
    expect(parsed.selection.target.anchor.scope).toEqual({
      kind: "shadow",
      hosts: [
        {
          tagName: "app-shell",
          stableId: { kind: "id", value: "shell" },
          cssPath: "app-shell#shell",
        },
      ],
    });
    expect(root.querySelector("#save")).not.toBeNull();
  });
});

describe("resolving targets inside open shadow roots", () => {
  test("re-resolves on a reloaded page by stable id inside the root", () => {
    const { harness } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);

    // A reload: a fresh document with the same markup, rendered again.
    const reloaded = page(SHELL);
    const root = shadow(reloaded, "app-shell", SHELL_ROOT);
    setRect(root.querySelector("#save")!, { x: 40, y: 12, width: 64, height: 24 });
    const result = resolve(reloaded, target);
    expect(result).toMatchObject({ state: "matched", rule: "stable-id", candidateCount: 1 });
    expect(result.rect).toEqual({ x: 40, y: 12, width: 64, height: 24 });
    expect(visiblePins(reloaded)).toHaveLength(1);
  });

  test("without ids, semantic identity inside the root still matches after re-render", () => {
    const cards = (names: string[]) =>
      `<ul>${names.map((name) => `<li><h3>${name}</h3><button>Delete</button></li>`).join("")}</ul>`;
    const harness = page(`<x-list></x-list>`);
    const root = shadow(harness, "x-list", cards(["Alpha", "Beta"]));
    hitInRoot(root, root.querySelectorAll("button")[1]!);
    const target = captureAt(harness, harness.document.querySelector("x-list")!);

    root.innerHTML = cards(["Beta", "Alpha"]);
    const result = resolve(harness, target);
    expect(result).toMatchObject({ state: "matched", rule: "semantic-context" });
  });

  test("a document element with the same id is never a match for a shadow target", () => {
    const { harness, root } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);
    root.innerHTML = `<header><button>Cancel</button></header>`;
    // The document still has its own `#save` button; it is out of scope.
    expect(resolve(harness, target).state).toBe("missing");
  });

  test("a missing, repeated or closed host does not match", () => {
    const harness = page(`<main><x-card></x-card></main>`);
    const root = shadow(harness, "x-card", `<button>Buy</button>`);
    hitInRoot(root, root.querySelector("button"));
    const target = captureAt(harness, harness.document.querySelector("x-card")!);
    expect(target.anchor.scope.hosts).toEqual([
      { tagName: "x-card", cssPath: "html > body > main > x-card" },
    ]);
    expect(resolve(harness, target).state).toBe("matched");

    harness.document.body.innerHTML = `<main></main>`;
    expect(resolve(harness, target)).toMatchObject({ state: "missing", rule: "none" });

    harness.document.body.innerHTML = `<main><x-card></x-card><x-card></x-card></main>`;
    for (const host of Array.from(harness.document.querySelectorAll("x-card"))) {
      host.attachShadow({ mode: "open" }).innerHTML = `<button>Buy</button>`;
    }
    expect(resolve(harness, target)).toMatchObject({ state: "ambiguous", candidateCount: 2 });

    harness.document.body.innerHTML = `<main><x-card></x-card></main>`;
    shadow(harness, "x-card", `<button>Buy</button>`, "closed");
    expect(resolve(harness, target)).toMatchObject({ state: "missing", rule: "none" });
  });

  test("root-level sibling host paths stay unique unchanged and after reload", () => {
    const build = () => {
      const harness = page("<app-shell></app-shell>");
      const outer = shadow(
        harness,
        "app-shell",
        "<x-card></x-card><x-card></x-card><section><x-card></x-card><x-card></x-card></section>",
      );
      const hosts = Array.from(outer.querySelectorAll("x-card"));
      for (const host of hosts)
        host.attachShadow({ mode: "open" }).innerHTML = "<button id='save'>Save</button>";
      hitInRoot(outer, hosts[1]!);
      hitInRoot(hosts[1]!.shadowRoot!, hosts[1]!.shadowRoot!.querySelector("button"));
      return harness;
    };
    const harness = build();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);
    expect(target.anchor.scope.hosts[1].cssPath).toBe("x-card:nth-of-type(2)");
    expect(resolve(harness, target).state).toBe("matched");
    expect(resolve(build(), target).state).toBe("matched");
  });

  test("host identity survives reorder and refuses substitution after removal", () => {
    const harness = page(
      "<x-card data-testid='alpha'></x-card><x-card data-testid='beta'></x-card>",
    );
    for (const host of Array.from(harness.document.querySelectorAll("x-card"))) {
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = "<button id='save'>Save</button>";
      hitInRoot(root, root.querySelector("button"));
    }
    const alpha = harness.document.querySelector("[data-testid=alpha]")!;
    const target = captureAt(harness, alpha);
    harness.document.body.append(alpha);
    expect(resolve(harness, target).state).toBe("matched");
    alpha.remove();
    expect(resolve(harness, target).state).toBe("missing");
  });

  test("replaced root chains release observer slots for current shadow-only changes", async () => {
    const harness = page("<x-level></x-level>");
    const build = () => {
      let host = harness.document.querySelector("x-level")!;
      let root: ShadowRoot;
      for (let level = 0; level < 8; level += 1) {
        root = host.attachShadow({ mode: "open" });
        root.innerHTML = level === 7 ? "<button id='save'>Save</button>" : "<x-level></x-level>";
        hitInRoot(root, root.firstElementChild);
        host = root.firstElementChild!;
      }
      return root!;
    };
    let root = build();
    const target = captureAt(harness, harness.document.querySelector("x-level")!);
    harness.window.eval(
      browserPreviewPinsShowScript({
        queries: [{ annotationId: "annotation-1", number: 1, label: "Save", target }],
        focusedAnnotationId: null,
        scrollIntoView: false,
        limits: { throttleMs: 20, maxPasses: 120 },
      }),
    );
    const snapshot = () =>
      JSON.parse(harness.window.eval(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT) as string) as Json;
    const waitFor = async (predicate: (value: Json) => boolean) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await new Promise((done) => setTimeout(done, 10));
        if (predicate(snapshot())) return;
      }
      throw new Error("pin observation did not reconcile");
    };
    for (let generation = 0; generation < 9; generation += 1) {
      const passes = snapshot().diagnostics.passes;
      const batches = snapshot().diagnostics.mutationBatches;
      harness.document.body.querySelector("x-level")!.remove();
      harness.document.body.insertAdjacentHTML("afterbegin", "<x-level></x-level>");
      root = build();
      await waitFor(
        (value) => value.diagnostics.mutationBatches > batches && value.diagnostics.passes > passes,
      );
      expect(snapshot().results[0].state).toBe("matched");
    }
    root.querySelector("button")!.remove();
    await waitFor((value) => value.results[0].state === "missing");
  });

  test("an over-long or malformed root path is unsupported", () => {
    const { harness } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);
    const tooDeep = {
      ...target,
      anchor: {
        ...target.anchor,
        scope: {
          kind: "shadow",
          hosts: Array.from({ length: WEB_ANNOTATION_MAX_SHADOW_DEPTH + 1 }, () => ({
            tagName: "app-shell",
            cssPath: "app-shell",
          })),
        },
      },
    };
    expect(resolve(harness, tooDeep).state).toBe("unsupported");
    const empty = { ...target, anchor: { ...target.anchor, scope: { kind: "shadow", hosts: [] } } };
    expect(resolve(harness, empty).state).toBe("unsupported");
  });

  test("the live pin layer re-resolves when content inside an observed root changes", async () => {
    const { harness, root } = shellPage();
    const target = captureAt(harness, harness.document.querySelector("app-shell")!);
    const shown = JSON.parse(
      harness.window.eval(
        browserPreviewPinsShowScript({
          queries: [{ annotationId: "annotation-1", number: 1, label: "Save", target }],
          focusedAnnotationId: null,
          scrollIntoView: false,
          limits: { throttleMs: 20, maxPasses: 50 },
        }),
      ) as string,
    ) as Json;
    expect(shown.results[0].state).toBe("matched");

    // Only the shadow root changes; the document sees no mutation at all.
    root.querySelector("#save")!.remove();
    const snapshot = async (): Promise<Json> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        const current = JSON.parse(
          harness.window.eval(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT) as string,
        ) as Json;
        if (current.results[0].state !== "matched") return current;
      }
      throw new Error("the pin never re-resolved");
    };
    expect((await snapshot()).results[0].state).toBe("missing");
  });
});

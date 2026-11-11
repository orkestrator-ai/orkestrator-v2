/**
 * Text selections inside open shadow roots (todo 2580 (retired) task 2). happy-dom has no
 * `getComposedRanges`, so `selectAcross` installs one that follows the standard:
 * an endpoint inside a root not listed reads as the position around its host,
 * and `getRangeAt` retargets as Chromium does. The real API, real pointer input
 * and a real isolated world are in the `.integration` test beside this one.
 */
import { describe, expect, spyOn, test } from "bun:test";
import type { Element, Node, ShadowRoot } from "happy-dom";
import { WEB_ANNOTATION_MAX_SHADOW_DEPTH } from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationTarget } from "@orkestrator/protocol/web-annotations-validation";
import { browserPreviewAnchorKit } from "../electron/browser-preview-anchor-script";
import {
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCaptureStartScript,
} from "../electron/browser-preview-annotation-script";
import { parseCaptureRuntimeStatus } from "../electron/browser-preview-capture-parse";
import {
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  browserPreviewPinsShowScript,
} from "../electron/browser-preview-pins-script";
import { key, page, type Json } from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;
type Point = { node: Node; offset: number };
type Queryable = { querySelector: (selector: string) => Element | null };

function shadow(
  within: Queryable,
  selector: string,
  html: string,
  mode: "open" | "closed" = "open",
): ShadowRoot {
  const root = within.querySelector(selector)!.attachShadow({ mode });
  root.innerHTML = html;
  return root;
}

/** Where `phrase` starts and ends in the text node `node`. */
function phrase(node: Node, text: string): [Point, Point] {
  const start = node.textContent!.indexOf(text);
  expect(start).toBeGreaterThanOrEqual(0);
  return [
    { node, offset: start },
    { node, offset: start + text.length },
  ];
}

function selectAcross(harness: Harness, start: Point, end: Point): void {
  const { document } = harness;
  const rescope = (point: Point, roots: ShadowRoot[], side: "start" | "end"): Point => {
    let { node, offset } = point;
    for (;;) {
      const root = node.getRootNode() as unknown as ShadowRoot;
      if ((root as unknown) === document || roots.includes(root)) return { node, offset };
      const host = root.host!;
      const parent = host.parentNode!;
      const index = Array.from(parent.childNodes).indexOf(host);
      node = parent;
      offset = side === "start" ? index : index + 1;
    }
  };
  const composed = (roots: ShadowRoot[]) => {
    const from = rescope(start, roots, "start");
    const to = rescope(end, roots, "end");
    return {
      startContainer: from.node,
      startOffset: from.offset,
      endContainer: to.node,
      endOffset: to.offset,
      collapsed: from.node === to.node && from.offset === to.offset,
    };
  };
  const hidden = (point: Point) => (point.node.getRootNode() as unknown) !== document;
  const liveStart = rescope(start, [], "start");
  const liveEnd = hidden(start)
    ? liveStart
    : hidden(end)
      ? rescope(end, [], "start")
      : rescope(end, [], "end");
  // Chromium's ShadowRoot.getSelection uses tree-local live endpoints; a
  // nested root is retargeted just as a root is for Document.getSelection.
  const localRoots = new Set<ShadowRoot>();
  for (const point of [start, end]) {
    let root = point.node.getRootNode() as ShadowRoot;
    while ((root as unknown) !== document) {
      localRoots.add(root);
      root = root.host!.getRootNode() as ShadowRoot;
    }
  }
  for (const root of localRoots) {
    Object.defineProperty(root, "getSelection", {
      configurable: true,
      value: () => {
        const from = rescope(start, [root], "start");
        const to =
          start.node.getRootNode() !== root
            ? from
            : end.node.getRootNode() !== root
              ? rescope(end, [root], "start")
              : rescope(end, [root], "end");
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset);
        return { rangeCount: 1, getRangeAt: () => range };
      },
    });
  }
  const selection = harness.window.getSelection()! as unknown as Record<string, unknown>;
  const live = () => {
    const range = document.createRange();
    range.setStart(liveStart.node, liveStart.offset);
    range.setEnd(liveEnd.node, liveEnd.offset);
    return range;
  };
  for (const [name, value] of Object.entries({
    rangeCount: 1,
    isCollapsed: liveStart.node === liveEnd.node && liveStart.offset === liveEnd.offset,
    getRangeAt: live,
    getComposedRanges: (options?: { shadowRoots?: ShadowRoot[] }) => [
      composed(options?.shadowRoots ?? []),
    ],
  })) {
    Object.defineProperty(selection, name, { value, configurable: true });
  }
}

function capture(harness: Harness, start: Point, end: Point): Json {
  harness.start("text");
  selectAcross(harness, start, end);
  key(harness, "Enter");
  return harness.status();
}

function captured(harness: Harness, start: Point, end: Point): Json {
  const status = capture(harness, start, end);
  expect(status.status).toBe("selected");
  return status.selection.target as Json;
}

function resolve(harness: Harness, target: Json): Json {
  return harness.pins([{ annotationId: "annotation-1", number: 1, target }])[0]!;
}

function hintText(harness: Harness): string {
  return harness
    .ui()
    .map((node) => node.textContent ?? "")
    .join(" ");
}

function kitIn(harness: Harness) {
  return harness.window.eval(`(${browserPreviewAnchorKit.toString()})()`) as {
    describeRange: (range: unknown) => Json;
    selectionRange: (selection: unknown) => Json | null;
  };
}

const CARD = `<main><p>Outside the card</p><x-card id="card"></x-card></main>`;
const CARD_ROOT = `<h3>Plan</h3><p id="price">Team is billed annually per seat</p><p id="note">Cancel anytime</p>`;

function cardPage() {
  const harness = page(CARD);
  const root = shadow(harness.document, "x-card", CARD_ROOT);
  return { harness, root, text: root.querySelector("#price")!.firstChild! };
}

describe("capturing a quote inside an open shadow root", () => {
  test("a selection in a root gives a quote scoped to that root", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));

    expect(target.quote).toEqual({
      exact: "billed annually",
      prefix: "Plan Team is",
      suffix: "per seat Cancel anytime",
    });
    expect(target.container.semantic.tagName).toBe("p");
    expect(target.container.stableId).toEqual({ kind: "id", value: "price" });
    expect(target.container.cssPath).toBe("p#price");
    expect(target.container.scope).toEqual({
      kind: "shadow",
      hosts: [
        { tagName: "x-card", stableId: { kind: "id", value: "card" }, cssPath: "x-card#card" },
      ],
    });
    // The stored shape does not change: the protocol still validates it, field for field.
    expect(Object.keys(target).sort()).toEqual([
      "container",
      "kind",
      "label",
      "quote",
      "rect",
      "rects",
    ]);
    expect(isWebAnnotationTarget(target)).toBe(true);
  });

  test("Electron main keeps the root path of a text range's container", () => {
    const { harness, text } = cardPage();
    harness.start("text");
    selectAcross(harness, ...phrase(text, "billed annually"));
    key(harness, "Enter");
    const raw = JSON.parse(
      harness.window.eval(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT) as string,
    ) as Json;
    raw.selection.target.container.scope.hosts[0].selector = "#injected";
    const parsed = parseCaptureRuntimeStatus(JSON.stringify(raw), {
      captureId: "capture-1",
      nonce: "nonce-1",
      mode: "text",
    });
    expect(parsed.kind).toBe("selected");
    if (parsed.kind !== "selected" || parsed.selection.target.kind !== "text-range") return;
    expect(parsed.selection.target.container.scope).toEqual({
      kind: "shadow",
      hosts: [
        { tagName: "x-card", stableId: { kind: "id", value: "card" }, cssPath: "x-card#card" },
      ],
    });
  });

  test("nested roots record every host, outermost first", () => {
    const harness = page(`<app-shell></app-shell>`);
    const outer = shadow(harness.document, "app-shell", `<nav><app-menu></app-menu></nav>`);
    const inner = shadow(outer, "app-menu", `<p>Open the settings page</p>`);
    const target = captured(harness, ...phrase(inner.querySelector("p")!.firstChild!, "settings"));

    expect(target.quote.exact).toBe("settings");
    expect(target.container.scope.hosts).toEqual([
      { tagName: "app-shell", cssPath: "html > body > app-shell" },
      { tagName: "app-menu", cssPath: "nav > app-menu" },
    ]);
    expect(resolve(harness, target)).toMatchObject({ state: "matched", rule: "text-quote" });
  });

  test("at the root's top level the container is the host, scoped to the root", () => {
    const harness = page(`<x-greeting id="hello" title="Greeting"></x-greeting>`);
    const root = shadow(harness.document, "x-greeting", `Hello from a bare text node`);
    const target = captured(harness, ...phrase(root.firstChild!, "bare text"));

    expect(target.quote).toEqual({ exact: "bare text", prefix: "Hello from a", suffix: "node" });
    expect(target.container.semantic.tagName).toBe("x-greeting");
    expect(target.container.semantic.name).toBe("Greeting");
    expect(target.container.stableId).toBeUndefined();
    expect(target.container.cssPath).toBe(":host");
    expect(target.container.scope.hosts[0].cssPath).toBe("x-greeting#hello");
    expect(isWebAnnotationTarget(target)).toBe(true);
    expect(resolve(harness, target).state).toBe("matched");
  });

  test("a selection across the root's top-level elements is one quote", () => {
    const { harness, root, text } = cardPage();
    const note = root.querySelector("#note")!.firstChild!;
    const target = captured(harness, phrase(text, "per seat")[0], phrase(note, "Cancel")[1]);

    expect(target.quote.exact).toBe("per seat Cancel");
    expect(target.container.cssPath).toBe(":host");
    expect(target.container.semantic.tagName).toBe("x-card");
    expect(resolve(harness, target).state).toBe("matched");
  });

  test("a root nested at the protocol's depth limit works; one deeper is unsupported", () => {
    const build = (levels: number) => {
      const harness = page(`<x-level></x-level>`);
      let within: Queryable = harness.document;
      let deepest: ShadowRoot | null = null;
      for (let level = 1; level <= levels; level += 1) {
        deepest = shadow(
          within,
          "x-level",
          level === levels ? `<p>Deep text</p>` : `<x-level></x-level>`,
        );
        within = deepest;
      }
      return { harness, text: deepest!.querySelector("p")!.firstChild! };
    };
    const atLimit = build(WEB_ANNOTATION_MAX_SHADOW_DEPTH);
    const target = captured(atLimit.harness, ...phrase(atLimit.text, "Deep"));
    expect(target.container.scope.hosts).toHaveLength(WEB_ANNOTATION_MAX_SHADOW_DEPTH);
    expect(resolve(atLimit.harness, target).state).toBe("matched");

    const deeper = build(WEB_ANNOTATION_MAX_SHADOW_DEPTH + 1);
    expect(capture(deeper.harness, ...phrase(deeper.text, "Deep")).status).toBe("selecting");
    expect(hintText(deeper.harness)).toContain("This text can't be captured");
  });
});

describe("a selection across a shadow boundary stays unsupported", () => {
  const nested = () => {
    const harness = page(
      `<p id="light">Light text</p><x-a></x-a><x-b></x-b><p id="after">After text</p>`,
    );
    const a = shadow(harness.document, "x-a", `<p id="a">Text in a</p><x-inner></x-inner>`);
    const inner = shadow(a, "x-inner", `<p>Text in inner</p>`);
    const b = shadow(harness.document, "x-b", `<p>Text in b</p>`);
    return {
      harness,
      light: harness.document.querySelector("#light")!.firstChild!,
      after: harness.document.querySelector("#after")!.firstChild!,
      inA: a.querySelector("#a")!.firstChild!,
      inInner: inner.querySelector("p")!.firstChild!,
      inB: b.querySelector("p")!.firstChild!,
    };
  };

  for (const [name, from, to] of [
    ["light into a root", "light", "inA"],
    ["a root out to light", "inA", "after"],
    ["light into a nested root", "light", "inInner"],
    ["a root into its nested root", "inA", "inInner"],
    ["one root into a sibling root", "inA", "inB"],
  ] as const) {
    test(name, () => {
      const nodes = nested();
      const status = capture(
        nodes.harness,
        phrase(nodes[from], "ext")[0],
        phrase(nodes[to], "ext")[1],
      );
      expect(status.status).toBe("selecting");
      expect(status.selection).toBeUndefined();
      expect(hintText(nodes.harness)).toContain("This text can't be captured; try Region");
    });
  }
});

describe("sensitive fields inside a root stay refused", () => {
  test("text in a sensitive element inside a root", () => {
    const harness = page(`<x-vault></x-vault>`);
    const root = shadow(
      harness.document,
      "x-vault",
      `<div data-sensitive>Key sk-synthetic-000</div>`,
    );
    const status = capture(harness, ...phrase(root.querySelector("div")!.firstChild!, "Key"));
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("synthetic");
    expect(hintText(harness)).toContain("Sensitive fields can't be captured");
  });

  test("text at the top level of a sensitive host's root, and in a root nested below it", () => {
    const harness = page(`<x-vault data-sensitive></x-vault>`);
    const root = shadow(harness.document, "x-vault", `Key sk-synthetic-000<x-inner></x-inner>`);
    const inner = shadow(root, "x-inner", `<p>Nested sk-synthetic-001</p>`);
    for (const text of [root.firstChild!, inner.querySelector("p")!.firstChild!]) {
      const status = capture(harness, ...phrase(text, "sk-synthetic"));
      expect(status.status).toBe("selecting");
      expect(JSON.stringify(status)).not.toContain("synthetic");
      expect(hintText(harness)).toContain("Sensitive fields can't be captured");
    }
  });

  test("a range that spans a password field in the root", () => {
    const harness = page(`<x-form></x-form>`);
    const root = shadow(
      harness.document,
      "x-form",
      `<p id="a">Before</p><input type="password" value="hunter2"><p id="b">After</p>`,
    );
    const status = capture(
      harness,
      phrase(root.querySelector("#a")!.firstChild!, "Before")[0],
      phrase(root.querySelector("#b")!.firstChild!, "After")[1],
    );
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(hintText(harness)).toContain("Sensitive fields can't be captured");
  });

  test("a focused password field inside a root is refused before any selection is read", () => {
    const harness = page(`<x-form></x-form>`);
    const root = shadow(harness.document, "x-form", `<input type="password"><p>Visible</p>`);
    (root.querySelector("input") as unknown as { focus(): void }).focus();
    const status = capture(harness, ...phrase(root.querySelector("p")!.firstChild!, "Visible"));
    expect(status.status).toBe("selecting");
    expect(hintText(harness)).toContain("Sensitive fields can't be captured");
  });

  test("a saved quote does not resolve once its host has become sensitive", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));
    harness.document.querySelector("x-card")!.setAttribute("data-sensitive", "");
    expect(resolve(harness, target)).toMatchObject({ state: "missing", rule: "none" });
  });
});

describe("closed roots stay out of reach", () => {
  const closedPage = () => {
    const harness = page(`<p>Visible light text</p><x-private></x-private>`);
    const root = shadow(harness.document, "x-private", `<p>Closed secret words</p>`, "closed");
    return { harness, root, inside: root.querySelector("p")!.firstChild! };
  };

  test("a selection inside one is refused and its text is not read", () => {
    const { harness, inside } = closedPage();
    const status = capture(harness, ...phrase(inside, "secret"));
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(hintText(harness)).toContain("This text can't be captured");
  });

  test("a selection from light text into one is refused, not cut short", () => {
    const { harness, inside } = closedPage();
    const light = harness.document.querySelector("p")!.firstChild!;
    const status = capture(harness, phrase(light, "light")[0], phrase(inside, "secret")[1]);
    expect(status.status).toBe("selecting");
    expect(status.selection).toBeUndefined();
    expect(hintText(harness)).toContain("This text can't be captured");
  });

  for (const direction of ["into", "out", "inside"] as const) {
    test(`a selection ${direction} a nested closed root is refused`, () => {
      const harness = page(`<x-open></x-open>`);
      const outer = shadow(
        harness.document,
        "x-open",
        `<p>Visible outer words</p><x-private>Misleading light text</x-private><p id="after">After outer words</p>`,
      );
      const closed = shadow(outer, "x-private", `<p>Hidden secret words</p>`, "closed");
      const hidden = phrase(closed.querySelector("p")!.firstChild!, "secret");
      const before = phrase(outer.querySelector("p")!.firstChild!, "outer");
      const after = phrase(outer.querySelector("#after")!.firstChild!, "outer");
      const status =
        direction === "into"
          ? capture(harness, before[0], hidden[1])
          : direction === "out"
            ? capture(harness, hidden[0], after[1])
            : capture(harness, ...hidden);
      expect(status.status).toBe("selecting");
      expect(status.selection).toBeUndefined();
      expect(hintText(harness)).toContain("This text can't be captured");
    });
  }

  test("a range inside one that the page handed over is unsupported", () => {
    const { harness, root } = closedPage();
    const range = harness.document.createRange();
    range.selectNodeContents(root.querySelector("p")!);
    expect(kitIn(harness).describeRange(range)).toEqual({ error: "unsupported" });
  });

  test("a range in a detached tree is unsupported", () => {
    const harness = page(`<p>Attached</p>`);
    const detached = harness.document.createElement("p");
    detached.textContent = "Detached";
    const range = harness.document.createRange();
    range.selectNodeContents(detached);
    expect(kitIn(harness).describeRange(range)).toEqual({ error: "unsupported" });
  });
});

describe("document selections behave as before", () => {
  const DOCUMENT = `<p id="a">Team is billed annually per seat</p><x-card></x-card><p id="b">Cancel anytime</p>`;
  const expected = {
    exact: "billed annually",
    prefix: "Team is",
    suffix: "per seat Cancel anytime",
  };

  test("with getComposedRanges, the quote and scope are the document's", () => {
    const harness = page(DOCUMENT);
    shadow(harness.document, "x-card", `<p>Component text</p>`);
    const text = harness.document.querySelector("#a")!.firstChild!;
    const target = captured(harness, ...phrase(text, "billed annually"));
    expect(target.quote).toMatchObject(expected);
    expect(target.container.scope).toEqual({ kind: "document" });
    expect(target.container.cssPath).toBe("p#a");
    expect(resolve(harness, target)).toMatchObject({ state: "matched", rule: "text-quote" });
  });

  test("without getComposedRanges, the selection is read as before", () => {
    const harness = page(DOCUMENT);
    const text = harness.document.querySelector("#a")!.firstChild!;
    const range = harness.document.createRange();
    const [start, end] = phrase(text, "billed annually");
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    harness.window.getSelection()!.addRange(range);
    harness.start("text");
    key(harness, "Enter");
    expect(harness.status().selection.target.quote).toMatchObject(expected);
  });

  test("a light selection over a host keeps only light text, and never enters the root", () => {
    const harness = page(DOCUMENT);
    shadow(harness.document, "x-card", `<p>Component text</p>`);
    const target = captured(
      harness,
      phrase(harness.document.querySelector("#a")!.firstChild!, "per seat")[0],
      phrase(harness.document.querySelector("#b")!.firstChild!, "Cancel")[1],
    );
    expect(target.quote.exact).toBe("per seat Cancel");
    expect(target.container.scope).toEqual({ kind: "document" });
  });

  test("select all keeps the live range, though Chromium composes the root element", () => {
    const harness = page(DOCUMENT);
    const first = harness.document.querySelector("#a")!.firstChild!;
    const last = harness.document.querySelector("#b")!.firstChild!;
    selectAcross(harness, phrase(first, "Team")[0], phrase(last, "anytime")[1]);
    const html = harness.document.documentElement;
    Object.defineProperty(harness.window.getSelection()!, "getComposedRanges", {
      value: () => [
        {
          startContainer: html,
          startOffset: 0,
          endContainer: html,
          endOffset: html.childNodes.length,
          collapsed: false,
        },
      ],
    });
    harness.start("text");
    key(harness, "Enter");
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.quote.exact).toBe(
      "Team is billed annually per seat Cancel anytime",
    );
  });

  test("a collapsed selection is ignored", () => {
    const harness = page(DOCUMENT);
    const text = harness.document.querySelector("#a")!.firstChild!;
    const [start] = phrase(text, "billed");
    const status = capture(harness, start, start);
    expect(status.status).toBe("selecting");
    expect(hintText(harness)).not.toContain("can't be captured");
  });

  test("an unsupported composed read falls back to the plain selection", () => {
    const harness = page(DOCUMENT);
    const text = harness.document.querySelector("#a")!.firstChild!;
    const [start, end] = phrase(text, "billed annually");
    selectAcross(harness, start, end);
    Object.defineProperty(harness.window.getSelection()!, "getComposedRanges", {
      value: () => {
        throw new TypeError("not this signature");
      },
    });
    const selected = kitIn(harness).selectionRange(harness.window.getSelection());
    expect(selected?.range.toString()).toBe("billed annually");
  });

  test("a document quote is never found in a root, or a root's quote in the document", () => {
    const { harness, text } = cardPage();
    const inRoot = captured(harness, ...phrase(text, "billed annually"));
    const lookalike = page(`<p>Team is billed annually per seat</p><x-card id="card"></x-card>`);
    shadow(lookalike.document, "x-card", `<p id="price">Different text</p>`);
    expect(resolve(lookalike, inRoot)).toMatchObject({ state: "missing", rule: "none" });

    const onDocument = captured(
      lookalike,
      ...phrase(lookalike.document.querySelector("p")!.firstChild!, "billed annually"),
    );
    const inRootOnly = cardPage().harness;
    expect(resolve(inRootOnly, onDocument)).toMatchObject({ state: "missing", rule: "none" });
  });
});

describe("resolving a quote inside a root", () => {
  test("resolves again after a reload, from the stored target alone", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));

    const reloaded = cardPage();
    const result = resolve(reloaded.harness, JSON.parse(JSON.stringify(target)) as Json);
    expect(result).toMatchObject({ state: "matched", rule: "text-quote", candidateCount: 1 });
  });

  test("the same text in the document does not make a root's quote ambiguous", () => {
    const harness = page(`<p>Team is billed annually per seat</p><x-card id="card"></x-card>`);
    const root = shadow(harness.document, "x-card", CARD_ROOT);
    const target = captured(
      harness,
      ...phrase(root.querySelector("#price")!.firstChild!, "billed annually"),
    );
    expect(resolve(harness, target)).toMatchObject({ state: "matched", candidateCount: 1 });
  });

  test("the context of a repeated quote picks the occurrence inside the root", () => {
    const harness = page(`<x-list></x-list>`);
    const html = `<p>First plan renews monthly here</p><p>Second plan renews monthly there</p>`;
    const root = shadow(harness.document, "x-list", html);
    const second = root.querySelectorAll("p")[1]!.firstChild!;
    const target = captured(harness, ...phrase(second, "renews monthly"));
    expect(resolve(harness, target)).toMatchObject({
      state: "matched",
      rule: "text-quote",
      candidateCount: 2,
    });

    root.innerHTML = `<p>Plan renews monthly</p><p>Plan renews monthly</p>`;
    expect(resolve(harness, target).state).toBe("ambiguous");
    root.innerHTML = `<p>Nothing like it</p>`;
    expect(resolve(harness, target).state).toBe("missing");
  });

  test("a missing, repeated or closed host follows the root path rules", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));
    const body = harness.document.body;

    body.innerHTML = `<main></main>`;
    expect(resolve(harness, target)).toMatchObject({ state: "missing", rule: "none" });

    body.innerHTML = `<main><x-card id="card"></x-card></main>`;
    shadow(harness.document, "x-card", CARD_ROOT, "closed");
    expect(resolve(harness, target)).toMatchObject({ state: "missing", rule: "none" });

    body.innerHTML = `<x-card></x-card><x-card></x-card>`;
    const noStableId = {
      ...target,
      container: {
        ...target.container,
        scope: { kind: "shadow", hosts: [{ tagName: "x-card", cssPath: "x-card" }] },
      },
    };
    expect(resolve(harness, noStableId)).toMatchObject({ state: "ambiguous", candidateCount: 2 });
  });

  test("an unsupported or malformed container scope is unsupported", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));
    for (const scope of [
      { kind: "unsupported", reason: "shadow-root" },
      { kind: "shadow", hosts: [] },
    ]) {
      const container = { ...target.container, scope };
      expect(resolve(harness, { ...target, container }).state).toBe("unsupported");
    }
  });

  test("the pin layer observes the root, and re-resolves when its text changes", async () => {
    const { harness, root, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));
    harness.window.eval(
      browserPreviewPinsShowScript({
        queries: [{ annotationId: "annotation-1", number: 1, label: "Quote", target }],
        focusedAnnotationId: null,
        scrollIntoView: false,
        limits: { throttleMs: 20, maxPasses: 50 },
      }),
    );
    root.querySelector("#price")!.remove();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((done) => setTimeout(done, 10));
      const snapshot = JSON.parse(
        harness.window.eval(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT) as string,
      ) as Json;
      if (snapshot.results[0].state === "missing") return;
    }
    throw new Error("the quote's pin never re-resolved");
  });

  test("Show on page scrolls to the host for text at the root's top level", () => {
    const harness = page(`<x-greeting></x-greeting>`);
    const root = shadow(harness.document, "x-greeting", `Hello from a bare text node`);
    const target = captured(harness, ...phrase(root.firstChild!, "bare text"));
    const host = harness.document.querySelector("x-greeting")!;
    const scrolled = spyOn(
      host as unknown as { scrollIntoView: (options?: unknown) => void },
      "scrollIntoView",
    );
    harness.window.eval(
      browserPreviewPinsShowScript({
        queries: [{ annotationId: "annotation-1", number: 1, label: "Quote", target }],
        focusedAnnotationId: "annotation-1",
        scrollIntoView: true,
      }),
    );
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  test("recapture preselects a quote inside a root", () => {
    const { harness, text } = cardPage();
    const target = captured(harness, ...phrase(text, "billed annually"));
    const reloaded = cardPage();
    reloaded.harness.window.eval(
      browserPreviewCaptureStartScript({
        captureId: "recapture",
        nonce: "nonce-1",
        mode: "text",
        initialTarget: target,
      }),
    );
    key(reloaded.harness, "Enter");
    const status = reloaded.harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.quote.exact).toBe("billed annually");
    expect(status.selection.target.container.scope).toEqual(target.container.scope);
  });
});

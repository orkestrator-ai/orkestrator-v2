import { describe, expect, test } from "bun:test";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
} from "../../../apps/desktop/electron/browser-preview-annotation-script";
import { BROWSER_PREVIEW_PINS_CLEAR_SCRIPT } from "../../../apps/desktop/electron/browser-preview-pins-script";
import {
  captureElement,
  click,
  key,
  page,
  setRect,
  trusted,
  visiblePins,
  type Json,
} from "./browser-preview-page-harness";

describe("selection-only capture runtime", () => {
  test("has no comment field and reports host-bound selecting status", () => {
    const harness = page(`<button id="save">Save</button>`);
    const initial = harness.start("element");

    expect(initial).toEqual({
      v: 1,
      captureId: "capture-1",
      nonce: "nonce-1",
      mode: "element",
      status: "selecting",
    });
    expect(harness.document.querySelector("textarea") === null).toBe(true);
    expect(harness.document.querySelector("form") === null).toBe(true);
    expect(JSON.stringify(harness.status())).not.toContain("comment");
  });

  test("clicking selects the element, suppresses its page action, and then restores input", () => {
    const harness = page(
      `<div class="actions"><button data-testid="save-button">Save</button></div>`,
    );
    const button = harness.document.querySelector("button")!;
    let pageClicks = 0;
    button.addEventListener("click", () => {
      pageClicks += 1;
    });
    harness.start("element");

    const selectClick = click(harness, button);

    expect(selectClick.defaultPrevented).toBe(true);
    expect(pageClicks).toBe(0);
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.kind).toBe("element");
    expect(status.selection.target.label).toBe("button “Save”");
    expect(status.selection.target.anchor.stableId).toEqual({
      kind: "test-id",
      value: "save-button",
    });
    expect(status.selection.target.anchor.semantic).toEqual({
      tagName: "button",
      role: "button",
      name: "Save",
    });

    const later = new harness.window.MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
    expect(pageClicks).toBe(1);
  });

  test("page-dispatched synthetic events cannot choose, confirm, or cancel a target", () => {
    const harness = page(`<button data-testid="save-button">Save</button>`);
    const button = harness.document.querySelector("button")!;
    const { window } = harness;
    harness.start("element");
    harness.point(button);
    // Synthetic events: isTrusted stays unset, as for page script in Chromium.
    button.dispatchEvent(new window.PointerEvent("pointermove", { bubbles: true }));
    button.dispatchEvent(
      new window.MouseEvent("click", { clientX: 5, clientY: 5, bubbles: true, cancelable: true }),
    );
    for (const name of ["Enter", "Escape"]) {
      harness.document.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
      );
    }
    expect(harness.status()).toMatchObject({ captureId: "capture-1", status: "selecting" });

    // The user's own click still selects.
    click(harness, button);
    expect(harness.status().status).toBe("selected");
  });

  test("keyboard moves to parent and child and Enter selects without a pointer", () => {
    const harness = page(
      `<nav aria-label="Primary"><ul><li><a href="/home">Home</a></li></ul></nav>`,
    );
    const link = harness.document.querySelector("a")!;
    // Keyboard only: the focused element is the first candidate, no hover needed.
    (link as HTMLElement).focus();
    harness.start("element");

    expect(key(harness, "ArrowUp").defaultPrevented).toBe(true);
    key(harness, "[");
    key(harness, "ArrowUp");
    key(harness, "ArrowDown");
    key(harness, "Enter");

    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.anchor.semantic.tagName).toBe("ul");
    expect(status.selection.target.anchor.semantic.role).toBe("list");
  });

  test("Escape cancels, removes overlays, and lets preview input through", () => {
    const harness = page(`<button>Save</button>`);
    const button = harness.document.querySelector("button")!;
    harness.start("element");
    harness.point(button);
    button.dispatchEvent(
      trusted(new harness.window.PointerEvent("pointermove", { bubbles: true })),
    );
    expect(harness.ui().length).toBeGreaterThan(0);

    key(harness, "Escape");

    expect(harness.status()).toMatchObject({ captureId: "capture-1", status: "cancelled" });
    expect(harness.ui()).toHaveLength(0);
    const after = new harness.window.MouseEvent("click", { bubbles: true, cancelable: true });
    button.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  test("stays registered as cancelled until the host removes it", () => {
    const harness = page(`<button>Save</button>`);
    harness.start("text");
    key(harness, "Escape");
    expect(harness.status().status).toBe("cancelled");
    harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    expect(harness.status()).toEqual({ status: "inactive" });
  });

  test("text mode captures an exact quote with bounded context and never touches the clipboard", () => {
    const harness = page(
      `<p id="pricing">Plans start at $120 billed annually per seat for small teams.</p>`,
    );
    let clipboardWrites = 0;
    Object.defineProperty(harness.window.navigator, "clipboard", {
      value: { writeText: () => clipboardWrites++, write: () => clipboardWrites++ },
      configurable: true,
    });
    const execCommand = harness.document.execCommand?.bind(harness.document);
    harness.document.execCommand = ((...args: unknown[]) => {
      clipboardWrites += 1;
      return execCommand?.(...(args as [string]));
    }) as typeof harness.document.execCommand;
    harness.start("text");
    const text = harness.document.querySelector("p")!.firstChild!;
    const range = harness.document.createRange();
    const start = text.textContent!.indexOf("billed annually");
    range.setStart(text, start);
    range.setEnd(text, start + "billed annually".length);
    harness.window.getSelection()!.removeAllRanges();
    harness.window.getSelection()!.addRange(range);

    key(harness, "Enter");

    const status = harness.status();
    expect(status.status).toBe("selected");
    const target = status.selection.target;
    expect(target.kind).toBe("text-range");
    expect(target.quote.exact).toBe("billed annually");
    expect(target.quote.prefix.endsWith("$120")).toBe(true);
    expect(target.quote.suffix.startsWith("per seat")).toBe(true);
    expect(target.container.semantic.tagName).toBe("p");
    expect(target.label).toBe("“billed annually”");
    expect(clipboardWrites).toBe(0);
  });

  test("text mode rejects selections inside sensitive content and keeps selecting", () => {
    const harness = page(`<div data-sensitive>API key sk-synthetic-000</div><p>Visible copy</p>`);
    harness.start("text");
    const secret = harness.document.querySelector("[data-sensitive]")!.firstChild!;
    const range = harness.document.createRange();
    range.setStart(secret, 0);
    range.setEnd(secret, 7);
    harness.window.getSelection()!.removeAllRanges();
    harness.window.getSelection()!.addRange(range);

    key(harness, "Enter");

    const status = harness.status();
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("synthetic");
  });

  test("region mode draws over an inspector-owned overlay and confirms with Enter", () => {
    const harness = page(`<canvas width="400" height="300"></canvas>`);
    let pagePointerDowns = 0;
    harness.document.querySelector("canvas")!.addEventListener("pointerdown", () => {
      pagePointerDowns += 1;
    });
    harness.start("region");
    const overlay = harness
      .ui()
      .find((node) => (node as HTMLElement).style.cursor === "crosshair") as HTMLElement;
    expect(overlay).toBeDefined();
    const pointer = (type: string, x: number, y: number) =>
      overlay.dispatchEvent(
        trusted(
          new harness.window.PointerEvent(type, {
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );

    pointer("pointerdown", 10, 10);
    pointer("pointerup", 12, 12);
    key(harness, "Enter");
    expect(harness.status().status).toBe("selecting");

    pointer("pointerdown", 20, 40);
    pointer("pointermove", 200, 100);
    pointer("pointerup", 340, 160);
    key(harness, "ArrowRight");
    key(harness, "Enter");

    const status = harness.status();
    expect(pagePointerDowns).toBe(0);
    expect(status.status).toBe("selected");
    expect(status.selection.target).toEqual({
      kind: "region",
      label: "Region 320×120",
      rect: { x: 30, y: 40, width: 320, height: 120 },
      imageRect: null,
    });
    expect(status.selection.evidence).toBeNull();
  });

  test("page mode selects immediately without page evidence", () => {
    const harness = page(`<main>Dashboard</main>`);
    harness.document.title = "Dashboard";
    const initial = harness.start("page");
    expect(initial.status).toBe("selected");
    expect(initial.selection.target).toEqual({ kind: "page", label: "Whole page" });
    expect(initial.selection.evidence).toBeNull();
    expect(initial.selection.title).toBe("Dashboard");
    expect(initial.selection.viewport).toEqual({ width: 1024, height: 768 });
  });
});

describe("bounded, sanitized evidence", () => {
  test("a huge DOM and huge attributes stay within budgets without reading outerHTML", () => {
    const harness = page(`<section id="root"></section>`);
    const root = harness.document.querySelector("#root")!;
    for (let index = 0; index < 3_000; index += 1) {
      const item = harness.document.createElement("div");
      item.textContent = `row ${index} ${"lorem ipsum ".repeat(20)}`;
      root.append(item);
    }
    for (let index = 0; index < 100; index += 1) {
      root.setAttribute(`data-long-${index}`, "v".repeat(1_000));
      root.setAttribute(`aria-x${index}`, "w".repeat(1_000));
    }
    const elementPrototype = harness.window.Element.prototype as unknown as object;
    let outerHtmlReads = 0;
    Object.defineProperty(elementPrototype, "outerHTML", {
      get: () => {
        outerHtmlReads += 1;
        return "";
      },
      configurable: true,
    });
    Object.defineProperty(elementPrototype, "innerHTML", {
      get: () => {
        outerHtmlReads += 1;
        return "";
      },
      configurable: true,
    });

    captureElement(harness, root);
    harness.start("element");
    click(harness, root);
    const encoded = harness.window.eval(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT) as string;
    const status = JSON.parse(encoded) as Json;

    expect(outerHtmlReads).toBe(0);
    expect(encoded.length).toBeLessThanOrEqual(65_536);
    expect(status.status).toBe("selected");
    const evidence = status.selection.evidence;
    expect(evidence.html.length).toBeLessThanOrEqual(6_000);
    expect(evidence.text.length).toBeLessThanOrEqual(2_000);
    expect(Object.keys(evidence.attributes).length).toBeLessThanOrEqual(24);
    for (const value of Object.values(evidence.attributes) as string[]) {
      expect(value.length).toBeLessThanOrEqual(300);
    }
    expect(status.selection.redaction.attributesRemoved).toBeGreaterThan(0);
  });

  test("structural HTML drops handlers, values, scripts, srcdoc, javascript: URLs, and token parameters", () => {
    const harness = page(`
      <div id="card" onclick="steal()">
        <a href="javascript:alert(1)">Bad link</a>
        <a href="/orders?token=synthetic-secret-token&page=2#access_token=abc">Orders</a>
        <input name="email" value="person@example.invalid" onfocus="x()">
        <input type="password" name="pw" value="synthetic-password">
        <textarea name="note">synthetic private note</textarea>
        <img src="https://cdn.example.invalid/a.png?sig=abcdef" onerror="boom()" alt="Avatar">
        <iframe srcdoc="<script>evil()</script>"></iframe>
        <script>window.secret = "synthetic-script"</script>
        <span data-sensitive>synthetic sensitive</span>
        <custom-widget style="color:red" data-state="x">Widget</custom-widget>
      </div>`);
    harness.start("element");
    click(harness, harness.document.querySelector("#card")!);
    const selection = harness.status().selection;
    const html = selection.evidence.html as string;

    for (const forbidden of [
      "onclick",
      "onfocus",
      "onerror",
      "javascript:",
      "synthetic-secret-token",
      "person@example.invalid",
      "synthetic-password",
      "synthetic private note",
      "srcdoc",
      "<script",
      "synthetic-script",
      "synthetic sensitive",
      "access_token",
      "sig=",
      "style=",
      "data-state",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("page=2");
    expect(html).toContain("<custom-widget>Widget</custom-widget>");
    expect(html).toContain('alt="Avatar"');
    expect(selection.redaction.valuesMasked).toBeGreaterThanOrEqual(3);
    expect(selection.redaction.urlParametersRemoved).toBeGreaterThanOrEqual(3);
    expect(selection.redaction.attributesRemoved).toBeGreaterThanOrEqual(4);
    expect(selection.evidence.attributes).toEqual({ id: "card" });
  });

  test("prepare masks detectable sensitive fields in the viewport and reports their rects", async () => {
    const harness = page(`
      <input type="password" id="pw">
      <input autocomplete="cc-number" id="card">
      <input autocomplete="one-time-code" id="otp">
      <div data-sensitive id="token">synthetic</div>
      <input type="hidden" id="hidden" data-sensitive>
      <input type="password" id="offscreen">
      <button id="go">Go</button>`);
    const rects: Record<string, { x: number; y: number; width: number; height: number }> = {
      pw: { x: 10, y: 10, width: 100, height: 20 },
      card: { x: 10, y: 40, width: 100, height: 20 },
      otp: { x: 10, y: 70, width: 100, height: 20 },
      token: { x: 10, y: 100, width: 100, height: 20 },
      hidden: { x: 10, y: 130, width: 100, height: 20 },
      offscreen: { x: 10, y: 5_000, width: 100, height: 20 },
      go: { x: 200, y: 10, width: 40, height: 20 },
    };
    for (const [id, rect] of Object.entries(rects))
      setRect(harness.document.getElementById(id)!, rect);
    harness.start("element");
    click(harness, harness.document.getElementById("go")!);

    expect(await harness.prepare("forged-capture")).toBeNull();
    const probe = (await harness.prepare())!;

    expect(probe.captureId).toBe("capture-1");
    expect(probe.nonce).toBe("nonce-1");
    expect(probe.connected).toBe(true);
    expect(probe.rect).toEqual(rects.go);
    expect(probe.sensitive).toEqual([rects.pw, rects.card, rects.otp, rects.token]);
    const masks = harness
      .ui()
      .filter(
        (node) =>
          (node as HTMLElement).style.background === "rgb(31, 35, 40)" ||
          (node as HTMLElement).style.background === "#1f2328",
      );
    expect(masks).toHaveLength(4);
  });

  test("stable ids are recorded only when unique and not generated", () => {
    const harness = page(`
      <button id="dup">One</button><button id="dup">Two</button>
      <button id=":r1:">Generated</button>
      <button data-testid="unique-test">Tested</button>
      <button id="primary-action">Primary</button>`);
    const [dup, , generated, tested, primary] = Array.from(
      harness.document.querySelectorAll("button"),
    );
    expect(captureElement(harness, dup!).anchor.stableId).toBeUndefined();
    expect(captureElement(harness, generated!).anchor.stableId).toBeUndefined();
    expect(captureElement(harness, tested!).anchor.stableId).toEqual({
      kind: "test-id",
      value: "unique-test",
    });
    expect(captureElement(harness, primary!).anchor.stableId).toEqual({
      kind: "id",
      value: "primary-action",
    });
  });

  test("elements that host an iframe or shadow root are captured with unsupported scope", () => {
    const harness = page(`<iframe title="Embedded"></iframe><div id="host"></div>`);
    const host = harness.document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML = "<button>Inside</button>";
    expect(captureElement(harness, harness.document.querySelector("iframe")!).anchor.scope).toEqual(
      {
        kind: "unsupported",
        reason: "iframe",
      },
    );
    expect(captureElement(harness, host).anchor.scope).toEqual({
      kind: "unsupported",
      reason: "shadow-root",
    });
  });
});

describe("page-side anchor resolver", () => {
  const cards = (names: string[]) =>
    `<ul class="cards">${names
      .map((name) => `<li class="card"><h3>${name}</h3><button>Delete</button></li>`)
      .join("")}</ul>`;

  function resolve(harness: ReturnType<typeof page>, target: Json) {
    return harness.pins([{ annotationId: "annotation-1", number: 1, target }])[0]!;
  }

  test("matches a unique stable id and draws a numbered pin only for matched targets", () => {
    const harness = page(`<button data-testid="save">Save</button><button>Other</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    const results = harness.pins([
      { annotationId: "annotation-1", number: 7, target },
      {
        annotationId: "annotation-2",
        number: 8,
        target: {
          kind: "element",
          anchor: {
            ...target.anchor,
            stableId: undefined,
            semantic: { tagName: "button", role: "button", name: "Missing" },
            text: null,
            cssPath: "section > button",
          },
        },
      },
    ]);

    expect(results[0]).toMatchObject({ state: "matched", rule: "stable-id", candidateCount: 1 });
    expect(results[1]).toMatchObject({ state: "missing", rect: null });
    const pinsLayer = harness.document.querySelector("[data-orkestrator-pins]")!;
    // Only the matched target shows a pin; the unmatched one stays hidden until it resolves.
    expect(visiblePins(harness).map((node) => node.textContent)).toEqual(["7"]);
    expect((pinsLayer as HTMLElement).style.pointerEvents).toBe("none");

    harness.window.eval(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
    expect(harness.document.querySelector("[data-orkestrator-pins]") === null).toBe(true);
  });

  test("duplicate ids after capture fall back to other rules instead of matching", () => {
    const harness = page(`<button id="save">Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<button id="save">Save</button><button id="save">Save</button>`;
    expect(resolve(harness, target)).toMatchObject({ state: "ambiguous" });
  });

  test("repeated button names without distinguishing context stay ambiguous", () => {
    const harness = page(`<div><button>Edit</button></div>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<div><button>Edit</button></div><div><button>Edit</button></div>`;
    expect(resolve(harness, target)).toMatchObject({ state: "ambiguous", candidateCount: 2 });
  });

  test("a reordered card resolves by surrounding context, not by its old structural position", () => {
    const harness = page(cards(["Alpha", "Beta", "Gamma"]));
    const beta = harness.document.querySelectorAll("button")[1]!;
    const target = captureElement(harness, beta);
    expect(target.anchor.cssPath).toContain("li:nth-of-type(2)");

    harness.document.body.innerHTML = cards(["Beta", "Alpha", "Gamma"]);
    const movedBeta = harness.document.querySelectorAll("button")[0]!;
    setRect(movedBeta, { x: 11, y: 22, width: 60, height: 20 });
    const result = resolve(harness, target);
    expect(result).toMatchObject({ state: "matched", rule: "semantic-context" });
    expect(result.rect).toEqual({ x: 11, y: 22, width: 60, height: 20 });
  });

  test("the nth-of-type path alone never matches a different card in the old position", () => {
    const harness = page(cards(["Alpha", "Beta"]));
    const target = captureElement(harness, harness.document.querySelectorAll("button")[1]!);
    harness.document.body.innerHTML = cards(["Alpha", "Gamma"]);
    expect(resolve(harness, target).state).not.toBe("matched");
  });

  test("inserted siblings and dynamic class names do not break a match", () => {
    const harness = page(
      `<form><label for="email">Email</label><input id="email" class="css-1x2y3z"><button class="btn-a91">Subscribe</button></form>`,
    );
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<form><p>New promo banner</p><label for="email">Email</label><input id="email" class="css-9q8w7e"><span>Hint</span><button class="btn-zz1">Subscribe</button></form>`;
    expect(resolve(harness, target)).toMatchObject({ state: "matched" });
  });

  test("a changed label on the same stable id is stale, not silently matched", () => {
    const harness = page(`<button data-testid="primary">Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<button data-testid="primary">Delete everything</button>`;
    expect(resolve(harness, target)).toMatchObject({
      state: "stale",
      rule: "stable-id",
      rect: null,
    });
  });

  test("a changed label without a stable id is stale through its structural path", () => {
    const harness = page(`<main><button>Save</button></main>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<main><button>Publish now</button></main>`;
    expect(resolve(harness, target)).toMatchObject({ state: "stale" });
  });

  test("a removed target is missing", () => {
    const harness = page(`<main><button>Save</button><button>Cancel</button></main>`);
    const target = captureElement(harness, harness.document.querySelectorAll("button")[1]!);
    harness.document.body.innerHTML = `<main><a href="/x">Somewhere</a></main>`;
    expect(resolve(harness, target)).toMatchObject({ state: "missing", candidateCount: 0 });
  });

  test("an id reused by a different component is stale", () => {
    const harness = page(`<button id="primary">Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.document.body.innerHTML = `<div id="primary">Promotional banner</div>`;
    expect(resolve(harness, target)).toMatchObject({ state: "stale", rule: "stable-id" });
  });

  test("text quotes resolve by exact text plus context; repeated phrases stay ambiguous", () => {
    const harness = page(
      `<p>Pro is $120 billed annually per seat.</p><p>Team is $300 billed annually per workspace.</p>`,
    );
    const target = {
      kind: "text-range",
      quote: { exact: "billed annually", prefix: "Team is $300", suffix: "per workspace" },
      container: {
        semantic: { tagName: "p", role: null, name: null },
        text: null,
        ancestors: [],
        cssPath: "p",
        scope: { kind: "document" },
      },
    };
    expect(resolve(harness, target)).toMatchObject({
      state: "matched",
      rule: "text-quote",
      candidateCount: 2,
    });
    expect(
      resolve(harness, { ...target, quote: { exact: "billed annually", prefix: "", suffix: "" } }),
    ).toMatchObject({ state: "ambiguous", candidateCount: 2 });
    expect(
      resolve(harness, { ...target, quote: { exact: "billed monthly", prefix: "", suffix: "" } }),
    ).toMatchObject({ state: "missing" });
  });

  test("unsupported scopes and targets without DOM identity never produce a pin", () => {
    const harness = page(`<button>Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    expect(
      resolve(harness, {
        ...target,
        anchor: { ...target.anchor, scope: { kind: "unsupported", reason: "iframe" } },
      }),
    ).toMatchObject({ state: "unsupported", rule: "none" });
    expect(
      resolve(harness, { kind: "region", rect: { x: 0, y: 0, width: 10, height: 10 } }),
    ).toMatchObject({
      state: "unsupported",
    });
    expect(visiblePins(harness)).toEqual([]);
  });

  test("a page beyond the traversal budget is too complex, never a guess", () => {
    const harness = page(`<button>Save</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    const buttons = Array.from(
      { length: 6_000 },
      (_, index) => `<button>Item ${index}</button>`,
    ).join("");
    harness.document.body.innerHTML = `<div>${buttons}</div>`;
    expect(
      resolve(harness, { ...target, anchor: { ...target.anchor, cssPath: "" } }),
    ).toMatchObject({
      state: "too-complex",
      rule: "none",
    });
  });
});

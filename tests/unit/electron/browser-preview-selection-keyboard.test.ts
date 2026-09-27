import { describe, expect, test } from "bun:test";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  browserPreviewCaptureSettleScript,
  browserPreviewCaptureStartScript,
} from "../../../apps/desktop/electron/browser-preview-annotation-script";
import {
  captureElement,
  click,
  key,
  page,
  trusted,
  type Json,
} from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;

function keyWith(harness: Harness, name: string, init: KeyboardEventInit = {}) {
  const event = trusted(
    new harness.window.KeyboardEvent("keydown", {
      key: name,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
  harness.document.dispatchEvent(event);
  return event;
}

function startWith(harness: Harness, mode: string, initialTarget: unknown) {
  return JSON.parse(
    harness.window.eval(
      browserPreviewCaptureStartScript({
        captureId: "capture-1",
        nonce: "nonce-1",
        mode: mode as "element",
        initialTarget: initialTarget as Record<string, unknown>,
      }),
    ) as string,
  ) as Json;
}

function announcer(harness: Harness): HTMLElement {
  return harness.document.querySelector("[data-orkestrator-annotation-ui][role='status']")!;
}

function overlay(harness: Harness): HTMLElement {
  return harness
    .ui()
    .find(
      (node) =>
        (node as HTMLElement).style.cursor === "default" &&
        (node as HTMLElement).style.display === "block",
    ) as HTMLElement;
}

describe("click suppression at the earliest point", () => {
  test("element mode covers the page with an inspector overlay and swallows events at window capture", () => {
    const harness = page(`<button id="buy">Buy now</button>`);
    const button = harness.document.querySelector("button")!;
    const seen: string[] = [];
    let earlyTarget: EventTarget | null = null;
    // Registered before the runtime: it still runs first, but only sees the overlay.
    harness.window.addEventListener(
      "click",
      (event) => {
        earlyTarget = event.target;
      },
      true,
    );
    harness.document.addEventListener("pointerdown", () => seen.push("document pointerdown"), true);
    harness.document.addEventListener("click", () => seen.push("document click"), true);
    button.addEventListener("click", () => seen.push("button click"));
    harness.start("element");
    // Registered after the runtime: never reached.
    harness.window.addEventListener("click", () => seen.push("late window click"), true);

    const cover = overlay(harness);
    expect(cover).toBeDefined();
    expect(cover.style.inset).toBe("0");
    expect(cover.style.pointerEvents).not.toBe("none");

    // Chromium delivers the pointer to the overlay; the element under it is chosen by hit test.
    harness.point(button);
    for (const type of ["pointerdown", "mousedown"]) {
      cover.dispatchEvent(
        trusted(new harness.window.PointerEvent(type, { bubbles: true, cancelable: true })),
      );
    }
    const selectClick = trusted(
      new harness.window.MouseEvent("click", {
        clientX: 5,
        clientY: 5,
        bubbles: true,
        cancelable: true,
      }),
    );
    cover.dispatchEvent(selectClick);

    expect(earlyTarget === cover).toBe(true);
    expect(selectClick.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    const status = JSON.parse(
      harness.window.eval(
        "JSON.stringify(window.__orkestratorCaptureRuntime__.status())",
      ) as string,
    );
    expect(status.status).toBe("selected");
    expect(status.selection.target.label).toBe("button “Buy now”");
  });

  test("events dispatched on the page element itself are stopped before document listeners", () => {
    const harness = page(`<a href="/checkout">Checkout</a>`);
    const link = harness.document.querySelector("a")!;
    const seen: string[] = [];
    harness.document.addEventListener("click", () => seen.push("document capture"), true);
    link.addEventListener("click", () => seen.push("link"));
    harness.start("element");
    const event = click(harness, link);
    expect(event.defaultPrevented).toBe(true);
    expect(seen).toEqual([]);
    harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    expect(harness.ui()).toHaveLength(0);
  });
});

describe("keyboard-only element selection", () => {
  test("starts at the element in the viewport centre and announces it", () => {
    const harness = page(`<main><h1>Billing</h1><button>Upgrade</button></main>`);
    const heading = harness.document.querySelector("h1")!;
    harness.point(heading);
    harness.start("element");
    expect(announcer(harness).textContent).toBe("heading “Billing”");
    expect(announcer(harness).getAttribute("aria-live")).toBe("polite");
    key(harness, "Enter");
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.anchor.semantic.tagName).toBe("h1");
  });

  test("Left and Right move between siblings, Up and Down between parent and child", () => {
    const harness = page(`<ul><li>One</li><li>Two</li><li>Three</li></ul>`);
    const items = harness.document.querySelectorAll("li");
    harness.point(items[0]!);
    harness.start("element");
    key(harness, "ArrowRight");
    key(harness, "ArrowRight");
    expect(announcer(harness).textContent).toBe("listitem “Three”");
    key(harness, "ArrowRight");
    expect(announcer(harness).textContent).toBe("listitem “Three”");
    key(harness, "ArrowLeft");
    key(harness, "ArrowUp");
    expect(announcer(harness).textContent).toStartWith("list");
    key(harness, "ArrowDown");
    expect(announcer(harness).textContent).toBe("listitem “Two”");
    key(harness, "Enter");
    expect(harness.status().selection.target.label).toBe("listitem “Two”");
  });

  test("with no focus and nothing under the centre, the first body element is the candidate", () => {
    const harness = page(`<section><p>Only text</p></section>`);
    harness.point(null);
    harness.start("element");
    key(harness, "Enter");
    expect(harness.status().selection.target.anchor.semantic.tagName).toBe("section");
  });

  test("Escape cancels a keyboard selection", () => {
    const harness = page(`<button>Save</button>`);
    harness.point(harness.document.querySelector("button"));
    harness.start("element");
    key(harness, "Escape");
    expect(harness.status().status).toBe("cancelled");
  });
});

describe("keyboard-only region selection", () => {
  test("Enter proposes a centred region, arrows move, Shift+arrows resize, Enter captures", () => {
    const harness = page(`<canvas width="400" height="300"></canvas>`);
    harness.start("region");
    key(harness, "Enter");
    expect(harness.status().status).toBe("selecting");
    expect(announcer(harness).textContent).toContain("Region 341 by 240");
    key(harness, "ArrowRight");
    keyWith(harness, "ArrowDown", { shiftKey: true });
    keyWith(harness, "ArrowLeft", { altKey: true });
    key(harness, "Enter");
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target).toEqual({
      kind: "region",
      label: "Region 341×250",
      rect: { x: 351, y: 264, width: 341, height: 250 },
      imageRect: null,
    });
  });

  test("an arrow key alone also starts a region", () => {
    const harness = page(`<div></div>`);
    harness.start("region");
    key(harness, "ArrowUp");
    key(harness, "Enter");
    expect(harness.status().selection.target.rect).toEqual({
      x: 342,
      y: 254,
      width: 341,
      height: 240,
    });
  });
});

describe("recapture starts on the previous target", () => {
  test("element: the resolved previous target is the first candidate", () => {
    const harness = page(`<button data-testid="save">Save</button><button>Other</button>`);
    const target = captureElement(harness, harness.document.querySelector("button")!);
    harness.point(harness.document.querySelectorAll("button")[1]!);
    startWith(harness, "element", { kind: "element", anchor: target.anchor });
    key(harness, "Enter");
    expect(harness.status().selection.target.anchor.stableId).toEqual({
      kind: "test-id",
      value: "save",
    });
  });

  test("region: the previous rectangle is proposed and Enter confirms it", () => {
    const harness = page(`<canvas></canvas>`);
    startWith(harness, "region", {
      kind: "region",
      rect: { x: 20, y: 30, width: 200, height: 100 },
    });
    key(harness, "Enter");
    expect(harness.status().selection.target.rect).toEqual({
      x: 20,
      y: 30,
      width: 200,
      height: 100,
    });
  });

  test("text: the previous quote is preselected when it still resolves", () => {
    const harness = page(`<p>Pro is $120 billed annually per seat.</p>`);
    startWith(harness, "text", {
      kind: "text-range",
      quote: { exact: "billed annually", prefix: "Pro is $120", suffix: "per seat" },
      container: {
        semantic: { tagName: "p", role: null, name: null },
        text: null,
        ancestors: [],
        cssPath: "p",
        scope: { kind: "document" },
      },
    });
    key(harness, "Enter");
    const status = harness.status();
    expect(status.status).toBe("selected");
    expect(status.selection.target.quote.exact).toBe("billed annually");
  });
});

describe("result-capture stability window", () => {
  async function settle(harness: Harness, deadlineMs: number, quietMs: number) {
    const encoded = await (harness.window.eval(
      browserPreviewCaptureSettleScript("capture-1", { deadlineMs, quietMs }),
    ) as Promise<string | null>);
    return encoded ? (JSON.parse(encoded) as Json) : null;
  }

  test("a quiet page settles as stable before the deadline", async () => {
    const harness = page(`<main>Static</main>`);
    harness.start("page");
    const result = await settle(harness, 500, 30);
    expect(result).toMatchObject({ captureId: "capture-1", nonce: "nonce-1", stable: true });
    expect(result!.waitedMs).toBeLessThan(500);
  });

  test("a page that keeps mutating is reported unstable at the deadline", async () => {
    const harness = page(`<main><span id="clock">0</span></main>`);
    harness.start("page");
    const clock = harness.document.getElementById("clock")!;
    let tick = 0;
    const timer = harness.window.setInterval(() => {
      clock.textContent = String((tick += 1));
    }, 5);
    const result = await settle(harness, 150, 60);
    harness.window.clearInterval(timer);
    expect(result).toMatchObject({ stable: false });
  });

  test("settle is bound to the capture id", async () => {
    const harness = page(`<main>Static</main>`);
    harness.start("page");
    const encoded = await (harness.window.eval(
      browserPreviewCaptureSettleScript("capture-other", { deadlineMs: 50, quietMs: 10 }),
    ) as Promise<string | null>);
    expect(encoded).toBe("null");
  });
});

/**
 * Element targets inside same-origin iframes (todo 0047 task 5) in real
 * Chromium, with the page scripts in a CDP isolated world as the desktop runs
 * them, picked with real pointer input, resolved again after a frame
 * navigation and after a reload. happy-dom gives every frame an opaque origin
 * and no `frameElement`, so the same-origin path can only be shown here; the
 * cross-origin and sandboxed frames prove that nothing inside them is read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { WEB_ANNOTATION_MAX_FRAME_DEPTH } from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationTarget } from "@orkestrator/protocol/web-annotations-validation";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCaptureProbeScript,
  browserPreviewCaptureStartScript,
} from "../electron/browser-preview-annotation-script";
import { browserPreviewAnchorKitSource } from "../electron/browser-preview-anchor-script";
import { parseCaptureRuntimeStatus } from "../electron/browser-preview-capture-parse";
import {
  BROWSER_PREVIEW_PINS_CLEAR_SCRIPT,
  BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT,
  browserPreviewPinsShowScript,
} from "../electron/browser-preview-pins-script";

type Json = Record<string, any>;
type Rect = { x: number; y: number; width: number; height: number };

// CI's test job installs no Playwright browsers, so launch whichever Chromium is
// present, as browser-preview-shadow-text.integration.test.ts does.
const CHROMIUM = [
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => existsSync(candidate));

const ORIGIN = "http://frames.fixture.test";
const FOREIGN = "http://other.fixture.test";
const TOP = `<!doctype html>
<html><body style="margin:0;font:16px/1.4 sans-serif">
<h1 style="margin:10px;font-size:20px">Top page</h1>
<button id="save" style="margin:10px">Top save</button>
<iframe id="editor" title="Editor" src="/embed/editor.html"
  style="position:absolute;left:100px;top:120px;width:400px;height:300px;border:5px solid #333;padding:7px"></iframe>
<iframe id="foreign" title="Foreign" src="${FOREIGN}/widget.html"
  style="position:absolute;left:560px;top:120px;width:300px;height:150px;border:0"></iframe>
<iframe id="sandboxed" title="Sandboxed" sandbox="allow-scripts"
  srcdoc="<button style='margin:10px'>Sandboxed secret words</button>"
  style="position:absolute;left:560px;top:300px;width:300px;height:100px;border:0"></iframe>
</body></html>`;
const EDITOR = `<!doctype html>
<html><head><title>Editor</title></head><body style="margin:0;font:16px/1.4 sans-serif">
<div style="height:30px">Editor header</div>
<button id="save" style="margin:10px;width:140px;height:30px">Frame save</button>
<label style="display:block;margin:10px">Secret <input id="pw" type="password" value="hunter2hunter2"></label>
<x-panel id="panel"></x-panel>
<iframe id="nested" title="Nested" srcdoc="<body style='margin:0'><button id='deep' style='margin:8px'>Deep button</button></body>"
  style="display:block;border:0;width:220px;height:50px"></iframe>
<script>
  document.getElementById("panel").attachShadow({ mode: "open" }).innerHTML =
    '<button id="inner" style="margin:10px">Shadow in frame</button>';
</script>
</body></html>`;
// Same structure and labels as the editor, at a different path: a frame that
// navigated here must not stand in for the annotated document.
const OTHER = EDITOR.replace("<title>Editor</title>", "<title>Other</title>");
const WIDGET = `<!doctype html><html><body style="margin:0">
<button id="foreign-button" style="margin:10px">Foreign secret words</button></body></html>`;

const BODIES: Record<string, string> = {
  [`${ORIGIN}/`]: TOP,
  [`${ORIGIN}/embed/editor.html`]: EDITOR,
  [`${ORIGIN}/embed/other.html`]: OTHER,
  [`${FOREIGN}/widget.html`]: WIDGET,
};

/** An element's rectangle in the top viewport, read in the page's own world. */
function topRect(page: Page, path: string[], id: string): Promise<Rect> {
  return page.evaluate<Rect>(`(() => {
    let doc = document;
    let x = 0;
    let y = 0;
    for (const frameId of ${JSON.stringify(path)}) {
      const frame = doc.getElementById(frameId);
      const box = frame.getBoundingClientRect();
      const style = getComputedStyle(frame);
      x += box.left + frame.clientLeft + parseFloat(style.paddingLeft);
      y += box.top + frame.clientTop + parseFloat(style.paddingTop);
      doc = frame.contentDocument;
    }
    const rect = doc.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
    return { x: x + rect.left, y: y + rect.top, width: rect.width, height: rect.height };
  })()`);
}

function expectNear(actual: Rect, expected: Rect): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    expect(Math.abs(actual[key] - expected[key])).toBeLessThanOrEqual(1);
  }
}

class IsolatedPage {
  private contextId = 0;
  private captureCount = 0;
  constructor(
    readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  /** Load the fixture, wait for every frame, and enter a new isolated world. */
  async load(): Promise<void> {
    await this.page.goto(`${ORIGIN}/`, { waitUntil: "load" });
    await this.enterWorld();
  }

  async enterWorld(): Promise<void> {
    const tree = await this.cdp.send("Page.getFrameTree");
    const world = await this.cdp.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: "orkestrator-test",
    });
    this.contextId = world.executionContextId;
  }

  async run(expression: string): Promise<any> {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
      expression,
      contextId: this.contextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  async start(): Promise<string> {
    this.captureCount += 1;
    const captureId = `capture-${this.captureCount}`;
    await this.run(
      browserPreviewCaptureStartScript({ captureId, nonce: "nonce-1", mode: "element" }),
    );
    return captureId;
  }

  /** Click the centre of a rectangle with real pointer input. */
  async clickAt(rect: Rect): Promise<void> {
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await this.page.mouse.move(x, y, { steps: 3 });
    await this.page.mouse.click(x, y);
    await this.page.waitForTimeout(30);
  }

  /** The selection as Electron main accepts it, through the same parser. */
  async selected(captureId: string, cancel = true): Promise<Json> {
    const encoded = await this.run(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT);
    const parsed = parseCaptureRuntimeStatus(encoded, {
      captureId,
      nonce: "nonce-1",
      mode: "element",
    });
    if (parsed.kind !== "selected") throw new Error(`not selected: ${encoded}`);
    if (cancel) await this.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    return parsed.selection as Json;
  }

  async capture(rect: Rect): Promise<Json> {
    const captureId = await this.start();
    await this.clickAt(rect);
    return this.selected(captureId);
  }

  async showPins(target: Json): Promise<Json> {
    const shown = JSON.parse(
      await this.run(
        browserPreviewPinsShowScript({
          queries: [{ annotationId: "annotation-1", number: 1, label: "Target", target }],
          focusedAnnotationId: null,
          scrollIntoView: false,
          limits: { throttleMs: 20 },
        }),
      ),
    ) as { results: Json[] };
    return shown.results[0]!;
  }

  async pinSnapshot(): Promise<Json> {
    return (JSON.parse(await this.run(BROWSER_PREVIEW_PINS_SNAPSHOT_SCRIPT)) as { results: Json[] })
      .results[0]!;
  }

  async resolve(target: Json): Promise<Json> {
    const result = await this.showPins(target);
    await this.run(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
    return result;
  }

  /** Navigate the editor frame from the page and wait for its new document. */
  async navigateEditor(path: string): Promise<void> {
    await this.page.evaluate(
      (next) =>
        new Promise<void>((resolve) => {
          const frame = document.getElementById("editor") as HTMLIFrameElement;
          frame.addEventListener("load", () => resolve(), { once: true });
          frame.src = next;
        }),
      path,
    );
  }

  /** Wait (bounded) until the installed pin layer reports `state`. */
  async pinState(state: string): Promise<Json> {
    let last: Json = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      last = await this.pinSnapshot();
      if (last.state === state) return last;
      await this.page.waitForTimeout(40);
    }
    return last;
  }
}

describe.skipIf(!CHROMIUM)("element targets inside iframes, in Chromium", () => {
  let browser: Browser;
  let isolated: IsolatedPage;

  // The launch is a real Chromium process, so its duration is the host's;
  // these are hang watchdogs naming the stalled step, as in the shadow-text
  // integration file (flake 9930), never a speed bound.
  const LAUNCH_WATCHDOG_MS = 120_000;
  const STEP_WATCHDOG_MS = 45_000;
  const SETUP_BUDGET_MS = LAUNCH_WATCHDOG_MS + 60_000;
  const phase = async <T>(
    name: string,
    work: Promise<T>,
    watchdogMs = STEP_WATCHDOG_MS,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Chromium setup stalled at: ${name}`)), watchdogMs);
    });
    try {
      return await Promise.race([work, stalled]);
    } finally {
      clearTimeout(timer);
    }
  };
  beforeAll(async () => {
    browser = await phase(
      "launch",
      chromium.launch({ executablePath: CHROMIUM }),
      LAUNCH_WATCHDOG_MS,
    );
    const page = await phase(
      "new page",
      browser.newPage({ viewport: { width: 1000, height: 700 } }),
    );
    await phase(
      "route",
      page.context().route("**/*", (route) => {
        const body =
          BODIES[route.request().url()] ??
          (route.request().url().startsWith(`${ORIGIN}/embed/`) ? EDITOR : undefined);
        return body === undefined
          ? route.fulfill({ status: 404, body: "" })
          : route.fulfill({ contentType: "text/html", body });
      }),
    );
    isolated = new IsolatedPage(
      page,
      await phase("CDP session", page.context().newCDPSession(page)),
    );
  }, SETUP_BUDGET_MS);
  afterAll(async () => {
    await browser?.close();
  });

  test("the isolated world reads a same-origin frame's document, never a cross-origin or sandboxed one", async () => {
    await isolated.load();
    expect(
      JSON.parse(
        await isolated.run(`JSON.stringify({
          editor: Boolean(document.getElementById("editor").contentDocument),
          foreign: document.getElementById("foreign").contentDocument,
          sandboxed: document.getElementById("sandboxed").contentDocument,
          frameDepth: ${browserPreviewAnchorKitSource()}().MAX_FRAME_DEPTH,
        })`),
      ),
    ).toEqual({
      editor: true,
      foreign: null,
      sandboxed: null,
      frameDepth: WEB_ANNOTATION_MAX_FRAME_DEPTH,
    });
  });

  test("a click inside a same-origin frame selects the element there, with the frame path", async () => {
    await isolated.load();
    const expected = await topRect(isolated.page, ["editor"], "save");
    const selection = await isolated.capture(expected);
    const target = selection.target;
    expect(isWebAnnotationTarget(target)).toBe(true);
    expect(target.label).toBe("button “Frame save”");
    expect(target.anchor.stableId).toEqual({ kind: "id", value: "save" });
    expect(target.anchor.scope).toEqual({
      kind: "frame",
      path: [
        {
          boundary: "frame",
          tagName: "iframe",
          stableId: { kind: "id", value: "editor" },
          cssPath: "iframe#editor",
          documentPath: "/embed/editor.html",
          documentIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    // The rectangle is mapped out of the frame, through its border and padding.
    expectNear(target.rect, expected);
    // The frame is named among the ancestors; its <html> and <body> are not.
    expect(target.anchor.ancestors.map((ancestor: Json) => ancestor.tagName)).toEqual(["iframe"]);
    expect(selection.evidence.text).toBe("Frame save");
  });

  test("the saved target resolves inside the frame, never to the top page's element with the same id", async () => {
    await isolated.load();
    const expected = await topRect(isolated.page, ["editor"], "save");
    const { target } = await isolated.capture(expected);
    const resolved = await isolated.resolve(target);
    expect(resolved.state).toBe("matched");
    expect(resolved.rule).toBe("stable-id");
    expectNear(resolved.rect, expected);

    // After a reload the same anchor resolves again from a fresh world.
    await isolated.load();
    const reloaded = await isolated.resolve(target);
    expect(reloaded.state).toBe("matched");
    expectNear(reloaded.rect, expected);
  });

  test("a scaled frame maps the pointer in and the rectangle out", async () => {
    await isolated.load();
    await isolated.page.evaluate(() => {
      const frame = document.getElementById("editor")!;
      frame.style.transformOrigin = "0 0";
      frame.style.transform = "scale(0.5)";
    });
    const unscaled = await isolated.page.evaluate<Rect>(`(() => {
      const frame = document.getElementById("editor");
      const box = frame.getBoundingClientRect();
      const rect = frame.contentDocument.getElementById("save").getBoundingClientRect();
      const scale = box.width / frame.offsetWidth;
      return {
        x: box.left + 12 * scale + rect.left * scale,
        y: box.top + 12 * scale + rect.top * scale,
        width: rect.width * scale,
        height: rect.height * scale,
      };
    })()`);
    const { target } = await isolated.capture(unscaled);
    expect(target.label).toBe("button “Frame save”");
    expectNear(target.rect, unscaled);
  });

  test("nested frames and shadow roots inside a frame give a mixed root path", async () => {
    await isolated.load();
    const deep = (
      await isolated.capture(await topRect(isolated.page, ["editor", "nested"], "deep"))
    ).target;
    expect(deep.label).toBe("button “Deep button”");
    expect(deep.anchor.scope.path.map((step: Json) => [step.boundary, step.documentPath])).toEqual([
      ["frame", "/embed/editor.html"],
      ["frame", "about:srcdoc"],
    ]);
    expect((await isolated.resolve(deep)).state).toBe("matched");

    const innerRect = await isolated.page.evaluate<Rect>(`(() => {
      const frame = document.getElementById("editor");
      const box = frame.getBoundingClientRect();
      const inner = frame.contentDocument.getElementById("panel").shadowRoot.getElementById("inner");
      const rect = inner.getBoundingClientRect();
      return { x: box.left + 12 + rect.left, y: box.top + 12 + rect.top, width: rect.width, height: rect.height };
    })()`);
    const inner = (await isolated.capture(innerRect)).target;
    expect(inner.label).toBe("button “Shadow in frame”");
    expect(inner.anchor.scope.path).toEqual([
      expect.objectContaining({ boundary: "frame", documentPath: "/embed/editor.html" }),
      {
        boundary: "shadow",
        tagName: "x-panel",
        stableId: { kind: "id", value: "panel" },
        cssPath: "x-panel#panel",
      },
    ]);
    const resolved = await isolated.resolve(inner);
    expect(resolved.state).toBe("matched");
    expectNear(resolved.rect, innerRect);
  });

  test("a frame that navigated elsewhere never stands in for the annotated document", async () => {
    await isolated.load();
    const expected = await topRect(isolated.page, ["editor"], "save");
    const { target } = await isolated.capture(expected);
    expect((await isolated.showPins(target)).state).toBe("matched");

    // The installed pin layer re-resolves when the frame loads a new document.
    await isolated.navigateEditor("/embed/other.html");
    expect((await isolated.pinState("missing")).state).toBe("missing");
    await isolated.navigateEditor("/embed/editor.html");
    const back = await isolated.pinState("matched");
    expect(back.state).toBe("matched");
    expectNear(back.rect, expected);
    await isolated.run(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
  });

  test("query and redacted-path navigation invalidate pins; exact URL reload recovers", async () => {
    for (const [first, second] of [
      ["/embed/editor.html?record=1", "/embed/editor.html?record=2"],
      [`/embed/${"a".repeat(40)}`, `/embed/${"b".repeat(40)}`],
    ]) {
      await isolated.load();
      await isolated.navigateEditor(first!);
      const { target } = await isolated.capture(await topRect(isolated.page, ["editor"], "save"));
      expect((await isolated.showPins(target)).state).toBe("matched");
      await isolated.navigateEditor(second!);
      expect((await isolated.pinState("missing")).state).toBe("missing");
      await isolated.navigateEditor(first!);
      expect((await isolated.pinState("matched")).state).toBe("matched");
      await isolated.run(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
    }
  });

  test("fully clipped pins hide on each edge and recover, with frame layout redraws", async () => {
    await isolated.load();
    const { target } = await isolated.capture(await topRect(isolated.page, ["editor"], "save"));
    await isolated.showPins(target);
    const display = () =>
      isolated.run(`document.querySelector('[data-orkestrator-pins] [role=img]')?.style.display`);
    for (const [left, top] of [
      [-500, 40],
      [500, 40],
      [10, -500],
      [10, 500],
    ]) {
      await isolated.page.evaluate(
        ({ left, top }) => {
          const doc = (document.getElementById("editor") as HTMLIFrameElement).contentDocument!;
          const button = doc.getElementById("save")!;
          button.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:140px;height:30px`;
          doc.dispatchEvent(new Event("scroll"));
        },
        { left, top },
      );
      await isolated.page.waitForTimeout(80);
      expect(await display()).toBe("none");
    }
    await isolated.page.evaluate(() => {
      const doc = (document.getElementById("editor") as HTMLIFrameElement).contentDocument!;
      doc.getElementById("save")!.style.cssText =
        "position:fixed;left:10px;top:40px;width:140px;height:30px";
      doc.dispatchEvent(new Event("scroll"));
    });
    await isolated.page.waitForTimeout(80);
    expect(await display()).toBe("block");
    // Attribute edits do not trigger the mutation observer. Font completion
    // and frame-window resize must independently schedule placement.
    for (const event of ["font", "resize"]) {
      await isolated.page.evaluate((event) => {
        const frame = document.getElementById("editor") as HTMLIFrameElement;
        frame.contentDocument!.getElementById("save")!.style.top =
          event === "font" ? "80px" : "120px";
        if (event === "font") frame.contentDocument!.fonts.dispatchEvent(new Event("loadingdone"));
        else frame.contentWindow!.dispatchEvent(new Event("resize"));
      }, event);
      await isolated.page.waitForTimeout(80);
      expectNear(
        (await isolated.pinSnapshot()).rect,
        await topRect(isolated.page, ["editor"], "save"),
      );
    }
    await isolated.page.evaluate(() => {
      const f = document.getElementById("editor") as HTMLIFrameElement;
      f.contentDocument!.getElementById("save")!.style.cssText =
        "position:fixed;bottom:10px;left:10px;width:140px;height:30px";
      f.style.height = "220px";
    });
    await isolated.page.waitForTimeout(100);
    expectNear(
      (await isolated.pinSnapshot()).rect,
      await topRect(isolated.page, ["editor"], "save"),
    );
    mkdirSync("output/visual-previews", { recursive: true });
    await isolated.page.screenshot({
      path: "output/visual-previews/frame-pin-visible-desktop.png",
    });
    const font = readFileSync("apps/web/src/assets/fonts/FiraCodeNerdFont-Regular.woff2").toString(
      "base64",
    );
    await isolated.page.evaluate(async (font) => {
      const doc = (document.getElementById("editor") as HTMLIFrameElement).contentDocument!;
      const button = doc.getElementById("save")!;
      button.style.cssText = "position:fixed;left:10px;top:40px;font:32px LateFrame, sans-serif";
      const face = new FontFace("LateFrame", `url(data:font/woff2;base64,${font})`);
      doc.fonts.add(face);
      await face.load();
      await doc.fonts.ready;
    }, font);
    await isolated.page.waitForTimeout(100);
    expectNear(
      (await isolated.pinSnapshot()).rect,
      await topRect(isolated.page, ["editor"], "save"),
    );
    await isolated.page.setViewportSize({ width: 600, height: 700 });
    await isolated.page.screenshot({ path: "output/visual-previews/frame-pin-visible-narrow.png" });
    await isolated.page.evaluate(() => {
      const doc = (document.getElementById("editor") as HTMLIFrameElement).contentDocument!;
      doc.getElementById("save")!.style.top = "-500px";
      doc.dispatchEvent(new Event("scroll"));
    });
    await isolated.page.waitForTimeout(80);
    await isolated.page.screenshot({ path: "output/visual-previews/frame-pin-clipped-narrow.png" });
    await isolated.page.setViewportSize({ width: 1000, height: 700 });
    await isolated.run(BROWSER_PREVIEW_PINS_CLEAR_SCRIPT);
  });

  test("a selection whose frame navigates before the screenshot reads as disconnected", async () => {
    await isolated.load();
    const captureId = await isolated.start();
    await isolated.clickAt(await topRect(isolated.page, ["editor"], "save"));
    await isolated.selected(captureId, false);
    const probe = async () =>
      JSON.parse(await isolated.run(browserPreviewCaptureProbeScript(captureId))) as Json;
    expect((await probe()).connected).toBe(true);
    await isolated.navigateEditor("/embed/other.html");
    expect((await probe()).connected).toBe(false);
    await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  });

  test("a sensitive field inside a same-origin frame is masked in top-viewport coordinates", async () => {
    await isolated.load();
    const field = await topRect(isolated.page, ["editor"], "pw");
    const scan = (await isolated.run(`${browserPreviewAnchorKitSource()}().sensitiveScan()`)) as {
      rects: Rect[];
      complete: boolean;
    };
    expect(scan.complete).toBe(true);
    expect(scan.rects).toHaveLength(1);
    expectNear(scan.rects[0]!, field);
  });

  for (const [label, frameId] of [
    ["cross-origin", "foreign"],
    ["sandboxed", "sandboxed"],
  ] as const) {
    test(`a click inside a ${label} frame captures only the frame element, unsupported`, async () => {
      await isolated.load();
      const frameRect = await isolated.page.evaluate<Rect>(`(() => {
        const rect = document.getElementById(${JSON.stringify(frameId)}).getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: 60, height: 40 };
      })()`);
      const selection = await isolated.capture(frameRect);
      const { target } = selection;
      expect(isWebAnnotationTarget(target)).toBe(true);
      expect(target.anchor.semantic.tagName).toBe("iframe");
      expect(target.anchor.scope).toEqual({ kind: "unsupported", reason: "cross-origin" });
      // Nothing from inside the frame reached the selection.
      expect(JSON.stringify(selection)).not.toContain("secret words");
      // Its pin reports the limitation instead of guessing a position.
      expect((await isolated.resolve(target)).state).toBe("unsupported");
    });
  }
});

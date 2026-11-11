/**
 * Text selections inside open shadow roots (todo 2580 (retired) task 2) in real Chromium,
 * with the page scripts in a CDP isolated world as the desktop runs them,
 * selected with real pointer input, and resolved again after a real reload.
 * happy-dom has neither `getComposedRanges` nor selection gestures, which is
 * what `browser-preview-shadow-text.test.ts` stands in for.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { isWebAnnotationTarget } from "@orkestrator/protocol/web-annotations-validation";
import {
  BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT,
  BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT,
  browserPreviewCaptureStartScript,
} from "../electron/browser-preview-annotation-script";
import { parseCaptureRuntimeStatus } from "../electron/browser-preview-capture-parse";
import { browserPreviewPinsShowScript } from "../electron/browser-preview-pins-script";

type Json = Record<string, any>;

// CI's test job installs no Playwright browsers, so launch whichever Chromium is
// present, as private-tmpdir-playwright.integration.test.ts does.
const CHROMIUM = [
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].find((candidate) => existsSync(candidate));

const FIXTURE_URL = "http://shadow-text.fixture.test/";
const FIXTURE = `<!doctype html>
<html><body style="margin:20px;font:20px/1.6 monospace">
<p id="light">Light paragraph before the components</p>
<x-open id="open"></x-open>
<x-closed id="closed"></x-closed>
<p id="after">Light paragraph after the components</p>
<script>
  const open = document.getElementById("open").attachShadow({ mode: "open" });
  open.innerHTML = '<p id="in-open">Open root paragraph of words</p>'
    + 'Bare root text of words'
    + '<x-inner id="inner"></x-inner>'
    + '<x-private id="private">Misleading light text</x-private>'
    + '<p id="outer-after">Outer paragraph after private component</p>'
    + '<div data-sensitive id="secret">Private synthetic value</div>'
    + '<input id="pin" type="password" value="hunter2hunter2">';
  const inner = open.getElementById("inner").attachShadow({ mode: "open" });
  inner.innerHTML = '<p id="in-inner">Nested root paragraph of words</p>';
  const closed = document.getElementById("closed").attachShadow({ mode: "closed" });
  closed.innerHTML = '<p id="in-closed">Closed root paragraph of words</p>';
  window.__closedRoot = closed;
  const nestedClosed = open.getElementById("private").attachShadow({ mode: "closed" });
  nestedClosed.innerHTML = '<p id="in-private">Nested closed paragraph of words</p>';
  window.__nestedClosedRoot = nestedClosed;
</script></body></html>`;

const NODE = {
  inPrivate: `window.__nestedClosedRoot.getElementById("in-private").firstChild`,
  outerAfter: `document.getElementById("open").shadowRoot.getElementById("outer-after").firstChild`,
  light: `document.getElementById("light").firstChild`,
  after: `document.getElementById("after").firstChild`,
  inOpen: `document.getElementById("open").shadowRoot.getElementById("in-open").firstChild`,
  bare: `document.getElementById("open").shadowRoot.getElementById("in-open").nextSibling`,
  inInner: `document.getElementById("open").shadowRoot.getElementById("inner").shadowRoot.getElementById("in-inner").firstChild`,
  secret: `document.getElementById("open").shadowRoot.getElementById("secret").firstChild`,
  inClosed: `window.__closedRoot.getElementById("in-closed").firstChild`,
};

/** Viewport position of `text` inside a node, read in the page's own world. */
function spot(page: Page, node: string, text: string) {
  return page.evaluate<{ left: number; right: number; y: number }>(`(() => {
    const found = ${node};
    const text = ${JSON.stringify(text)};
    const start = found.data.indexOf(text);
    if (start < 0) throw new Error("no such text");
    const range = document.createRange();
    range.setStart(found, start);
    range.setEnd(found, start + text.length);
    const { left, right, top, height } = range.getBoundingClientRect();
    return { left, right, y: top + height / 2 };
  })()`);
}

class IsolatedPage {
  private contextId = 0;
  private captureCount = 0;
  constructor(
    readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  /** Load the fixture and enter a new isolated world, as main does for each document. */
  async load(): Promise<void> {
    await this.page.goto(FIXTURE_URL);
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
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  async start(initialTarget?: Json): Promise<string> {
    this.captureCount += 1;
    const captureId = `capture-${this.captureCount}`;
    await this.page.mouse.click(5, 5);
    await this.run(
      browserPreviewCaptureStartScript({
        captureId,
        nonce: "nonce-1",
        mode: "text",
        ...(initialTarget ? { initialTarget } : {}),
      }),
    );
    return captureId;
  }

  async drag(from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await this.page.mouse.move(from.x, from.y);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps: 5 });
    await this.page.mouse.up();
    await this.page.waitForTimeout(40);
  }

  async selectPhrase(node: string, text: string): Promise<void> {
    const { left, right, y } = await spot(this.page, node, text);
    await this.drag({ x: left + 1, y }, { x: right - 1, y });
  }

  async dragBetween(from: [string, string], to: [string, string]): Promise<void> {
    const start = await spot(this.page, ...from);
    const end = await spot(this.page, ...to);
    await this.drag({ x: start.left + 1, y: start.y }, { x: end.right - 1, y: end.y });
  }

  async status(): Promise<Json> {
    return JSON.parse(await this.run(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT)) as Json;
  }

  /** The target as Electron main accepts it, through the same parser. */
  async selected(captureId: string): Promise<Json> {
    const encoded = await this.run(BROWSER_PREVIEW_CAPTURE_STATUS_SCRIPT);
    const parsed = parseCaptureRuntimeStatus(encoded, {
      captureId,
      nonce: "nonce-1",
      mode: "text",
    });
    if (parsed.kind !== "selected") throw new Error(`not selected: ${encoded}`);
    await this.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    return parsed.selection.target as Json;
  }

  async hint(): Promise<string> {
    return this.page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-orkestrator-annotation-ui]"))
        .map((node) => node.textContent ?? "")
        .join(" "),
    );
  }

  async resolve(target: Json): Promise<Json> {
    const shown = JSON.parse(
      await this.run(
        browserPreviewPinsShowScript({
          queries: [{ annotationId: "annotation-1", number: 1, label: "Quote", target }],
          focusedAnnotationId: null,
          scrollIntoView: false,
        }),
      ),
    ) as { results: Json[] };
    return shown.results[0]!;
  }
}

describe.skipIf(!CHROMIUM)("text selections in an isolated world, in Chromium", () => {
  let browser: Browser;
  let isolated: IsolatedPage;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: CHROMIUM });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route(FIXTURE_URL, (route) =>
      route.fulfill({ contentType: "text/html", body: FIXTURE }),
    );
    isolated = new IsolatedPage(page, await page.context().newCDPSession(page));
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  const reachable = async () => {
    await isolated.load();
    return isolated.run(`JSON.stringify({
      composed: typeof getSelection().getComposedRanges,
      shadowRoot: Boolean(document.getElementById("open").shadowRoot),
      closed: document.getElementById("closed").shadowRoot,
      customElements: window.customElements,
    })`);
  };

  test("the isolated world can read composed ranges and open roots, not closed ones", async () => {
    expect(JSON.parse(await reachable())).toEqual({
      composed: "function",
      shadowRoot: true,
      closed: null,
      customElements: null,
    });
  }, 30_000);

  for (const [name, node, words, tagName, hosts] of [
    ["an open root", NODE.inOpen, "paragraph of", "p", ["x-open"]],
    ["a nested open root", NODE.inInner, "paragraph of", "p", ["x-open", "x-inner"]],
    ["the top level of an open root", NODE.bare, "text of", "x-open", ["x-open"]],
  ] as const) {
    test(`a quote in ${name} resolves again after a reload`, async () => {
      await isolated.load();
      const captureId = await isolated.start();
      await isolated.selectPhrase(node, words);
      const target = await isolated.selected(captureId);

      expect(target.quote.exact).toBe(words);
      expect(isWebAnnotationTarget(target)).toBe(true);
      expect(target.container.semantic.tagName).toBe(tagName);
      expect(target.container.scope.hosts.map((host: Json) => host.tagName)).toEqual([...hosts]);

      const live = await isolated.resolve(target);
      expect(live).toMatchObject({ state: "matched", rule: "text-quote" });

      await isolated.load();
      const expected = await spot(isolated.page, node, words);
      const reloaded = await isolated.resolve(target);
      expect(reloaded).toMatchObject({ state: "matched", rule: "text-quote", candidateCount: 1 });
      expect(Math.abs(reloaded.rect.x - expected.left)).toBeLessThan(1);
      expect(reloaded.rect.width).toBeCloseTo(expected.right - expected.left, 0);
    }, 30_000);
  }

  test("recapture preselects a quote inside a root after a reload", async () => {
    await isolated.load();
    const first = await isolated.start();
    await isolated.selectPhrase(NODE.inInner, "paragraph of");
    const target = await isolated.selected(first);

    await isolated.load();
    const again = await isolated.start(target);
    await isolated.page.keyboard.press("Enter");
    await isolated.page.waitForTimeout(40);
    const recaptured = await isolated.selected(again);
    expect(recaptured.quote).toEqual(target.quote);
    expect(recaptured.container.scope).toEqual(target.container.scope);
  }, 30_000);

  for (const [name, from, to] of [
    ["light into an open root", [NODE.light, "paragraph"], [NODE.inOpen, "paragraph"]],
    ["an open root out to light", [NODE.inOpen, "paragraph"], [NODE.after, "paragraph"]],
    ["a root into its nested root", [NODE.inOpen, "paragraph"], [NODE.inInner, "paragraph"]],
    ["outer open into nested closed", [NODE.inOpen, "paragraph"], [NODE.inPrivate, "paragraph"]],
    [
      "nested closed out to outer open",
      [NODE.inPrivate, "paragraph"],
      [NODE.outerAfter, "paragraph"],
    ],
    ["light into a closed root", [NODE.light, "paragraph"], [NODE.inClosed, "paragraph"]],
  ] as const) {
    test(`a selection from ${name} stays unsupported`, async () => {
      await isolated.load();
      await isolated.start();
      await isolated.dragBetween([...from] as [string, string], [...to] as [string, string]);
      const status = await isolated.status();
      expect(status.status).toBe("selecting");
      expect(status.selection).toBeUndefined();
      expect(await isolated.hint()).toContain("This text can't be captured; try Region");
      await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    }, 30_000);
  }

  test("a selection inside a closed root is refused and not read", async () => {
    await isolated.load();
    await isolated.start();
    await isolated.selectPhrase(NODE.inClosed, "paragraph of");
    const status = await isolated.status();
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("paragraph");
    expect(await isolated.hint()).toContain("This text can't be captured");
    await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  }, 30_000);

  for (const gesture of ["drag", "double-click"] as const) {
    test(`a ${gesture} inside a nested closed root is refused`, async () => {
      await isolated.load();
      await isolated.start();
      if (gesture === "drag") await isolated.selectPhrase(NODE.inPrivate, "paragraph of");
      else {
        const word = await spot(isolated.page, NODE.inPrivate, "paragraph");
        await isolated.page.mouse.click(word.left + 5, word.y, { clickCount: 2 });
        await isolated.page.waitForTimeout(40);
      }
      const status = await isolated.status();
      expect(status.status).toBe("selecting");
      expect(status.selection).toBeUndefined();
      expect(await isolated.hint()).toContain("This text can't be captured");
      await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
    }, 30_000);
  }

  test("sensitive content inside a root stays refused", async () => {
    await isolated.load();
    await isolated.start();
    await isolated.selectPhrase(NODE.secret, "synthetic");
    let status = await isolated.status();
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("synthetic");
    expect(await isolated.hint()).toContain("Sensitive fields can't be captured");
    await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);

    await isolated.start();
    const field = await isolated.page.evaluate(() => {
      const box = document
        .getElementById("open")!
        .shadowRoot!.getElementById("pin")!
        .getBoundingClientRect();
      return { x: box.left + 2, right: box.right - 2, y: box.top + box.height / 2 };
    });
    await isolated.drag({ x: field.x, y: field.y }, { x: field.right, y: field.y });
    status = await isolated.status();
    expect(status.status).toBe("selecting");
    expect(JSON.stringify(status)).not.toContain("hunter2");
    expect(await isolated.hint()).toContain("Sensitive fields can't be captured");
    await isolated.run(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  }, 30_000);

  test("document selections by drag, double click and triple click still capture", async () => {
    await isolated.load();
    const dragged = await isolated.start();
    await isolated.selectPhrase(NODE.light, "paragraph before");
    const target = await isolated.selected(dragged);
    expect(target.quote.exact).toBe("paragraph before");
    expect(target.container.scope).toEqual({ kind: "document" });
    expect(target.container.cssPath).toBe("p#light");

    await isolated.load();
    expect(await isolated.resolve(target)).toMatchObject({ state: "matched", rule: "text-quote" });

    const word = await spot(isolated.page, NODE.after, "paragraph");
    for (const [clickCount, exact] of [
      [2, "paragraph"],
      [3, "Light paragraph after the components"],
    ] as const) {
      const captureId = await isolated.start();
      await isolated.page.mouse.click(word.left + 5, word.y, { clickCount });
      await isolated.page.waitForTimeout(40);
      const clicked = await isolated.selected(captureId);
      expect(clicked.quote.exact).toBe(exact);
      expect(clicked.container.scope).toEqual({ kind: "document" });
    }
  }, 30_000);

  test("select all still captures the light text and no component's", async () => {
    await isolated.load();
    const captureId = await isolated.start();
    await isolated.page.keyboard.press("ControlOrMeta+a");
    await isolated.page.keyboard.press("Enter");
    await isolated.page.waitForTimeout(40);
    const target = await isolated.selected(captureId);
    expect(target.container.scope).toEqual({ kind: "document" });
    expect(target.quote.exact).toStartWith("Light paragraph before the components");
    expect(target.quote.exact).toEndWith("Light paragraph after the components");
    expect(target.quote.exact).not.toContain("Open root");
    expect(target.quote.exact).not.toContain("Closed root");
  }, 30_000);

  test("recapture preselects a document quote after a reload", async () => {
    await isolated.load();
    const first = await isolated.start();
    await isolated.selectPhrase(NODE.light, "paragraph before");
    const target = await isolated.selected(first);

    await isolated.load();
    const again = await isolated.start(target);
    await isolated.page.keyboard.press("Enter");
    await isolated.page.waitForTimeout(40);
    expect((await isolated.selected(again)).quote).toEqual(target.quote);
  }, 30_000);

  test("a light selection dragged over the hosts keeps only the light text", async () => {
    await isolated.load();
    const captureId = await isolated.start();
    await isolated.dragBetween([NODE.light, "components"], [NODE.after, "Light"]);
    const target = await isolated.selected(captureId);
    expect(target.quote.exact).toBe("components Light");
    expect(target.container.scope).toEqual({ kind: "document" });
  }, 30_000);
});

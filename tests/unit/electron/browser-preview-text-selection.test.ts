import { describe, expect, test } from "bun:test";
import { BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT } from "../../../apps/desktop/electron/browser-preview-annotation-script";
import { key, page, type Json } from "./browser-preview-page-harness";

type Harness = ReturnType<typeof page>;

/** Select from (node, offset) to (node, offset) and confirm with Enter. */
function selectText(harness: Harness, start: [Node, number], end: [Node, number]): Json {
  harness.start("text");
  const range = harness.document.createRange();
  range.setStart(start[0], start[1]);
  range.setEnd(end[0], end[1]);
  harness.window.getSelection()!.removeAllRanges();
  harness.window.getSelection()!.addRange(range);
  key(harness, "Enter");
  const status = harness.status();
  expect(status.status).toBe("selected");
  harness.window.eval(BROWSER_PREVIEW_CAPTURE_CANCEL_SCRIPT);
  harness.window.getSelection()!.removeAllRanges();
  return status.selection.target as Json;
}

function resolve(harness: Harness, target: Json): Json {
  return harness.pins([
    {
      annotationId: "annotation-1",
      number: 1,
      target: { kind: "text-range", quote: target.quote, container: target.container },
    },
  ])[0]!;
}

function textNode(harness: Harness, selector: string, index = 0): Text {
  return harness.document.querySelectorAll(selector)[index]!.firstChild as Text;
}

function hasLoneSurrogate(value: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

describe("text-range capture", () => {
  test("a selection across paragraphs is one quote with a block boundary and re-resolves", () => {
    const harness = page(`<article><p>First line of copy</p><p>Second line here</p></article>`);
    const first = textNode(harness, "p", 0);
    const second = textNode(harness, "p", 1);
    const target = selectText(harness, [first, 6], [second, 6]);
    expect(target.quote.exact).toBe("line of copy Second");
    expect(target.quote.prefix).toBe("First");
    expect(target.quote.suffix.startsWith("line here")).toBe(true);
    expect(target.container.semantic.tagName).toBe("article");
    expect(resolve(harness, target)).toMatchObject({ state: "matched", rule: "text-quote" });
  });

  test("a line break and nested inline elements are normalized to single spaces", () => {
    const harness = page(`<p id="copy">Line <strong>one</strong><br>Line <em>two</em> ends</p>`);
    const strong = textNode(harness, "strong");
    const em = textNode(harness, "em");
    const target = selectText(harness, [strong, 0], [em, 3]);
    expect(target.quote.exact).toBe("one Line two");
    expect(resolve(harness, target)).toMatchObject({ state: "matched" });
  });

  test("right-to-left and mixed-direction text keeps its logical order", () => {
    const harness = page(
      `<p dir="rtl" id="greeting">مرحبا بالعالم الجميل</p><p>Price: <bdi>שלום</bdi> 300 per month</p>`,
    );
    const arabic = textNode(harness, "#greeting");
    const start = arabic.data.indexOf("بالعالم");
    const target = selectText(harness, [arabic, start], [arabic, start + "بالعالم".length]);
    expect(target.quote.exact).toBe("بالعالم");
    expect(target.quote.prefix).toBe("مرحبا");
    expect(target.quote.suffix.startsWith("الجميل Price: שלום 300")).toBe(true);
    expect(target.label).toBe("“بالعالم”");
    expect(resolve(harness, target)).toMatchObject({ state: "matched", rule: "text-quote" });

    const hebrew = textNode(harness, "bdi");
    const mixed = selectText(harness, [hebrew, 0], [hebrew.parentNode!.parentNode!.lastChild!, 4]);
    expect(mixed.quote.exact).toBe("שלום 300");
    expect(resolve(harness, mixed)).toMatchObject({ state: "matched" });
  });

  test("emoji, combining marks, and astral characters survive bounds without split surrogates", () => {
    const family = "👩‍👩‍👧";
    const decomposed = "déjà vu";
    const long = `${"🚀".repeat(80)} launch`;
    const harness = page(`<p id="a">Café ${family} ${decomposed} today</p><p id="b">${long}</p>`);
    const a = textNode(harness, "#a");
    const from = a.data.indexOf(family);
    const to = a.data.indexOf(" today");
    const target = selectText(harness, [a, from], [a, to]);
    expect(target.quote.exact).toBe(`${family} ${decomposed}`);
    expect(resolve(harness, target)).toMatchObject({ state: "matched" });

    const b = textNode(harness, "#b");
    const rockets = selectText(harness, [b, 0], [b, b.data.length]);
    // The label is shortened on a character boundary, never inside a surrogate pair.
    expect(rockets.label.endsWith("…”")).toBe(true);
    expect(hasLoneSurrogate(rockets.label)).toBe(false);
    expect(hasLoneSurrogate(rockets.quote.exact)).toBe(false);
  });

  test("a selection beyond the text budget is bounded and still re-resolves by its context", () => {
    const words = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
    const harness = page(`<p>Intro sentence.</p><p id="long">${words}</p><p>Outro.</p>`);
    const long = textNode(harness, "#long");
    const target = selectText(harness, [long, 0], [long, long.data.length]);
    expect(long.data.length).toBeGreaterThan(5_000);
    expect(target.quote.exact.length).toBeLessThanOrEqual(1_200);
    expect(target.quote.exact.startsWith("word0 word1")).toBe(true);
    expect(target.quote.prefix).toBe("Intro sentence.");
    expect(JSON.stringify(harness.status()).length).toBeLessThan(65_536);
    expect(resolve(harness, target)).toMatchObject({ state: "matched", rule: "text-quote" });
  });
});

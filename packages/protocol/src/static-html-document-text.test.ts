import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDesignRuntime } from "./design-runtime.js";
import { FRAME_CHANNEL_POLICY, STATIC_PRESENTATION_POLICY } from "./rich-content-policy.js";
import { staticHtmlDocumentText } from "./static-html-document-text.js";
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
  installStaticHtmlPresentationRuntime,
} from "./static-html-presentation.js";
import {
  ACTIVITY_REPORT_HTML,
  HOSTILE_REPORT_HTML,
  PLAIN_REPORT_HTML,
} from "./testing/static-html-fixtures.js";

/*
 * The worker reads a document's text at verification; the frame reads it
 * again once the document is shown. Find counts matches in whichever it has,
 * and the frame draws the n-th, so the two walks must agree character for
 * character. These run both for real: the design runtime serializes the
 * effective HTML exactly as the worker stores it, the extraction runs on it
 * as the worker runs it (serialized, in a page of its own), and the
 * presentation runtime renders the same bytes and reports its text.
 */

const NONCE = "a".repeat(32);
const GENERATION = "g".repeat(32);
const MAX = STATIC_PRESENTATION_POLICY.maxSearchTextCharacters;

/** What the design runtime stores as `effective-html` for an authored document. */
function effectiveHtml(html: string): string {
  const design = new Window();
  design.eval(`(${installDesignRuntime.toString()})()`);
  const run = (design as unknown as { orkDesign: (operation: unknown) => unknown }).orkDesign;
  run({ op: "render", html });
  return run({ op: "serialize" }) as string;
}

/** The extraction as the worker runs it: serialized into a page with no other code. */
function extracted(html: string, maxCharacters = MAX): string {
  const page = new Window();
  return page.eval(
    `(${staticHtmlDocumentText.toString()})(${JSON.stringify({ html, maxCharacters })})`,
  ) as string;
}

/** The text the presentation runtime reports from its frame for the same bytes. */
function framed(html: string): string {
  const frame = new Window({ url: "https://frame.invalid/doc" });
  frame.eval(
    "window.__posted = []; window.parent = { postMessage: (message) => window.__posted.push(message) };",
  );
  frame.eval(
    `(${installStaticHtmlPresentationRuntime.toString()})(${JSON.stringify({
      nonce: NONCE,
      maxHtmlBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes,
      maxElements: STATIC_PRESENTATION_POLICY.maxElements,
      maxLinkCharacters: FRAME_CHANNEL_POLICY.maxLinkCharacters,
      maxReportedHeight: 100_000,
      maxTextCharacters: MAX,
      textChunkCharacters: STATIC_PRESENTATION_POLICY.searchTextChunkCharacters,
      maxFindQueryCharacters: STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
    })})`,
  );
  frame.dispatchEvent(
    new frame.MessageEvent("message", {
      data: {
        channel: STATIC_HTML_FRAME_CHANNEL,
        v: 1,
        type: "render",
        generation: GENERATION,
        html,
        theme: { appearance: "light", reducedMotion: false, tokens: {} },
        verifiedAppearance: "light",
      },
      source: frame.parent as never,
    }),
  );
  const posted = frame.eval("window.__posted") as Array<{ type: string; text?: string }>;
  return posted
    .filter((message) => message.type === "text")
    .map((message) => message.text)
    .join("");
}

function expectAgreement(authored: string): string {
  const effective = effectiveHtml(authored);
  const text = extracted(effective);
  expect(text).toBe(framed(effective));
  return text;
}

describe("the stored document text agrees with the frame's", () => {
  test("over the reference, hostile and plain reports", () => {
    expect(expectAgreement(ACTIVITY_REPORT_HTML)).toContain("Agent activity");
    expect(expectAgreement(HOSTILE_REPORT_HTML).length).toBeGreaterThan(0);
    expect(expectAgreement(PLAIN_REPORT_HTML).length).toBeGreaterThan(0);
  });

  test("when markup splits, separates or hides text", () => {
    const text = expectAgreement(
      `<h1>nee<b>dle</b></h1> <p>needle   with\n\nspaces</p>
       <ul><li>one</li><li>two</li></ul>
       <table><tr><td>cell a</td><td>cell b</td></tr></table>
       <details><summary>summary</summary>closed body</details>
       <div hidden>never</div><style>.styled{}</style><noscript>noscript</noscript>
       <svg><text>svg text</text><title>svg title</title></svg>
       <template><p>in template</p></template>`,
    );
    expect(text.startsWith("needle\nneedle with spaces")).toBe(true);
    expect(text).toContain("closed body");
    expect(text).not.toContain("never");
    expect(text).not.toContain("noscript");
    expect(text).not.toContain("in template");
  });

  test("under Unicode and surrogate pairs", () => {
    expectAgreement("<p>İstanbul ſtraße KK 😀 <b>😀</b>emoji</p><p> lead</p>");
  });

  test("a document with no text has none", () => {
    expect(expectAgreement("<div><img alt='x'></div>")).toBe("");
  });

  test("stops at the same character as the frame", () => {
    const text = expectAgreement(`<p>${"x".repeat(MAX - 3)}needle</p><p>after</p>`);
    expect(text).toHaveLength(MAX);
    expect(text.endsWith("xnee")).toBe(true);
    expect(extracted("<p>abcdef</p>", 3)).toBe("abc");
    expect(extracted("<p>abcdef</p>", 0)).toBe("");
  });
});

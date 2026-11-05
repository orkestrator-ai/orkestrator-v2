import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  FRAME_CHANNEL_POLICY,
  STATIC_PRESENTATION_POLICY,
} from "@orkestrator/protocol/rich-content-policy";
import {
  STATIC_HTML_FRAME_CHANNEL,
  STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
  installStaticHtmlPresentationRuntime,
} from "@orkestrator/protocol/static-html-presentation";
import {
  ACTIVITY_REPORT_HTML,
  HOSTILE_REPORT_HTML,
  PLAIN_REPORT_HTML,
} from "@orkestrator/protocol/testing/static-html-fixtures";
import { findAgentChatTextMatches } from "@/components/chat/AgentChatFind";
import { artifactBodySearchText } from "./rich-search-text";

/*
 * Find counts matches in the text a frame reported; the frame draws them on its
 * own document. These run the real runtime against the real matcher: the n-th
 * match Find counts must be the n-th range the frame highlights, or "3 of 12"
 * points at the wrong word.
 */

const NONCE = "a".repeat(32);
const GENERATION = "g".repeat(32);

function renderDocument(html: string) {
  const frame = new Window({ url: "https://frame.invalid/doc" });
  frame.eval(`
    window.__posted = [];
    window.parent = { postMessage: (message) => window.__posted.push(message) };
    window.Highlight = class { constructor() { this.ranges = []; } add(range) { this.ranges.push(range); } };
    Object.defineProperty(window, "CSS", { value: { highlights: new Map() } });
  `);
  frame.eval(
    `(${installStaticHtmlPresentationRuntime.toString()})(${JSON.stringify({
      nonce: NONCE,
      maxHtmlBytes: STATIC_PRESENTATION_POLICY.maxDocumentBytes,
      maxElements: STATIC_PRESENTATION_POLICY.maxElements,
      maxLinkCharacters: FRAME_CHANNEL_POLICY.maxLinkCharacters,
      maxReportedHeight: 100_000,
      maxTextCharacters: STATIC_PRESENTATION_POLICY.maxSearchTextCharacters,
      textChunkCharacters: STATIC_PRESENTATION_POLICY.searchTextChunkCharacters,
      maxFindQueryCharacters: STATIC_HTML_MAX_FIND_QUERY_CHARACTERS,
    })})`,
  );
  const send = (message: Record<string, unknown>) =>
    frame.dispatchEvent(
      new frame.MessageEvent("message", {
        data: { channel: STATIC_HTML_FRAME_CHANNEL, v: 1, generation: GENERATION, ...message },
        source: frame.parent as never,
      }),
    );
  send({
    type: "render",
    html,
    theme: { appearance: "light", reducedMotion: false, tokens: {} },
    verifiedAppearance: "light",
  });
  const posted = frame.eval("window.__posted") as Array<{ type: string; text?: string }>;
  const reported = posted
    .filter((message) => message.type === "text")
    .map((message) => message.text)
    .join("");
  const body = artifactBodySearchText("static-document", reported);
  const highlighted = (name: string): string[] =>
    frame.eval(
      `(window.CSS.highlights.get(${JSON.stringify(name)})?.ranges ?? []).map((range) => range.toString())`,
    ) as string[];
  return { body, send, highlighted };
}

const collapse = (text: string) => text.replace(/\s+/g, " ");

function expectAgreement(html: string, queries: readonly string[]): void {
  const { body, send, highlighted } = renderDocument(html);
  for (const query of queries) {
    const model = findAgentChatTextMatches(body ?? "", query).map(({ characterIndex, length }) =>
      (body ?? "").slice(characterIndex, characterIndex + length),
    );
    send({ type: "find", query, occurrence: null });
    expect(highlighted("ork-find-match").map(collapse)).toEqual(model.map(collapse));
    model.forEach((text, occurrence) => {
      send({ type: "find", query, occurrence });
      expect(highlighted("ork-find-active").map(collapse)).toEqual([collapse(text)]);
    });
  }
}

describe("the frame's ordinals agree with Find's", () => {
  test("over the reference, hostile and plain reports", () => {
    expectAgreement(ACTIVITY_REPORT_HTML, [
      "a",
      "e ",
      "session",
      "COST",
      "$",
      "0.",
      "Agent activity",
    ]);
    expectAgreement(HOSTILE_REPORT_HTML, ["a", "script", "alert", "onerror", "http"]);
    expectAgreement(PLAIN_REPORT_HTML, ["a", "report", " the "]);
  });

  test("when markup splits, separates or hides the matches", () => {
    expectAgreement(
      `<h1>nee<b>dle</b></h1> <p>needle   with\n\nspaces</p>
       <ul><li>needle</li><li>needle</li></ul>
       <table><tr><td>needle</td><td>needle</td></tr></table>
       <details><summary>needle</summary>needle</details>
       <div hidden>needle never</div><style>.needle{}</style><noscript>needle</noscript>
       <svg><text>needle</text><title>needle</title></svg>
       <template><p>needle in template</p></template>`,
      ["needle", "NEEDLE", "with spaces", "needle with", "le "],
    );
  });

  test("where a line break between elements cannot be matched across", () => {
    const { body, send, highlighted } = renderDocument("<p>one</p><p>two</p>");
    expect(body).toBe("one\ntwo");
    send({ type: "find", query: "one two", occurrence: 0 });
    expect(highlighted("ork-find-match")).toEqual([]);
    expect(findAgentChatTextMatches(body!, "one two")).toEqual([]);
  });

  test("under Unicode case folding and literal punctuation", () => {
    expectAgreement("<p>İstanbul ıstanbul ISTANBUL ſtraße STRASSE K\u212A kK a+b A+B [x] $&</p>", [
      "istanbul",
      "s",
      "k",
      "a+b",
      "[x]",
      "$&",
      "ß",
    ]);
    expectAgreement("<p>😀 emoji 😀 <b>😀</b></p>", ["😀", "emoji"]);
  });

  test("past the text limit, where both sides stop at the same character", () => {
    const limit = STATIC_PRESENTATION_POLICY.maxSearchTextCharacters;
    // One match is cut by the limit, so neither side may count it.
    const html = `<p>${"x".repeat(limit - 3)}needle</p>`;
    const { body, send, highlighted } = renderDocument(html);
    expect(body).toHaveLength(limit);
    expect(findAgentChatTextMatches(body!, "needle")).toEqual([]);
    send({ type: "find", query: "needle", occurrence: null });
    expect(highlighted("ork-find-match")).toEqual([]);
    expectAgreement(html, ["nee", "xn"]);
  });
});

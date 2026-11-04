import { describe, expect, test } from "bun:test";
import {
  buildHtmlPreviewDocument,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
} from "./html-preview-document";

function parse(srcDoc: string): Document {
  return new DOMParser().parseFromString(srcDoc, "text/html");
}

describe("buildHtmlPreviewDocument", () => {
  test("grants the sandbox nothing and refuses every external resource", () => {
    expect(HTML_PREVIEW_SANDBOX).toBe("");
    const directives = HTML_PREVIEW_CSP.split("; ");
    expect(directives).toContain("default-src 'none'");
    expect(HTML_PREVIEW_CSP).not.toContain("http");
    expect(HTML_PREVIEW_CSP).not.toContain("'self'");
    expect(HTML_PREVIEW_CSP).not.toContain("script-src");
  });

  test("puts the CSP ahead of anything the file declares", () => {
    const { srcDoc } = buildHtmlPreviewDocument(
      '<!doctype html><html lang="en-GB"><head><title>Report</title><style>p{color:red}</style></head><body><p>Hi</p></body></html>',
    );
    const parsed = parse(srcDoc);
    const first = parsed.head.firstElementChild;
    expect(first?.tagName).toBe("META");
    expect(first?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(first?.getAttribute("content")).toBe(HTML_PREVIEW_CSP);
    expect(parsed.documentElement.getAttribute("lang")).toBe("en-GB");
    expect(parsed.querySelector("style")?.textContent).toBe("p{color:red}");
    expect(parsed.querySelector("p")?.textContent).toBe("Hi");
  });

  test("keeps the doctype and does not invent one", () => {
    expect(buildHtmlPreviewDocument("<!doctype html><p>x</p>").srcDoc).toStartWith(
      "<!DOCTYPE html>",
    );
    expect(buildHtmlPreviewDocument("<p>x</p>").srcDoc).toStartWith("<html");
  });

  test("replaces the file's base so it cannot redirect relative or fragment links", () => {
    const { srcDoc } = buildHtmlPreviewDocument(
      '<head><base href="https://evil.example/" target="_top"></head><a href="#a">a</a>',
    );
    const bases = parse(srcDoc).querySelectorAll("base");
    expect(bases).toHaveLength(1);
    expect(bases[0]?.getAttribute("href")).toBe("about:srcdoc");
    expect(bases[0]?.getAttribute("target")).toBeNull();
  });

  test("fragment links stay in the page and every other link targets a refused popup", () => {
    const { srcDoc } = buildHtmlPreviewDocument(`
      <a id="fragment" href="#summary" target="_top">Summary</a>
      <a id="spaced" href="  #summary">Summary</a>
      <a id="external" href="https://example.com/" target="_self">External</a>
      <a id="relative" href="sibling.html">Sibling</a>
      <a id="script" href="javascript:alert(1)">Script</a>
      <map><area id="area" href="other.html"></map>
    `);
    const parsed = parse(srcDoc);
    expect(parsed.getElementById("fragment")?.getAttribute("target")).toBeNull();
    expect(parsed.getElementById("spaced")?.getAttribute("target")).toBeNull();
    for (const id of ["external", "relative", "script", "area"]) {
      expect(parsed.getElementById(id)?.getAttribute("target")).toBe("_blank");
    }
  });

  test.each([
    ["CSS import", '<style>@import "a.css";</style>'],
    ["CSS background", '<p style="background:url(a.png)">x</p>'],
    ["srcset", '<img srcset="a.png 2x">'],
    ["poster", '<video poster="a.png"></video>'],
    ["SVG image", '<svg><image href="a.png"/></svg>'],
    ["a script", "<script>alert(1)</script>"],
    ["a remote image", '<img src="https://example.com/a.png">'],
    ["a sibling image", '<img src="a.png">'],
    ["a stylesheet", '<link rel="stylesheet" href="a.css">'],
    ["a nested frame", '<iframe src="https://example.com"></iframe>'],
  ])("reports %s as refused content", (_name, html) => {
    expect(buildHtmlPreviewDocument(html).hasRefusedContent).toBe(true);
  });

  test("removes declarative navigation mutation", () => {
    const parsed = parse(
      buildHtmlPreviewDocument(
        '<svg><a href="#safe"><animate attributeName="href" values="https://evil.invalid"/><set attributeName="target" to="_self"/><text>Open</text></a></svg>',
      ).srcDoc,
    );
    expect(parsed.querySelector("animate, set")).toBeNull();
  });

  test("serialized markup is stable on reparse, including namespace mutation", () => {
    const html =
      '<form><math><mtext></form><form><mglyph><style></math><a href="https://evil.invalid/">Mutation</a>';
    const first = buildHtmlPreviewDocument(html);
    expect(buildHtmlPreviewDocument(first.srcDoc).srcDoc).toBe(first.srcDoc);
    for (const link of Array.from(parse(first.srcDoc).querySelectorAll("a"))) {
      expect(link.getAttribute("target")).toBe("_blank");
    }
  });

  test("does not flag inline data or fragment CSS references", () => {
    expect(
      buildHtmlPreviewDocument(
        '<style>p{background:url( "data:image/png;base64,AAAA" );filter:url(#blur)}</style>',
      ).hasRefusedContent,
    ).toBe(false);
  });

  test("does not flag inert JSON-LD", () => {
    expect(
      buildHtmlPreviewDocument('<script type="application/ld+json">{}</script>').hasRefusedContent,
    ).toBe(false);
  });

  test("does not report a self-contained page", () => {
    const { hasRefusedContent } = buildHtmlPreviewDocument(
      '<style>p{color:red}</style><img src="data:image/png;base64,AAAA"><a href="#x">x</a>',
    );
    expect(hasRefusedContent).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import {
  buildHtmlPreviewDocument,
  findSiblingPageLinks,
  findSiblingStylesheetPaths,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SANDBOX,
  resolveSiblingFilePath,
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
    expect(parsed.querySelector("animate, set") === null).toBe(true);
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

describe("resolveSiblingFilePath", () => {
  const page = "design/00000-index.html";

  test.each([
    ["assets/design.css", "design/assets/design.css"],
    ["./assets/design.css?v=2#x", "design/assets/design.css"],
    ["assets/../design.css", "design/design.css"],
    ["a%20b.css", "design/a b.css"],
    ["  design.css  ", "design/design.css"],
  ])("resolves %s inside the page's folder", (href, expected) => {
    expect(resolveSiblingFilePath(page, href)).toBe(expected);
  });

  test("resolves against the workspace root for a page there", () => {
    expect(resolveSiblingFilePath("index.html", "a.css")).toBe("a.css");
  });

  test.each([
    ["a parent folder", "../other/a.css"],
    ["a parent folder, escaped", "%2e%2e/a.css"],
    ["a climb past the folder after descending", "assets/../../a.css"],
    ["an absolute path", "/etc/passwd"],
    ["a network path", "//evil.invalid/a.css"],
    ["an http URL", "https://evil.invalid/a.css"],
    ["a file URL", "file:///etc/passwd"],
    ["a data URL", "data:text/css,p{}"],
    ["a Windows drive", "C:/a.css"],
    ["a backslash path", "assets\\a.css"],
    ["an encoded separator climb", "..%2fa.css"],
    ["a fragment", "#top"],
    ["a folder", "assets/"],
    ["an empty reference", "  "],
    ["a malformed escape", "%E0%A4%A.css"],
  ])("refuses %s", (_name, href) => {
    expect(resolveSiblingFilePath(page, href)).toBeNull();
  });
});

describe("sibling stylesheets", () => {
  const filePath = "design/00000-index.html";
  const link = '<link rel="stylesheet" href="assets/design.css">';
  const stylesheets = new Map([["design/assets/design.css", "body{color:#123456}"]]);

  test("lists only stylesheets inside the page's folder", () => {
    expect(
      findSiblingStylesheetPaths(
        `${link}<link rel="stylesheet" href="../x.css"><link rel="stylesheet" href="https://e.invalid/a.css"><link rel="icon" href="a.ico"><link rel="alternate stylesheet" href="alt.css">${link}`,
        filePath,
      ),
    ).toEqual(["design/assets/design.css"]);
  });

  test("inlines a read stylesheet in place of its link, with its media", () => {
    const { srcDoc, hasRefusedContent } = buildHtmlPreviewDocument(
      '<link rel="stylesheet" media="screen" href="assets/design.css"><p>x</p>',
      { filePath, stylesheets },
    );
    const parsed = parse(srcDoc);
    expect(parsed.querySelector("link") === null).toBe(true);
    const style = parsed.querySelector("style");
    expect(style?.textContent).toBe("body{color:#123456}");
    expect(style?.getAttribute("media")).toBe("screen");
    expect(hasRefusedContent).toBe(false);
    expect(srcDoc).toContain(HTML_PREVIEW_CSP);
  });

  test("keeps a link whose file was not read, and still reports it", () => {
    const { srcDoc, hasRefusedContent } = buildHtmlPreviewDocument(link, {
      filePath,
      stylesheets: new Map(),
    });
    expect(parse(srcDoc).querySelector("link")).not.toBeNull();
    expect(hasRefusedContent).toBe(true);
  });

  test("never inlines a link that resolves outside the folder, even if offered", () => {
    const { srcDoc, hasRefusedContent } = buildHtmlPreviewDocument(
      '<link rel="stylesheet" href="../secret.css">',
      { filePath, stylesheets: new Map([["secret.css", "SECRET"]]) },
    );
    expect(srcDoc).not.toContain("SECRET");
    expect(hasRefusedContent).toBe(true);
  });

  test("a stylesheet cannot close its own style element into markup", () => {
    const css = "p{color:red}</style><h1 id=injected>Injected</h1><style>";
    const { srcDoc } = buildHtmlPreviewDocument(link, {
      filePath,
      stylesheets: new Map([["design/assets/design.css", css]]),
    });
    const parsed = parse(srcDoc);
    expect(parsed.getElementById("injected") === null).toBe(true);
    expect(parsed.querySelectorAll("style")).toHaveLength(1);
    expect(buildHtmlPreviewDocument(srcDoc).srcDoc).toBe(srcDoc);
  });

  test("an inlined stylesheet's own imports and remote URLs are still refused", () => {
    for (const css of ["@import 'b.css';p{}", "p{background:url(https://evil.invalid/a.png)}"]) {
      const { hasRefusedContent } = buildHtmlPreviewDocument(link, {
        filePath,
        stylesheets: new Map([["design/assets/design.css", css]]),
      });
      expect(hasRefusedContent).toBe(true);
    }
  });

  test("an inlined stylesheet adds no script, so the policy is unchanged", () => {
    const { srcDoc } = buildHtmlPreviewDocument(link, { filePath, stylesheets });
    expect(srcDoc).not.toContain("<script");
    expect(HTML_PREVIEW_SANDBOX).toBe("");
  });
});

describe("findSiblingPageLinks", () => {
  const filePath = "design/00000-index.html";

  test("lists links to html files in the folder or below, once each and in order", () => {
    const links = findSiblingPageLinks(
      `<a href="00001-a.html">  First
         page </a><a href="sub/b.htm#x">B</a><a href="00001-a.html">again</a>
       <map><area href="c.html" alt="C"></map>`,
      filePath,
    );
    expect(links).toEqual([
      { path: "design/00001-a.html", label: "First page" },
      { path: "design/sub/b.htm", label: "B" },
      { path: "design/c.html", label: "c.html" },
    ]);
  });

  test("skips everything that is not an html file inside the folder", () => {
    expect(
      findSiblingPageLinks(
        [
          '<a href="../up.html">up</a>',
          '<a href="/abs.html">abs</a>',
          '<a href="https://example.com/x.html">web</a>',
          '<a href="notes.md">md</a>',
          '<a href="assets/design.css">css</a>',
          '<a href="#top">frag</a>',
          '<a href="00000-index.html">self</a>',
          '<a href="javascript:alert(1)">script</a>',
        ].join(""),
        filePath,
      ),
    ).toEqual([]);
  });
});

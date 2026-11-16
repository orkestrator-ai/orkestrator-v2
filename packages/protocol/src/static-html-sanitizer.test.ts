import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createStaticHtmlSanitizer, type StaticHtmlSanitizer } from "./static-html-sanitizer.js";
import { HOSTILE_REPORT_HTML } from "./testing/static-html-fixtures.js";

/**
 * The factory runs serialized, with no module scope, inside a frame or worker
 * page. Every case here evaluates its `toString()` in a fresh window, exactly
 * as both runtimes receive it.
 */
function serialized(): { window: Window; sanitizer: StaticHtmlSanitizer } {
  const window = new Window();
  const sanitizer = window.eval(
    `(${createStaticHtmlSanitizer.toString()})()`,
  ) as StaticHtmlSanitizer;
  return { window, sanitizer };
}

function cleaned(html: string) {
  const { window, sanitizer } = serialized();
  const doc = new window.DOMParser().parseFromString(html, "text/html") as unknown as Document;
  const counts = sanitizer.emptyCounts();
  sanitizer.clean(doc, counts);
  return { doc, counts, sanitizer };
}

describe("createStaticHtmlSanitizer", () => {
  test("is self-contained: it runs from its source alone", () => {
    const { sanitizer } = serialized();
    expect(sanitizer.emptyCounts()).toEqual({
      scripts: 0,
      handlers: 0,
      externalReferences: 0,
      forbiddenElements: 0,
      executableUrls: 0,
    });
  });

  test("removes and counts everything executable in the hostile reference report", () => {
    const { doc, counts } = cleaned(HOSTILE_REPORT_HTML);
    expect(
      doc.querySelectorAll("script,iframe,frame,object,embed,base,meta,link,portal,applet"),
    ).toHaveLength(0);
    expect(doc.body.hasAttribute("onload")).toBe(false);
    expect(doc.querySelector("#beacon")?.hasAttribute("onerror")).toBe(false);
    expect(doc.querySelector("#js-link")?.hasAttribute("href")).toBe(false);
    expect(doc.querySelector("#svg-js")?.hasAttribute("xlink:href")).toBe(false);
    expect(doc.querySelector("#form")?.hasAttribute("action")).toBe(false);
    expect(doc.querySelector("#submit")?.hasAttribute("formaction")).toBe(false);
    const template = doc.querySelector("#tpl") as HTMLTemplateElement;
    expect(template.content.querySelector("script")).toBeNull();
    expect(template.content.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    // Kept: inline SVG, ordinary links and the authored structure.
    expect(doc.querySelector("#drawing rect")).not.toBeNull();
    expect(doc.querySelector("#web-link")?.getAttribute("href")).toBe("https://example.com/page");
    expect(counts.scripts).toBeGreaterThan(0);
  });

  test("counts what it removes and the external resources it keeps", () => {
    const { counts } = cleaned(`<!doctype html><html><head>
<base href="https://x.invalid/"><meta http-equiv="refresh" content="0"><link rel="stylesheet" href="https://x.invalid/a.css">
<script>1</script>
<style>@import url(https://x.invalid/b.css); .a { background: url("//x.invalid/c.png"); }</style>
</head><body onload="1">
<div style="background: url(https://x.invalid/d.png)"></div>
<img src="https://x.invalid/e.png" onerror="1"><a href="https://example.com/">link</a>
<a href="javascript:1">js</a><form action="/p"><button formaction="/q">go</button></form>
<iframe srcdoc="x"></iframe><object data="x"></object><embed src="x">
<template><script>2</script><img src="data:," onclick="2"></template>
</body></html>`);
    expect(counts).toEqual({
      // One in the head, one inside the template.
      scripts: 2,
      // body onload, img onerror, the template image's onclick.
      handlers: 3,
      // @import and its url() in <style>, the protocol-relative url(), the
      // inline url() and the remote image; an external href is a link, not a load.
      externalReferences: 5,
      // base, meta, link, iframe, object, embed; then action and formaction.
      forbiddenElements: 8,
      executableUrls: 1,
    });
  });

  test("keeps a document with nothing to remove unchanged", () => {
    const html = `<!doctype html><html><head><style>p{color:var(--ork-foreground,#111)}</style></head><body><p id="a" style="margin:0">Hello <a href="#a">here</a></p><svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg></body></html>`;
    const before = new Window().document;
    before.write(html);
    const { doc, counts } = cleaned(html);
    expect(doc.documentElement.outerHTML).toBe(before.documentElement.outerHTML);
    expect(Object.values(counts).every((value) => value === 0)).toBe(true);
  });

  test("matches attribute names and executable schemes case-insensitively", () => {
    const { doc, counts } = cleaned(
      `<p id="p" ONCLICK="x()" SrcDoc="x" Nonce="n">p</p><a id="a" HREF="  JavaScript:x()">a</a><img id="i" src="VBSCRIPT:x">`,
    );
    expect(doc.querySelector("#p")?.attributes).toHaveLength(1);
    expect(doc.querySelector("#a")?.hasAttribute("href")).toBe(false);
    expect(doc.querySelector("#i")?.hasAttribute("src")).toBe(false);
    expect(counts).toMatchObject({ handlers: 1, forbiddenElements: 2, executableUrls: 2 });
  });

  test("counts elements inside template content toward the budget", () => {
    const { doc, sanitizer } = cleaned(
      `<div><template><p>1</p><template><b>2</b><i>3</i></template></template></div>`,
    );
    // html, head, body, div, template; then p and the inner template; then b and i.
    expect(sanitizer.elementCount(doc)).toBe(9);
  });
});

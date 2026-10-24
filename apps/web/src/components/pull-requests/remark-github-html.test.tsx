import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { MarkdownBody } from "./pull-request-shared";
import { remarkGitHubHtml, tokenizeHtml } from "./remark-github-html";

function render(source: string): string {
  return renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks, remarkGitHubHtml]}>{source}</Markdown>,
  );
}

const VERCEL_COMMENT = [
  "[vc]: #0M2cGZBGtkNHIJNAQ5bYUzu72J63owaxNbrb",
  "The latest updates on your projects. Learn more about [Vercel for GitHub](https://vercel.link/github-learn-more).",
  "",
  "| Project | Deployment | Actions | Updated |",
  "| :--- | :----- | :------ | :------ |",
  '| <a href="https://vercel.com/definite-tech/orkestrator-v2-web"><sup><img src="https://vercel.com/api/www/avatar?projectId=prj&teamId=team&s=32" width="16" height="16" align="middle" alt="" /></sup></a> [orkestrator-v2-web](https://vercel.com/definite-tech/orkestrator-v2-web) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/definite-tech/orkestrator-v2-web/982) | [Preview](https://orkestrator-v2-web.vercel.app) | <relative-time datetime="2026-10-24T14:34:18.818Z">Oct 24, 2026 2:34pm UTC</relative-time> |',
  "",
  '<a href="https://vercel.com/vercel-agent/request-review?owner=orkestrator-ai&repo=orkestrator-v2&pr=1218" rel="noreferrer"><picture><source media="(prefers-color-scheme: dark)" srcset="https://example.com/dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://example.com/light.svg"><img src="https://example.com/light.svg" alt="Request Review"></picture></a>',
  "",
].join("\n");

describe("remarkGitHubHtml", () => {
  test("renders the Vercel deployment comment without literal tags", () => {
    const html = render(VERCEL_COMMENT);

    expect(html).not.toContain("&lt;");
    // The avatar-only anchor has no label and is dropped; the Markdown link stays.
    expect(html).not.toContain('href="https://vercel.com/definite-tech/orkestrator-v2-web"><');
    expect(html).toContain(
      '<a href="https://vercel.com/definite-tech/orkestrator-v2-web">orkestrator-v2-web</a>',
    );
    expect(html).toContain(
      '<time dateTime="2026-10-24T14:34:18.818Z">Oct 24, 2026 2:34pm UTC</time>',
    );
    // The block-level button becomes a paragraph link labelled by the image alt.
    expect(html).toContain(
      '<p><a href="https://vercel.com/vercel-agent/request-review?owner=orkestrator-ai&amp;repo=orkestrator-v2&amp;pr=1218">Request Review</a></p>',
    );
  });

  test("pairs inline tags across Markdown siblings", () => {
    expect(render('See <a href="https://example.com">the **docs**</a> now.')).toBe(
      '<p>See <a href="https://example.com">the <strong>docs</strong></a> now.</p>',
    );
    expect(render("<b>bold</b>, <em>em</em>, <s>gone</s> and <code>a &lt; b</code>")).toBe(
      "<p><strong>bold</strong>, <em>em</em>, <del>gone</del> and <code>a &lt; b</code></p>",
    );
    expect(render("one<br>two")).toBe("<p>one<br/>\ntwo</p>");
  });

  test("strips unknown tags, comments and hidden content but keeps their text", () => {
    expect(render("<!-- hidden -->\n\nHello <sup>world</sup>")).toBe("<p>Hello world</p>");
    expect(render('<div align="center">\n<script>alert(1)</script>\n<p>Centered</p>\n</div>')).toBe(
      "<p>Centered</p>",
    );
  });

  test.each(["script", "style", "template"])(
    "suppresses inline %s bodies across Markdown nodes",
    (tag) => {
      const body = `before <${tag}>secret **bold** *em* [link](https://hidden.example) ![image](https://hidden.example/i.png) <a href="https://hidden.example">anchor<img alt="badge"></a><b>nested</b></${tag}> after`;
      expect(render(body)).toBe("<p>before  after</p>");
      const html = renderToStaticMarkup(<MarkdownBody body={body} />);
      for (const hidden of [
        "secret",
        "bold",
        "em</",
        "hidden.example",
        "image",
        "anchor",
        "badge",
        "nested",
      ]) {
        expect(html).not.toContain(hidden);
      }
    },
  );

  test("keeps hidden state across blocks and ignores mismatched closing tags", () => {
    expect(
      render(
        "before <template>secret\n\n**hidden** <style>more</script>secret</style><template>nested</template>still hidden</template> after",
      ),
    ).toBe("<p>before </p>\n<p> after</p>");
    expect(render('before <script>secret </style><a href="/hidden">hidden</a>')).toBe(
      "<p>before </p>",
    );
    expect(render("before *<template>secret* hidden **bold**</template> after")).toBe(
      "<p>before  after</p>",
    );
  });

  test.each([
    "**bold**",
    "*em* and ~~gone~~",
    "[name](path)",
    "`tick` and ``ticks``",
    "src/**/*.{ts,tsx}",
    "a  &lt;  b &amp; c",
    "<b>literal</b><!-- literal -->",
  ])("preserves source punctuation in code: %s", (snippet) => {
    const expected = snippet.replaceAll("&lt;", "<").replaceAll("&amp;", "&");
    for (const source of [
      `before <code>${snippet}</code> after`,
      `<div><code>${snippet}</code></div>`,
    ]) {
      const html = render(source);
      const container = document.createElement("div");
      container.innerHTML = html;
      expect(container.querySelector("code")?.textContent).toBe(expected);
      expect(container.querySelector("code a, code strong, code em, code b") === null).toBe(true);
    }
  });

  test.each([
    "[inner](https://inner.example)",
    "[inner][ref]",
    "https://inner.example",
    "**[inner](https://inner.example)**",
  ])("keeps the outer destination when HTML anchors wrap %s", (label) => {
    const html = render(
      `<a href="https://outer.example">${label}</a>\n\n[ref]: https://inner.example`,
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://outer.example"');
    expect(html).toContain("inner");
    expect(html).not.toContain('href="https://inner.example"');
  });

  test("preserves standalone uploaded images as alt text or safe source links", () => {
    expect(
      render(
        '<img width="1200" alt="Screenshot &amp; details" src="https://github.com/user-attachments/assets/screenshot.png" />',
      ),
    ).toBe("<p>Screenshot &amp; details</p>");
    expect(render('See <img src="/screenshot.png"> here')).toBe(
      '<p>See <a href="/screenshot.png">/screenshot.png</a> here</p>',
    );
    expect(render('<img src="javascript:alert(1)">')).toBe("");
  });

  test("flattens block HTML onto lines", () => {
    expect(render("<details>\n<summary>Walkthrough</summary>\n<p>Body text</p>\n</details>")).toBe(
      "<p>Walkthrough<br/>\nBody text</p>",
    );
  });

  test("labels Markdown links around HTML image badges", () => {
    expect(
      render('[<img src="https://example.com/badge.svg" alt="CI">](https://example.com)'),
    ).toBe('<p><a href="https://example.com">CI</a></p>');
  });

  test("never nests links and unwraps unclosed or unsafe anchors", () => {
    expect(render('[outer <a href="https://inner.example">inner</a>](https://outer.example)')).toBe(
      '<p><a href="https://outer.example">outer inner</a></p>',
    );
    expect(render('<a href="https://example.com">dangling')).toBe("<p>dangling</p>");
    expect(render('<a href="javascript:alert(1)">click</a>')).toBe("<p>click</p>");
  });
});

describe("tokenizeHtml", () => {
  test.each(["constructor", "toString", "valueOf", "__proto__"])(
    "does not decode inherited entity %s",
    (name) => {
      const entity = `&${name};`;
      expect(tokenizeHtml(`<img alt="${entity}">`)).toEqual([
        { kind: "open", name: "img", attributes: { alt: entity }, selfClosing: false },
      ]);
      expect(render(`<div>${entity}</div>`)).toBe(`<p>&amp;${name};</p>`);
    },
  );

  test("parses quoted, unquoted and entity-encoded attributes", () => {
    expect(tokenizeHtml(`<a href="/x?a=1&amp;b=2" data-x='y' rel=noopener />`)).toEqual([
      {
        kind: "open",
        name: "a",
        attributes: { href: "/x?a=1&b=2", "data-x": "y", rel: "noopener" },
        selfClosing: true,
      },
    ]);
  });
});

describe("MarkdownBody", () => {
  test.each([
    "javascript:alert(1)",
    "java&#9;script:alert(1)",
    "java&#10;script:alert(1)",
    "java&#13;script:alert(1)",
    "&#106;avascript&#58;alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,unsafe",
    "vbscript:alert(1)",
    "java&#x7f;script:alert(1)",
  ])("rejects unsafe HTML-derived URLs through the production pipeline: %s", (href) => {
    const html = renderToStaticMarkup(<MarkdownBody body={`See <a href="${href}">label</a>`} />);
    expect(html).toContain("label");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("<a ");
  });

  test.each([
    ["https://example.com/x?a=1&amp;b=2", "https://example.com/x?a=1&b=2"],
    ["http://example.com", "http://example.com"],
    ["mailto:dev@example.com", "mailto:dev@example.com"],
    ["/docs/page", "/docs/page"],
    ["../docs/page", "../docs/page"],
    ["#section", "#section"],
  ])("preserves safe HTML-derived URLs: %s", (href, expected) => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <MarkdownBody body={`See <a href="${href}">label</a>`} />,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe(expected);
  });

  test("renders <relative-time> as a relative age with the absolute time as a tooltip", () => {
    const recent = new Date(Date.now() - 12 * 60 * 1000).toISOString();
    const html = renderToStaticMarkup(
      <MarkdownBody
        body={`Updated <relative-time datetime="${recent}">fallback</relative-time>`}
      />,
    );
    expect(html).toContain(`<time dateTime="${recent}" title="`);
    expect(html).toContain(">12m ago</time>");

    const invalid = renderToStaticMarkup(
      <MarkdownBody body={'<relative-time datetime="soon">Oct 24</relative-time>'} />,
    );
    expect(invalid).toContain(">Oct 24</time>");
  });
});

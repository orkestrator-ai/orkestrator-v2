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
    expect(render('<a href="javascript:alert(1)">click</a>')).toBe('<p><a href="">click</a></p>');
  });
});

describe("tokenizeHtml", () => {
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

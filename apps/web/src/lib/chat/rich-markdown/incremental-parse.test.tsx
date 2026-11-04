import { describe, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import type { PluggableList } from "unified";
import { IncrementalMarkdownCache, lastSafeBoundary, remarkParseRange } from "./incremental-parse";
import { blockMarkdownPlugins, markdownUrlTransform } from "./markdown-plugins";

function blocksOf(fragment: ReactElement): ReactNode[] {
  const { children } = fragment.props as { children?: ReactNode };
  if (children === undefined) return [];
  return Array.isArray(children) ? (children as ReactNode[]) : [children];
}

function renderIncremental(
  cache: IncrementalMarkdownCache,
  source: string,
  plugins: PluggableList,
): ReactNode[] {
  return cache.render(source, (range) =>
    blocksOf(
      Markdown({
        children: source,
        remarkPlugins: [[remarkParseRange, range], ...plugins],
        urlTransform: markdownUrlTransform,
      }),
    ),
  );
}

function renderFull(source: string, plugins: PluggableList): ReactNode[] {
  return blocksOf(
    Markdown({ children: source, remarkPlugins: plugins, urlTransform: markdownUrlTransform }),
  );
}

const html = (nodes: ReactNode[]) => renderToStaticMarkup(<>{nodes}</>);
const keys = (nodes: ReactNode[]) => nodes.map((node) => (isValidElement(node) ? node.key : node));

const FIXTURES: Record<string, string> = {
  prose: [
    "The reducer **mutates** state in `applyPatch`.",
    "",
    "A second paragraph with a [link](https://example.com/a) and *emphasis*.",
    "",
    "Third paragraph",
    "continues on a second line.",
    "",
    "Done.",
    "",
  ].join("\n"),
  headings:
    "# Title\n\nIntro text.\n\nSetext heading\n===\n\nBody.\n\n## Next\n\n---\n\nAfter the break.\n",
  lists: [
    "- first",
    "- second",
    "",
    "- loose third",
    "",
    "  continued inside the third item",
    "",
    "1. one",
    "2. two",
    "",
    "3. three",
    "",
    "Paragraph after the lists.",
    "",
    "* star list",
    "  * nested",
    "",
    "End.",
    "",
  ].join("\n"),
  fences: [
    "Before the code.",
    "",
    "```ts",
    "const a = 1;",
    "",
    "const b = 2;",
    "```",
    "",
    "Between fences.",
    "",
    "~~~~",
    "tilde fence with ``` inside",
    "",
    "~~~~",
    "",
    "- item",
    "",
    "  ```",
    "  fenced inside the item",
    "  ```",
    "",
    "After.",
    "",
    "```",
    "an unclosed fence that keeps streaming",
    "",
    "more",
  ].join("\n"),
  quotes: "> quoted\n> lines\n\n> another quote\n\nplain\n\n>lazy\ncontinuation\n\nEnd.\n",
  tables: "| a | b |\n| - | - |\n| 1 | 2 |\n\nx | y\n--|--\n3 | 4\n\nAfter the table.\n",
  indented:
    "Paragraph.\n\n    indented code\n\n    more code\n\nBack to prose.\n\n\tTabbed code\n\nEnd.\n",
  breaks: "Line one\nLine two\n\nLine three  \nLine four\n\n**bold\nacross lines**\n\nEnd.\n",
  definitions:
    "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com/docs\n\nAfter.\n",
  quotedDefinitionsAfter:
    "Intro.\n\nAnother paragraph.\n\n> [x]: https://example.com\n\nSee [x].\n\nEnd.\n",
  quotedDefinitionsBefore: "See [x].\n\nMore.\n\n> > [x]: https://example.com\n\nEnd.\n",
  listDefinitionsAfter: "Intro.\n\nMore.\n\n- [x]: https://example.com\n\nSee [x].\n\nEnd.\n",
  listDefinitionsBefore: "See [x].\n\nMore.\n\n1. item\n\n   [x]: https://example.com\n\nEnd.\n",
  footnotes: "A claim.[^1]\n\nMore.\n\n[^1]: The source.\n\nAfter.\n",
  html: "Intro.\n\n<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>\n\nAfter.\n",
  crlf: "One.\r\n\r\nTwo.\r\n\r\nThree.\r\n",
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  describe(`incremental render equals a full render: ${name}`, () => {
    for (const rich of [false, true]) {
      test(`every streamed prefix (rich: ${rich})`, () => {
        const plugins = blockMarkdownPlugins({ rich, enableBreaks: true, clipped: false });
        const cache = new IncrementalMarkdownCache();
        for (let length = 0; length <= fixture.length; length += 1) {
          const prefix = fixture.slice(0, length);
          const full = renderFull(prefix, plugins);
          const reused = renderIncremental(cache, prefix, plugins);
          if (html(reused) !== html(full)) throw new Error(`html differs at length ${length}`);
          // The same keys are what let the final render update these in place.
          expect(keys(reused)).toEqual(keys(full));
        }
        // Not vacuous: where nothing disables reuse, the prefix was reused.
        // (A definition disables it only once it has streamed in.)
        const disabled = ["footnotes", "html", "crlf"].includes(name);
        if (disabled) expect(cache.reused).toBe(0);
        else expect(cache.reused).toBeGreaterThan(0);
      });
    }
  });
}

describe("incremental render reuse", () => {
  const plugins = blockMarkdownPlugins({ rich: true, enableBreaks: true, clipped: false });

  test("a long streamed answer renders each completed segment once", () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, index) => `Paragraph ${index} explains one more step of the change in some detail.`,
    );
    const document = paragraphs.join("\n\n") + "\n";
    const cache = new IncrementalMarkdownCache();
    let streamed = 0;
    for (let length = 1; length <= document.length; length += 40) {
      renderIncremental(cache, document.slice(0, length), plugins);
      streamed += length;
    }
    // A full render of every update would read `streamed` characters.
    expect(cache.reused).toBeGreaterThan(0);
    expect(cache.renderedCharacters).toBeLessThan(streamed / 20);
  });

  test("a finished block keeps the same element while text arrives after it", () => {
    const cache = new IncrementalMarkdownCache();
    const first = renderIncremental(cache, "First.\n\nSecond.\n\nThird.\n\nFo", plugins);
    const second = renderIncremental(cache, "First.\n\nSecond.\n\nThird.\n\nFour", plugins);
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    // The block still arriving is rendered again.
    expect(second.at(-1)).not.toBe(first.at(-1));
  });

  test("a code block's id holds its offset in the whole document", () => {
    const text = "Intro.\n\nMore.\n\n```ts\nconst a = 1;\n```\n\nAfter.\n\nTail";
    const cache = new IncrementalMarkdownCache();
    const markup = html(renderIncremental(cache, text, plugins));
    expect(markup).toContain(`code:${text.indexOf("```")}`);
    expect(markup).toBe(html(renderFull(text, plugins)));
  });

  test("text that no longer extends the cached prefix resets it", () => {
    const cache = new IncrementalMarkdownCache();
    renderIncremental(cache, "First.\n\nSecond.\n\nThird", plugins);
    const replaced = "Other.\n\nSecond.\n\nThird";
    expect(html(renderIncremental(cache, replaced, plugins))).toBe(
      html(renderFull(replaced, plugins)),
    );
  });

  test("a construct with document-wide meaning arriving later re-renders what came before", () => {
    const cache = new IncrementalMarkdownCache();
    const opening = "See [the docs][docs].\n\nMore text.\n\nEven more";
    renderIncremental(cache, opening, plugins);
    const complete = `${opening}.\n\n[docs]: https://example.com/docs\n`;
    const markup = html(renderIncremental(cache, complete, plugins));
    expect(markup).toContain('href="https://example.com/docs"');
    expect(markup).toBe(html(renderFull(complete, plugins)));
  });

  test("boundaries are never inside a fence, an indented block, a list or a quote", () => {
    expect(lastSafeBoundary("a\n\n```\nx\n\ny\n")).toBe(0 + "a\n\n".length);
    expect(lastSafeBoundary("- a\n\n- b\n")).toBe(0);
    expect(lastSafeBoundary("- a\n\n  b\n")).toBe(0);
    expect(lastSafeBoundary("> a\n\n> b\n")).toBe(0);
    expect(lastSafeBoundary("a\n\n    code\n")).toBe(0);
    expect(lastSafeBoundary("a\n\nb\n\nc")).toBe("a\n\n".length);
    for (const definition of ["[x]:", "> [x]:", "> > [x]:", "- [x]:", "1. [x]:", "   [x]:"]) {
      expect(lastSafeBoundary(`Intro.\n\nMore.\n\n${definition} https://e.com\n\nSee [x].\n`)).toBe(
        0,
      );
    }
  });
});

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import type { PluggableList, Processor } from "unified";
import {
  IncrementalMarkdownCache,
  lastSafeBoundary,
  remarkIncrementalParse,
} from "./incremental-parse";
import { blockMarkdownPlugins, markdownUrlTransform } from "./markdown-plugins";

/** Records the tree the parser produced, before any transform runs. */
function captureParse(this: Processor, sink: { tree: unknown }) {
  return (tree: unknown) => {
    sink.tree = structuredClone(tree);
  };
}

function render(source: string, plugins: PluggableList) {
  const sink: { tree: unknown } = { tree: null };
  const html = renderToStaticMarkup(
    <Markdown
      remarkPlugins={[[captureParse, sink], ...plugins]}
      urlTransform={markdownUrlTransform}
    >
      {source}
    </Markdown>,
  );
  return { html, tree: sink.tree };
}

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
  footnotes: "A claim.[^1]\n\nMore.\n\n[^1]: The source.\n\nAfter.\n",
  html: "Intro.\n\n<details>\n<summary>More</summary>\n\nHidden **text**.\n\n</details>\n\nAfter.\n",
  crlf: "One.\r\n\r\nTwo.\r\n\r\nThree.\r\n",
};

for (const [name, fixture] of Object.entries(FIXTURES)) {
  describe(`incremental parse equals a full parse: ${name}`, () => {
    for (const rich of [false, true]) {
      test(`every streamed prefix (rich: ${rich})`, () => {
        const plugins = blockMarkdownPlugins({ rich, enableBreaks: true, clipped: false });
        const cache = new IncrementalMarkdownCache();
        const incremental: PluggableList = [[remarkIncrementalParse, cache], ...plugins];
        for (let length = 0; length <= fixture.length; length += 1) {
          const prefix = fixture.slice(0, length);
          const full = render(prefix, plugins);
          const reused = render(prefix, incremental);
          if (JSON.stringify(reused.tree) !== JSON.stringify(full.tree)) {
            throw new Error(`tree differs at length ${length}`);
          }
          if (reused.html !== full.html) throw new Error(`html differs at length ${length}`);
          if (length > 0 && full.tree === null) throw new Error("the oracle captured no tree");
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

describe("incremental parse reuse", () => {
  test("a long streamed answer parses each completed segment once", () => {
    const paragraphs = Array.from(
      { length: 200 },
      (_, index) => `Paragraph ${index} explains one more step of the change in some detail.`,
    );
    const document = paragraphs.join("\n\n") + "\n";
    const plugins = blockMarkdownPlugins({ rich: true, enableBreaks: true, clipped: false });
    const cache = new IncrementalMarkdownCache();
    let streamed = 0;
    for (let length = 1; length <= document.length; length += 40) {
      render(document.slice(0, length), [[remarkIncrementalParse, cache], ...plugins]);
      streamed += length;
    }
    // A full parse of every update would read `streamed` characters.
    expect(cache.reused).toBeGreaterThan(0);
    expect(cache.parsedCharacters).toBeLessThan(streamed / 20);
  });

  test("text that no longer extends the cached prefix resets it", () => {
    const plugins = blockMarkdownPlugins({ rich: false, enableBreaks: true, clipped: false });
    const cache = new IncrementalMarkdownCache();
    const incremental: PluggableList = [[remarkIncrementalParse, cache], ...plugins];
    render("First.\n\nSecond.\n\nThird", incremental);
    const replaced = "Other.\n\nSecond.\n\nThird";
    expect(render(replaced, incremental).html).toBe(render(replaced, plugins).html);
  });

  test("boundaries are never inside a fence, an indented block, a list or a quote", () => {
    expect(lastSafeBoundary("a\n\n```\nx\n\ny\n")).toBe(0 + "a\n\n".length);
    expect(lastSafeBoundary("- a\n\n- b\n")).toBe(0);
    expect(lastSafeBoundary("- a\n\n  b\n")).toBe(0);
    expect(lastSafeBoundary("> a\n\n> b\n")).toBe(0);
    expect(lastSafeBoundary("a\n\n    code\n")).toBe(0);
    expect(lastSafeBoundary("a\n\nb\n\nc")).toBe("a\n\n".length);
    expect(lastSafeBoundary("[x]: https://e.com\n\nb\n\nc\n")).toBe(0);
  });
});

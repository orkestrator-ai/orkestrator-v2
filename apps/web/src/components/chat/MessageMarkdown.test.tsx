import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { InlineMessageMarkdown, MessageMarkdown } from "./MessageMarkdown";

function renderInline(content: string) {
  return render(<InlineMessageMarkdown content={content} />).container;
}

describe("InlineMessageMarkdown", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders inline emphasis, strikethrough and code spans", () => {
    const container = renderInline("**bold** and *em* and ~~gone~~ and `code`");

    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("em")?.textContent).toBe("em");
    expect(container.querySelector("del")?.textContent).toBe("gone");
    expect(container.querySelector("code")?.textContent).toBe("code");
    expect(container.textContent).toBe("bold and em and gone and code");
  });

  // The rendered output is placed inside a <button>, so anything that is not
  // phrasing content produces invalid — and, for a nested control, unusable —
  // markup. This is the component's load-bearing invariant.
  test("emits no block-level element, not even the paragraph it parses", () => {
    const container = renderInline("a paragraph of reasoning");

    expect(container.querySelector("p") === null).toBe(true);
    expect(container.querySelector("div") === null).toBe(true);
    expect(container.textContent).toBe("a paragraph of reasoning");
  });

  test("keeps a link's text but emits no anchor", () => {
    const container = renderInline("see [the docs](https://example.com/x) for more");

    expect(container.querySelector("a") === null).toBe(true);
    expect(container.textContent).toBe("see the docs for more");
  });

  test.each([
    ["its destination", "[](https://example.com/x)", "https://example.com/x"],
    ["a literal marker when it has no destination", "[]()", "[]"],
  ])("keeps an empty-label link visible using %s", (_label, content, expected) => {
    const container = renderInline(content);

    expect(container.querySelector("a") === null).toBe(true);
    expect(container.textContent).toBe(expected);
  });

  test("emits no anchor for a GFM autolink literal", () => {
    const container = renderInline("fetched http://example.com/auto just now");

    expect(container.querySelector("a") === null).toBe(true);
    expect(container.textContent).toContain("http://example.com/auto");
  });

  // A single flattened line cannot carry block meaning, so a block construct
  // could only ever eat its own marker and silently shorten the text.
  test.each([
    ["a bullet marker", "- read the reducer"],
    ["an ordered marker", "1. read the reducer"],
    ["a heading marker", "# Plan"],
    ["a block quote marker", "> quoted reasoning"],
    ["a code fence", "```ts const x = 1"],
    ["a task list marker", "- [ ] unchecked item"],
    ["table pipes", "| a | b |"],
    ["a reference definition", "[ref]: https://example.com/x"],
  ])("keeps %s as literal text", (_label, content) => {
    const container = renderInline(content);

    expect(container.querySelector("ul") === null).toBe(true);
    expect(container.querySelector("ol") === null).toBe(true);
    expect(container.querySelector("blockquote") === null).toBe(true);
    expect(container.textContent).toBe(content);
  });

  // Reasoning that reduces to nothing would render a preview-less row while
  // still claiming there is content behind it.
  test.each([
    ["a lone thematic break", "---", "---"],
    ["an image", "![diagram](https://example.com/i.png)", "!diagram"],
  ])("renders visible text for %s", (_label, content, expected) => {
    expect(renderInline(content).textContent).toBe(expected);
  });

  // Reasoning in a coding tool routinely names JSX and HTML elements.
  test("escapes HTML-like text instead of dropping or executing it", () => {
    const container = renderInline("I will update the <Button> component now");

    expect(container.textContent).toBe("I will update the <Button> component now");
    expect(container.querySelector("button") === null).toBe(true);
  });

  test("does not execute raw HTML", () => {
    const container = renderInline("<script>alert(1)</script>");

    expect(container.querySelector("script") === null).toBe(true);
    expect(container.textContent).toBe("<script>alert(1)</script>");
  });

  test("leaves underscores inside identifiers alone", () => {
    expect(renderInline("a_b_c snake_case_name").textContent).toBe("a_b_c snake_case_name");
  });

  test("merges the caller's class names onto the wrapper", () => {
    const { container } = render(<InlineMessageMarkdown content="plain" className="truncate" />);
    const wrapper = container.querySelector("span");

    expect(wrapper?.className).toContain("truncate");
    expect(wrapper?.className).toContain("[&_strong]:font-semibold");
  });
});

describe("MessageMarkdown code styling", () => {
  afterEach(() => {
    cleanup();
  });

  // Inline code is tinted so paths, filenames and flags do not disappear into
  // the prose around them. The `prose-code:` variant matches *every* `code`,
  // including the one inside a fenced block, so the class list carries a
  // `pre code` reset; without it a code block is painted chip-by-chip on top of
  // its own surface. The reset only wins because `[&_pre_code]` outranks the
  // zero-specificity `:where()` selector the typography plugin generates, which
  // is why both halves are pinned rather than the string as a whole.
  test("tints inline code and resets the code inside a fenced block", () => {
    const { container } = render(
      <MessageMarkdown content={"Run `bun test` first.\n\n```ts\nconst x = 1;\n```"} />,
    );
    const wrapper = container.firstElementChild as HTMLElement;

    expect(wrapper.className).toContain("prose-code:bg-primary/12");
    expect(wrapper.className).toContain("prose-code:text-blue-300");
    // Typography's generated content would otherwise re-add the backticks the
    // chip replaces.
    expect(wrapper.className).toContain("prose-code:before:content-none");
    expect(wrapper.className).toContain("prose-code:after:content-none");

    expect(wrapper.className).toContain("[&_pre_code]:bg-transparent");
    expect(wrapper.className).toContain("[&_pre_code]:px-0");
    expect(wrapper.className).toContain("[&_pre_code]:py-0");
    expect(wrapper.className).toContain("[&_pre_code]:text-foreground");

    // The reset is only load-bearing because a fenced block really does render
    // `pre > code`, which is what `prose-code:` also matches.
    const fenced = container.querySelector("pre code");
    expect(fenced?.textContent).toContain("const x = 1;");

    const inline = Array.from(container.querySelectorAll("code")).find(
      (node) => node.closest("pre") === null,
    );
    expect(inline?.textContent).toBe("bun test");
  });
});

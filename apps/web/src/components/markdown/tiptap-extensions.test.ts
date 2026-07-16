import { afterEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/react";
import { marked } from "marked";
import {
  assessMarkdownForRichEditing,
  createMarkdownExtensions,
} from "./tiptap-extensions";

let editor: Editor | null = null;

function roundTrip(markdown: string): string {
  editor = new Editor({
    extensions: createMarkdownExtensions(),
    content: markdown,
    contentType: "markdown",
  });
  return editor.getMarkdown();
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Markdown Tiptap extensions", () => {
  test("round-trips headings, emphasis, and fenced code", () => {
    const result = roundTrip(
      "# Heading\n\nText with **bold** and *italic*.\n\n```ts\nconst value = 1\n```",
    );

    expect(result).toContain("# Heading");
    expect(result).toContain("**bold**");
    expect(result).toContain("*italic*");
    expect(result).toContain("```ts\nconst value = 1\n```");
  });

  test("round-trips GFM tables", () => {
    const result = roundTrip(
      "| Name | Value |\n| --- | --- |\n| one | two |",
    );

    expect(result).toContain("| Name");
    expect(result).toContain("| ---");
    expect(result).toContain("| one");
  });

  test("preserves GFM tables after a rich-document cell edit", () => {
    editor = new Editor({
      extensions: createMarkdownExtensions(),
      content: "| Name | Value |\n| --- | --- |\n| one | two |",
      contentType: "markdown",
    });

    let cellTextPosition: number | null = null;
    editor.state.doc.descendants((node, position) => {
      if (node.isText && node.text === "two") {
        cellTextPosition = position;
        return false;
      }
      return true;
    });

    expect(cellTextPosition).not.toBeNull();
    editor
      .chain()
      .setTextSelection({
        from: cellTextPosition!,
        to: cellTextPosition! + "two".length,
      })
      .insertContent("updated")
      .run();

    const result = editor.getMarkdown();
    expect(result).toContain("| Name");
    expect(result).toContain("updated");
    expect(editor.getHTML()).toContain("<table");
  });

  test("round-trips checked and unchecked task items", () => {
    const result = roundTrip("- [ ] pending\n- [x] complete");

    expect(result).toContain("- [ ] pending");
    expect(result).toContain("- [x] complete");
  });

  test("preserves Markdown image source, alt text, and title without fetching it", () => {
    editor = new Editor({
      extensions: createMarkdownExtensions(),
      content:
        'Before ![diagram](https://example.invalid/diagram.png "Architecture") after',
      contentType: "markdown",
    });

    expect(editor.getMarkdown()).toContain(
      '![diagram](https://example.invalid/diagram.png "Architecture")',
    );
    expect(editor.getHTML()).toContain("data-markdown-image");
    expect(editor.getHTML()).not.toContain("<img");
    expect(editor.getHTML()).not.toContain("src=");
  });

  test("allows supported tables, images, and links in Rendered mode", () => {
    const markdown = [
      "[Docs](https://example.com)",
      "",
      "![diagram](assets/diagram.png)",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| one | two |",
    ].join("\n");

    expect(assessMarkdownForRichEditing(markdown)).toEqual({
      safe: true,
      reason: null,
    });
  });

  test("rejects footnotes, raw HTML, and frontmatter that would be lossy", () => {
    expect(
      assessMarkdownForRichEditing("Paragraph\n\n[^1]: footnote"),
    ).toMatchObject({ safe: false });
    expect(
      assessMarkdownForRichEditing(
        "<details><summary>More</summary>Body</details>",
      ),
    ).toMatchObject({ safe: false });
    expect(
      assessMarkdownForRichEditing(
        "---\ntitle: Hello\ntags:\n  - one\n---\n\n# Page",
      ),
    ).toMatchObject({ safe: false });
  });

  test("rejects Markdown when tokenization fails", () => {
    const originalLexer = marked.lexer;
    marked.lexer = (() => {
      throw new Error("tokenizer unavailable");
    }) as typeof marked.lexer;

    try {
      expect(assessMarkdownForRichEditing("# Heading")).toEqual({
        safe: false,
        reason:
          "This file could not be parsed safely in Rendered mode. Continue editing in Raw mode.",
      });
    } finally {
      marked.lexer = originalLexer;
    }
  });
});

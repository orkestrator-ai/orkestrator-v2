import { afterEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/react";
import { createMarkdownExtensions } from "./tiptap-extensions";

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

  test("round-trips checked and unchecked task items", () => {
    const result = roundTrip("- [ ] pending\n- [x] complete");

    expect(result).toContain("- [ ] pending");
    expect(result).toContain("- [x] complete");
  });
});

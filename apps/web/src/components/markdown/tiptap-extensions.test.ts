import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor } from "@tiptap/react";
import { MarkdownManager } from "@tiptap/markdown";
import { marked } from "marked";
import {
  assessMarkdownForRichEditing,
  createMarkdownExtensions,
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from "./tiptap-extensions";

let editor: Editor | null = null;
const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../../..");

function roundTrip(markdown: string): string {
  let contentError: Error | null = null;
  editor = new Editor({
    extensions: createMarkdownExtensions(),
    content: markdown,
    contentType: "markdown",
    enableContentCheck: true,
    onContentError: ({ error }) => {
      contentError = error;
    },
  });

  if (contentError) throw contentError;
  return editor.getMarkdown();
}

function getCurrentEditor(): Editor {
  if (!editor) throw new Error("Expected the test editor to be initialized");
  return editor;
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

  test("round-trips inline code nested in other marks", () => {
    const markdown = [
      "**`bold code`**",
      "*`italic code`*",
      "~~`struck code`~~",
      "[`linked code`](https://example.com)",
      "**before `mixed code` after**",
    ].join("\n\n");

    expect(roundTrip(markdown)).toBe(markdown);
    expect(editor?.getHTML()).toContain("<strong><code>bold code</code></strong>");
    expect(editor?.getHTML()).toContain("<a");
    expect(editor?.getHTML()).toContain("<code>linked code</code>");
  });

  test("accepts the repository Markdown files that previously failed", () => {
    const expectedMarkdown = new Map([
      [
        "AGENTS.md",
        "**Always use v2 of the `@opencode-ai/sdk` package.**",
      ],
      [
        "README.md",
        "[`orkestrator.dev`](https://www.orkestrator.dev)",
      ],
    ]);

    for (const [fileName, expected] of expectedMarkdown) {
      const markdown = readFileSync(resolve(REPOSITORY_ROOT, fileName), "utf8");

      expect(assessMarkdownForRichEditing(markdown)).toEqual({
        safe: true,
        reason: null,
      });
      expect(roundTrip(markdown)).toContain(expected);
      editor?.destroy();
      editor = null;
    }
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

  test("round-trips nested task items", () => {
    const markdown = "- [ ] parent\n  - [x] child";

    expect(roundTrip(markdown)).toBe(markdown);
    expect(editor?.getHTML()).toContain('data-checked="false"');
    expect(editor?.getHTML()).toContain('data-checked="true"');
  });

  test("turns explicit non-breaking-space markers into empty paragraphs", () => {
    for (const marker of ["&nbsp;", "\u00A0"]) {
      expect(roundTrip(marker)).toBe("");
      expect(editor?.getHTML()).toBe("<p></p>");
      editor?.destroy();
      editor = null;
    }
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

  test("keeps a standalone Markdown image in a schema-valid paragraph", () => {
    const markdown = "![diagram](assets/diagram.png)";

    expect(roundTrip(markdown)).toBe(markdown);
    expect(editor?.getHTML()).toContain("<p>");
    expect(editor?.getHTML()).toContain("data-markdown-image");
  });

  test("uses source and generic fallback labels for images", () => {
    expect(roundTrip("![](assets/diagram.png)")).toBe(
      "![](assets/diagram.png)",
    );
    expect(getCurrentEditor().getHTML()).toContain("Image: assets/diagram.png");
    editor?.destroy();
    editor = null;

    expect(roundTrip("![]()")).toBe("![]()");
    expect(getCurrentEditor().getHTML()).toContain("Image: Image");
    expect(getCurrentEditor().getHTML()).not.toContain("<img");
    expect(getCurrentEditor().getHTML()).not.toContain("src=");
  });

  test("does not create image nodes from base64 HTML sources", () => {
    editor = new Editor({
      extensions: createMarkdownExtensions(),
      content:
        '<img src="data:image/png;base64,AAAA"><img src="https://example.invalid/diagram.png">',
    });

    expect(editor.getHTML()).not.toContain("data:image/png");
    expect(editor.getHTML()).toContain("https://example.invalid/diagram.png");
    expect(editor.getJSON().content).toHaveLength(1);
  });

  test("preserves Markdown base64 sources as non-fetching placeholders", () => {
    editor?.destroy();
    editor = null;

    const base64Image = "![](data:image/png;base64,AAAA)";
    expect(roundTrip(base64Image)).toBe(base64Image);
    expect(getCurrentEditor().getHTML()).toContain("data-markdown-image");
    expect(getCurrentEditor().getHTML()).not.toContain("<img");
    expect(getCurrentEditor().getHTML()).not.toContain("src=");
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

  test("allows inline code nested in supported marks", () => {
    const markdown = [
      "**`bold code`**",
      "*`italic code`*",
      "~~`struck code`~~",
      "[`linked code`](https://example.com)",
    ].join("\n\n");

    expect(assessMarkdownForRichEditing(markdown)).toEqual({
      safe: true,
      reason: null,
    });
  });

  test("rejects footnotes and raw HTML that would be lossy", () => {
    expect(
      assessMarkdownForRichEditing("Paragraph\n\n[^1]: footnote"),
    ).toMatchObject({ safe: false });
    expect(
      assessMarkdownForRichEditing(
        "<details><summary>More</summary>Body</details>",
      ),
    ).toMatchObject({ safe: false });
  });

  test("accepts supported Markdown with YAML or TOML frontmatter", () => {
    for (const markdown of [
      "---\ntitle: Hello\ntags:\n  - one\n---\n\n# Page",
      "+++\ntitle = \"Hello\"\n+++\n\n# Page",
      "---\r\ntitle: Hello\r\n...\r\n\r\n# Page",
    ]) {
      expect(assessMarkdownForRichEditing(markdown)).toEqual({
        safe: true,
        reason: null,
      });
    }
  });

  test("still rejects unsupported body syntax after valid frontmatter", () => {
    for (const markdown of [
      "---\ntitle: Footnotes\n---\n\nParagraph\n\n[^1]: footnote",
      "+++\ntitle = \"HTML\"\n+++\n\n<details>raw</details>",
    ]) {
      expect(assessMarkdownForRichEditing(markdown)).toMatchObject({
        safe: false,
      });
    }
  });

  test("splits frontmatter without normalizing delimiters or body indentation", () => {
    const markdown =
      "\uFEFF---\r\nname: angela-search-scrape\r\ndescription: Angela's API\r\n---\r\n\r\n  indented body";

    expect(splitMarkdownFrontmatter(markdown)).toEqual({
      frontmatter:
        "\uFEFF---\r\nname: angela-search-scrape\r\ndescription: Angela's API\r\n---\r\n\r\n",
      body: "  indented body",
    });
  });

  test("splits every supported delimiter and line-ending variant exactly", () => {
    const cases = [
      {
        markdown: "+++\ntitle = \"Hello\"\n+++\n# Page",
        frontmatter: "+++\ntitle = \"Hello\"\n+++\n",
        body: "# Page",
      },
      {
        markdown: "---\rtitle: Hello\r...\r# Page",
        frontmatter: "---\rtitle: Hello\r...\r",
        body: "# Page",
      },
      {
        markdown: "---\ntitle: Hello\n---",
        frontmatter: "---\ntitle: Hello\n---",
        body: "",
      },
      {
        markdown: "+++\r\ntitle = \"Hello\"\r\n+++\r\n \t\r\n\r\n  body",
        frontmatter: "+++\r\ntitle = \"Hello\"\r\n+++\r\n \t\r\n\r\n",
        body: "  body",
      },
    ];

    for (const { markdown, frontmatter, body } of cases) {
      expect(splitMarkdownFrontmatter(markdown)).toEqual({ frontmatter, body });
    }
  });

  test("does not split non-leading, missing, or mismatched delimiters", () => {
    for (const markdown of [
      "Intro\n---\ntitle: x\n---\nBody",
      "Intro\n+++\ntitle = \"x\"\n+++\nBody",
      "plain Markdown",
      "---",
      "---\ntitle: unclosed",
      "---\ntitle: mismatched\n+++\nBody",
      "+++\ntitle = \"mismatched\"\n---\nBody",
    ]) {
      expect(splitMarkdownFrontmatter(markdown)).toEqual({
        frontmatter: "",
        body: markdown,
      });
    }
  });

  test("reattaches frontmatter with a source-compatible separator when needed", () => {
    expect(restoreMarkdownFrontmatter("", "Body")).toBe("Body");
    expect(restoreMarkdownFrontmatter("---\ntitle: x\n---", "")).toBe(
      "---\ntitle: x\n---",
    );
    expect(restoreMarkdownFrontmatter("---\ntitle: x\n---\n", "Body")).toBe(
      "---\ntitle: x\n---\nBody",
    );
    expect(restoreMarkdownFrontmatter("---\ntitle: x\n---", "\nBody")).toBe(
      "---\ntitle: x\n---\nBody",
    );
    expect(restoreMarkdownFrontmatter("---\ntitle: x\n---", "\rBody")).toBe(
      "---\ntitle: x\n---\rBody",
    );
    expect(restoreMarkdownFrontmatter("---\ntitle: x\n---", "Body")).toBe(
      "---\ntitle: x\n---\nBody",
    );
    expect(restoreMarkdownFrontmatter("+++\r\ntitle = \"x\"\r\n+++", "Body"))
      .toBe("+++\r\ntitle = \"x\"\r\n+++\r\nBody");
    expect(restoreMarkdownFrontmatter("---\rtitle: x\r...", "Body")).toBe(
      "---\rtitle: x\r...\rBody",
    );
    expect(restoreMarkdownFrontmatter("metadata", "Body")).toBe(
      "metadata\nBody",
    );
  });

  test("rejects Markdown when schema validation fails", () => {
    const originalParse = MarkdownManager.prototype.parse;
    MarkdownManager.prototype.parse = (() => ({
      type: "doc",
      content: [{ type: "unknownTestNode" }],
    })) as typeof MarkdownManager.prototype.parse;

    try {
      expect(assessMarkdownForRichEditing("# Heading")).toEqual({
        safe: false,
        reason:
          "This file could not be parsed safely in Rendered mode. Continue editing in Raw mode.",
      });
    } finally {
      MarkdownManager.prototype.parse = originalParse;
    }
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

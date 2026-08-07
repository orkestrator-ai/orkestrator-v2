import { getSchema } from "@tiptap/core";
import { Code } from "@tiptap/extension-code";
import { Image } from "@tiptap/extension-image";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Paragraph } from "@tiptap/extension-paragraph";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";

const RICH_MARKDOWN_TOKEN_TYPES = new Set([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "image",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "text",
  "url",
]);

const YAML_OPENING_DELIMITER = /^---[ \t]*$/;
const YAML_CLOSING_DELIMITER = /^(?:---|\.\.\.)[ \t]*$/;
const TOML_OPENING_DELIMITER = /^\+\+\+[ \t]*$/;
const TOML_CLOSING_DELIMITER = /^\+\+\+[ \t]*$/;

export interface MarkdownFrontmatterSplit {
  /** The exact leading frontmatter and spacing before the document body. */
  frontmatter: string;
  body: string;
}

interface MarkdownLine {
  content: string;
  contentEnd: number;
  nextStart: number;
  hasLineEnding: boolean;
}

function readMarkdownLine(markdown: string, start: number): MarkdownLine {
  let contentEnd = start;
  while (
    contentEnd < markdown.length &&
    markdown[contentEnd] !== "\n" &&
    markdown[contentEnd] !== "\r"
  ) {
    contentEnd += 1;
  }

  if (contentEnd === markdown.length) {
    return {
      content: markdown.slice(start),
      contentEnd,
      nextStart: contentEnd,
      hasLineEnding: false,
    };
  }

  const lineEndingLength = markdown.startsWith("\r\n", contentEnd) ? 2 : 1;
  return {
    content: markdown.slice(start, contentEnd),
    contentEnd,
    nextStart: contentEnd + lineEndingLength,
    hasLineEnding: true,
  };
}

/**
 * Separate leading YAML or TOML frontmatter from the Markdown body without
 * normalizing any source bytes. Frontmatter is metadata rather than rendered
 * document content, so the rich editor retains it outside ProseMirror and
 * prepends it again when serializing an edit.
 */
export function splitMarkdownFrontmatter(
  markdown: string,
): MarkdownFrontmatterSplit {
  const openingStart = markdown.startsWith("\uFEFF") ? 1 : 0;
  const openingLine = readMarkdownLine(markdown, openingStart);
  const closingDelimiter = YAML_OPENING_DELIMITER.test(openingLine.content)
    ? YAML_CLOSING_DELIMITER
    : TOML_OPENING_DELIMITER.test(openingLine.content)
      ? TOML_CLOSING_DELIMITER
      : null;

  if (!closingDelimiter || !openingLine.hasLineEnding) {
    return { frontmatter: "", body: markdown };
  }

  let closingLineStart = openingLine.nextStart;
  let bodyStart: number | null = null;
  while (closingLineStart <= markdown.length) {
    const line = readMarkdownLine(markdown, closingLineStart);
    if (closingDelimiter.test(line.content)) {
      bodyStart = line.contentEnd;
      break;
    }
    if (!line.hasLineEnding) break;
    closingLineStart = line.nextStart;
  }

  if (bodyStart === null) {
    return { frontmatter: "", body: markdown };
  }

  // Preserve the closing delimiter's line ending and any fully blank lines,
  // but leave indentation on the first content line in the Markdown body.
  while (bodyStart < markdown.length) {
    const lineEnding = markdown.startsWith("\r\n", bodyStart)
      ? "\r\n"
      : markdown[bodyStart] === "\n" || markdown[bodyStart] === "\r"
        ? markdown[bodyStart]
        : null;
    if (!lineEnding) break;

    bodyStart += lineEnding.length;
    const whitespaceStart = bodyStart;
    while (markdown[bodyStart] === " " || markdown[bodyStart] === "\t") {
      bodyStart += 1;
    }

    const nextLineIsBlank =
      bodyStart === markdown.length ||
      markdown[bodyStart] === "\n" ||
      markdown[bodyStart] === "\r";
    if (!nextLineIsBlank) {
      bodyStart = whitespaceStart;
      break;
    }
  }

  return {
    frontmatter: markdown.slice(0, bodyStart),
    body: markdown.slice(bodyStart),
  };
}

/** Reattach preserved frontmatter without fusing an EOF delimiter to new body text. */
export function restoreMarkdownFrontmatter(
  frontmatter: string,
  body: string,
): string {
  if (
    !frontmatter ||
    !body ||
    frontmatter.endsWith("\n") ||
    frontmatter.endsWith("\r") ||
    body.startsWith("\n") ||
    body.startsWith("\r")
  ) {
    return frontmatter + body;
  }

  const sourceLineEnding = frontmatter.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  return frontmatter + sourceLineEnding + body;
}

// Tiptap's default Code mark excludes every other mark. Markdown permits
// inline code inside emphasis and links, so allow those combinations in the
// rich-editing schema instead of producing invalid parsed JSON.
const MarkdownCode = Code.extend({
  excludes: "",
});

// The stock Markdown paragraph parser unwraps a paragraph containing only an
// image because Image is block-level by default. Our image placeholder is
// intentionally inline so images can also appear within prose; retain the
// paragraph wrapper to keep standalone images valid with that schema.
const MarkdownParagraph = Paragraph.extend({
  parseMarkdown: (token, helpers) => {
    const tokens = token.tokens || [];
    const content = helpers.parseInline(tokens);
    const firstToken = tokens[0];
    const hasExplicitEmptyParagraphMarker =
      tokens.length === 1 &&
      firstToken?.type === "text" &&
      (firstToken.raw === "&nbsp;" ||
        firstToken.text === "&nbsp;" ||
        firstToken.raw === "\u00A0" ||
        firstToken.text === "\u00A0");

    if (hasExplicitEmptyParagraphMarker) {
      return helpers.createNode("paragraph", undefined, []);
    }

    return helpers.createNode("paragraph", undefined, content);
  },
});

export interface MarkdownRichEditingAssessment {
  safe: boolean;
  reason: string | null;
}

function findUnsupportedTokenTypes(value: unknown, unsupported: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => findUnsupportedTokenTypes(item, unsupported));
    return;
  }

  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  if (
    typeof record.type === "string" &&
    !RICH_MARKDOWN_TOKEN_TYPES.has(record.type)
  ) {
    unsupported.add(record.type);
  }

  Object.values(record).forEach((item) =>
    findUnsupportedTokenTypes(item, unsupported),
  );
}

let markdownValidator:
  | {
      manager: MarkdownManager;
      schema: ReturnType<typeof getSchema>;
    }
  | undefined;

function validateMarkdownSchema(markdown: string): void {
  if (!markdownValidator) {
    const extensions = createMarkdownExtensions();
    markdownValidator = {
      manager: new MarkdownManager({ extensions }),
      schema: getSchema(extensions),
    };
  }

  const documentJson = markdownValidator.manager.parse(markdown);
  const document = markdownValidator.schema.nodeFromJSON(documentJson);
  document.check();
}

/**
 * Reject Markdown constructs that the configured Tiptap schema cannot
 * serialize without losing information. Unsafe documents stay editable in
 * raw mode instead of being silently normalized into a lossy projection.
 */
export function assessMarkdownForRichEditing(
  markdown: string,
): MarkdownRichEditingAssessment {
  try {
    const { body } = splitMarkdownFrontmatter(markdown);

    const unsupported = new Set<string>();
    findUnsupportedTokenTypes(marked.lexer(body, { gfm: true }), unsupported);

    if (unsupported.size > 0) {
      return {
        safe: false,
        reason:
          "This file uses Markdown constructs that Rendered mode cannot preserve. Continue editing in Raw mode.",
      };
    }

    // Token types can be supported individually while still producing an
    // invalid combination for the configured ProseMirror schema. Validate the
    // actual Markdown projection so preflight and editor creation agree.
    validateMarkdownSchema(body);

    return { safe: true, reason: null };
  } catch {
    return {
      safe: false,
      reason:
        "This file could not be parsed safely in Rendered mode. Continue editing in Raw mode.",
    };
  }
}

const MarkdownImage = Image.extend({
  renderHTML({ HTMLAttributes }) {
    const source = typeof HTMLAttributes.src === "string" ? HTMLAttributes.src : "";
    const alt = typeof HTMLAttributes.alt === "string" ? HTMLAttributes.alt : "";
    const label = alt || source || "Image";

    // Preserve image Markdown without fetching remote or unresolved relative
    // URLs merely because a document was opened in the desktop renderer.
    return [
      "span",
      {
        class:
          "inline-flex max-w-full items-center rounded border border-border bg-muted px-2 py-1 text-sm text-muted-foreground",
        "data-markdown-image": "",
        title: source || undefined,
      },
      `Image: ${label}`,
    ];
  },
});

export function createMarkdownExtensions() {
  return [
    StarterKit.configure({
      code: false,
      paragraph: false,
    }),
    MarkdownCode,
    MarkdownParagraph,
    Markdown.configure({
      markedOptions: {
        gfm: true,
      },
    }),
    MarkdownImage.configure({
      inline: true,
      allowBase64: false,
    }),
    Table.configure({
      resizable: true,
    }),
    TableRow,
    TableHeader,
    TableCell,
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
  ];
}

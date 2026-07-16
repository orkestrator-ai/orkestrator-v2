import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Image } from "@tiptap/extension-image";
import {
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
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

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?(?:---|\+\+\+)\r?\n[\s\S]*?\r?\n(?:---|\+\+\+|\.\.\.)[ \t]*(?:\r?\n|$)/;

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

/**
 * Reject Markdown constructs that the configured Tiptap schema cannot
 * serialize without losing information. Unsafe documents stay editable in
 * raw mode instead of being silently normalized into a lossy projection.
 */
export function assessMarkdownForRichEditing(
  markdown: string,
): MarkdownRichEditingAssessment {
  try {
    if (FRONTMATTER_PATTERN.test(markdown)) {
      return {
        safe: false,
        reason:
          "This file uses Markdown constructs that Rendered mode cannot preserve. Continue editing in Raw mode.",
      };
    }

    const unsupported = new Set<string>();
    findUnsupportedTokenTypes(marked.lexer(markdown, { gfm: true }), unsupported);

    if (unsupported.size > 0) {
      return {
        safe: false,
        reason:
          "This file uses Markdown constructs that Rendered mode cannot preserve. Continue editing in Raw mode.",
      };
    }

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
    StarterKit,
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

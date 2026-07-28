import { marked, Renderer, type Tokens } from "marked";
import type {
  NativeMessage,
  NativeMessagePart,
} from "@/lib/chat/native-message-types";

class SearchTextRenderer extends Renderer {
  override space(): string {
    return "\n";
  }

  override code({ text }: Tokens.Code): string {
    return `${text}\n`;
  }

  override blockquote({ tokens }: Tokens.Blockquote): string {
    return `${this.parser.parse(tokens)}\n`;
  }

  override html(): string {
    // react-markdown does not opt into raw HTML rendering.
    return "";
  }

  override def(): string {
    return "";
  }

  override heading({ tokens }: Tokens.Heading): string {
    return `${this.parser.parseInline(tokens)}\n`;
  }

  override hr(): string {
    return "\n";
  }

  override list(token: Tokens.List): string {
    return `${token.items.map((item) => this.listitem(item)).join("\n")}\n`;
  }

  override listitem(item: Tokens.ListItem): string {
    return this.parser.parse(item.tokens);
  }

  override checkbox(): string {
    // The chat renderer replaces Markdown checkboxes with aria-hidden icons.
    return "";
  }

  override paragraph({ tokens }: Tokens.Paragraph): string {
    return `${this.parser.parseInline(tokens)}\n`;
  }

  override table(token: Tokens.Table): string {
    const rows = [token.header, ...token.rows];
    return `${rows
      .map((row) =>
        row
          .map((cell) => this.parser.parseInline(cell.tokens))
          .join("\t"))
      .join("\n")}\n`;
  }

  override tablerow({ text }: Tokens.TableRow<string>): string {
    return `${text}\n`;
  }

  override tablecell(token: Tokens.TableCell): string {
    return this.parser.parseInline(token.tokens);
  }

  override strong({ tokens }: Tokens.Strong): string {
    return this.parser.parseInline(tokens);
  }

  override em({ tokens }: Tokens.Em): string {
    return this.parser.parseInline(tokens);
  }

  override codespan({ text }: Tokens.Codespan): string {
    return text;
  }

  override br(): string {
    return "\n";
  }

  override del({ tokens }: Tokens.Del): string {
    return this.parser.parseInline(tokens);
  }

  override link({ tokens }: Tokens.Link): string {
    return this.parser.parseInline(tokens);
  }

  override image(): string {
    // Image alt text is not a searchable DOM text node.
    return "";
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    return "tokens" in token && token.tokens
      ? this.parser.parseInline(token.tokens)
      : token.text;
  }
}

const searchTextRenderer = new SearchTextRenderer();

export function markdownToAgentSearchText(markdown: string): string {
  if (!markdown) return "";

  try {
    const rendered = marked.parse(markdown, {
      renderer: searchTextRenderer,
      gfm: true,
      breaks: true,
      async: false,
    });
    return rendered.replace(/\n{3,}/g, "\n\n").trimEnd();
  } catch {
    // Search must remain available even if a malformed or extension-specific
    // Markdown fragment cannot be tokenized by Marked.
    return markdown;
  }
}

function textPartSources(parts: readonly NativeMessagePart[]): string[] {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.content);
}

/**
 * Mirrors the content roots rendered by NativeMessage: each text part is one
 * independently searchable Markdown segment, with message.content as the
 * fallback for system/error/legacy messages without text parts.
 */
export function getNativeMessageSearchText(
  message: NativeMessage,
): string {
  if (
    message.role === "system"
    || message.id.startsWith("system-")
    || message.id.startsWith("error-")
  ) {
    return message.content;
  }

  const sources = textPartSources(message.parts);
  if (sources.length === 0) return message.content;

  return sources
    .map(markdownToAgentSearchText)
    .filter(Boolean)
    .join("\n\n");
}

import { marked, Renderer, type Tokens } from "marked";
import { artifactPartSearchSegments } from "@/lib/chat/rich-search-text";
import { cachedArtifactSearchBody } from "@/lib/chat/artifact-requests";
import { richMarkdownEnabled } from "@/hooks/useTranscriptArtifactCapabilities";
import { parseLocalFileLinkTarget } from "@/lib/chat/file-url";
import type { NativeMessage, NativeMessagePart } from "@/lib/chat/native-message-types";
import type { StructuredReviewReport } from "@orkestrator/protocol/structured-review";
import {
  jsonPayloadSearchText,
  parseJsonPayload,
  structuredReviewJsonPayload,
} from "@/lib/chat/json-payload";
import { userPromptPresentation } from "@/lib/chat/user-prompt-display";
import { markdownSearchProjection } from "@/lib/chat/rich-markdown/markdown-search";
import {
  offsetSegments,
  withSearchProjection,
  type SearchProjection,
  type SearchSegment,
} from "@/lib/chat/rich-markdown/search-segments";
import {
  PEER_MAIL_MESSAGE_PREFIX,
  splitPeerMailNativeMessageContent,
} from "@/lib/chat/client-only-messages";

class SearchTextRenderer extends Renderer {
  override space(): string {
    // Block renderers already contribute the DOM's separator. Emitting the
    // source blank line as well would add a searchable character that no
    // mounted text node owns.
    return "";
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
      .map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)).join("\t"))
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

  override image(_token: Tokens.Image): string {
    // Image alt text is not a searchable DOM text node.
    return "";
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    return "tokens" in token && token.tokens ? this.parser.parseInline(token.tokens) : token.text;
  }
}

/** Peer mail renders each image as its alt text (or URL) rather than loading it. */
class PeerMailSearchTextRenderer extends SearchTextRenderer {
  override link({ tokens, href }: Tokens.Link): string {
    const label = this.parser.parseInline(tokens);
    return parseLocalFileLinkTarget(href) ? `${label} ${href}` : label;
  }

  override image({ text, href }: Tokens.Image): string {
    return text || href;
  }
}

const searchTextRenderer = new SearchTextRenderer();
const peerMailSearchTextRenderer = new PeerMailSearchTextRenderer();

export function markdownToAgentSearchText(
  markdown: string,
  renderer: Renderer = searchTextRenderer,
): string {
  if (!markdown) return "";

  try {
    const rendered = marked.parse(markdown, {
      renderer,
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

interface SearchSource {
  source: string;
  /** Rendered by `TextPart` (rich pipeline) rather than plain `MessageMarkdown`. */
  rich: boolean;
  /** Plain text rendered verbatim (an artifact card's summary). */
  literal?: boolean;
}

function textPartSources(parts: readonly NativeMessagePart[]): SearchSource[] {
  return parts.flatMap((part): SearchSource[] => {
    if (part.type === "text" || part.type === "async-question") {
      return [{ source: part.content, rich: true }];
    }
    if (part.type === "transcript-reference") {
      // Quoted excerpts and comments render through plain `MessageMarkdown`.
      return part.comment
        ? [
            { source: part.content, rich: false },
            { source: part.comment, rich: false },
          ]
        : [{ source: part.content, rich: false }];
    }
    if (part.type === "artifact") {
      // The card's summary root plus, once its body has loaded, its label root.
      return artifactPartSearchSegments(part, cachedArtifactSearchBody(part.artifact)).map(
        (source) => ({ source, rich: false, literal: true }),
      );
    }
    return [];
  });
}

/**
 * The searchable text of one rendered text part.
 *
 * `NativeMessage` folds an agent block that is nothing but a JSON document into
 * a closed disclosure, which unmounts everything below its trigger. Find
 * highlights are drawn from mounted DOM text nodes, so indexing the raw
 * document here would report matches that can never be highlighted — and,
 * because highlights are assigned by occurrence *ordinal* within a row, would
 * also shift the numbering of every sibling part in the same message onto the
 * wrong text. Folded parts therefore contribute exactly what the collapsed row
 * renders.
 */
function textPartSearchProjection(
  source: string,
  foldJsonPayload: boolean,
  rich = richMarkdownEnabled(),
): SearchProjection {
  if (foldJsonPayload) {
    const payload = parseJsonPayload(source);
    if (payload) return { text: jsonPayloadSearchText(payload), segments: [] };
  }
  // Derived from the renderer's own parse, so it matches mounted DOM text.
  return markdownSearchProjection(source, { rich });
}

/** Join projections with `separator`, dropping empty ones and shifting segments. */
function joinProjections(
  chunks: readonly { projection: SearchProjection; part: number }[],
  separator: string,
): SearchProjection {
  let text = "";
  const segments: SearchSegment[] = [];
  for (const { projection, part } of chunks) {
    if (!projection.text) continue;
    if (text) text += separator;
    segments.push(...offsetSegments(projection.segments, text.length, part));
    text += projection.text;
  }
  return { text, segments };
}

function userTextPartSearchProjection(
  source: string,
  promptPresentation?: NativeMessage["promptPresentation"],
  promptEvidence?: StructuredReviewReport,
  part = 0,
): SearchProjection {
  const presentation = userPromptPresentation(source, promptPresentation);
  const evidence = promptEvidence
    ? structuredReviewJsonPayload(promptEvidence)
    : presentation.evidencePayload;
  return joinProjections(
    [
      {
        projection: { text: evidence ? jsonPayloadSearchText(evidence) : "", segments: [] },
        part,
      },
      { projection: textPartSearchProjection(presentation.displayText, false), part },
    ],
    "\n\n",
  );
}

/**
 * Mirrors the content roots rendered by NativeMessage: each text part is one
 * independently searchable segment, with message.content as the fallback for
 * system/error/legacy messages without text parts.
 */
function nativeMessageSearchText(message: NativeMessage): string {
  return getNativeMessageSearchProjection(message).text;
}

/**
 * The message's searchable text (exactly `getNativeMessageSearchText`) plus
 * per-block segments for its rich Markdown blocks. Segment `part` is the
 * ordinal of the source part within the message.
 */
export function getNativeMessageSearchProjection(message: NativeMessage): SearchProjection {
  // A peer-mail card only tags its Markdown body as searchable content.
  if (message.id.startsWith(PEER_MAIL_MESSAGE_PREFIX)) {
    return {
      text: markdownToAgentSearchText(
        splitPeerMailNativeMessageContent(message.content).body,
        peerMailSearchTextRenderer,
      ),
      segments: [],
    };
  }

  if (
    message.role === "system" ||
    message.id.startsWith("system-") ||
    message.id.startsWith("error-")
  ) {
    return { text: message.content, segments: [] };
  }

  // NativeMessage only folds JSON for non-user roles. User prompts are indexed
  // through the same presentation filter the bubble uses, so backend-only
  // evidence frames do not create invisible find matches.
  const foldJsonPayload = message.role !== "user";
  const sources = textPartSources(message.parts);
  if (sources.length === 0) {
    // Legacy content without parts renders through `TextPart`, so it is
    // normalized exactly like a text part of the same role.
    const payload = foldJsonPayload ? parseJsonPayload(message.content) : null;
    if (payload) return { text: jsonPayloadSearchText(payload), segments: [] };
    return message.role === "user"
      ? userTextPartSearchProjection(
          message.content,
          message.promptPresentation,
          message.promptEvidence,
        )
      : textPartSearchProjection(message.content, false);
  }

  let promptPresentationAvailable = message.promptPresentation;
  let promptEvidenceAvailable = message.promptEvidence;
  return joinProjections(
    sources.map(({ source, rich, literal }, part) => {
      if (literal) return { projection: { text: source, segments: [] }, part };
      if (!rich) return { projection: textPartSearchProjection(source, false, false), part };
      if (message.role !== "user") {
        return { projection: textPartSearchProjection(source, foldJsonPayload), part };
      }
      const promptPresentation = promptPresentationAvailable;
      const promptEvidence = promptEvidenceAvailable;
      promptPresentationAvailable = undefined;
      promptEvidenceAvailable = undefined;
      return {
        projection: userTextPartSearchProjection(source, promptPresentation, promptEvidence, part),
        part,
      };
    }),
    "\n\n",
  );
}

/**
 * The searchable text of a message, carrying its semantic projection
 * (`getSearchText.projection`) so find pairs rich-block matches per block.
 */
export const getNativeMessageSearchText = withSearchProjection(
  nativeMessageSearchText,
  getNativeMessageSearchProjection,
);

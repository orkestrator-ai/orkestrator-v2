/**
 * The remark plugin lists and URL policy shared by `MessageMarkdown` and the
 * find projection (`markdown-search.ts`). Both must parse with exactly the same
 * configuration, or find would index text the renderer never shows. The lists
 * are hoisted constants: `MessageMarkdown` is memoized on content, which is
 * only sound while its plugin and component props keep their identity.
 */
import { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList, Processor } from "unified";
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";
import { parseLocalFileLinkTarget } from "@/lib/chat/file-url";
import { remarkRichMarkdown } from "./remark-rich-markdown";

/**
 * Hard parser-boundary budgets (characters). Transcript-specific presentation
 * helpers may apply smaller limits, but no caller can make react-markdown parse
 * beyond these caps accidentally.
 */
export const MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS = MARKDOWN_POLICY.blockParserCharacters;
export const MAX_INLINE_MARKDOWN_RENDER_CHARACTERS = MARKDOWN_POLICY.inlineParserCharacters;

export interface MarkdownRenderSource {
  /** The bounded slice handed to the parser. */
  source: string;
  omittedCharacters: number;
}

/**
 * The bounded rendering slice. The caller keeps the original string; the slice
 * is never written back, so copy/open-full-source actions use the original.
 */
export function markdownRenderSource(content: string, limit: number): MarkdownRenderSource {
  if (content.length <= limit) return { source: content, omittedCharacters: 0 };
  return {
    source: content.slice(0, limit),
    omittedCharacters: content.length - limit,
  };
}

/**
 * Block constructs that must not fire on a single-line inline render.
 *
 * An inline caller has already flattened its text onto one line, so none of
 * these can carry the meaning they normally would — they can only consume
 * their own marker. `- read the reducer` would render as `read the reducer`,
 * `# Plan` as `Plan`, and a line that is exactly `---` as nothing at all,
 * silently dropping text the caller asked to display. Disabling them keeps the
 * source characters visible and guarantees the parse yields one paragraph.
 *
 * `labelStartImage` is in the list for the same reason: an image is not
 * phrasing content this renderer emits, so `![alt](url)` would unwrap to an
 * empty string rather than showing the text the author wrote.
 */
const INLINE_ONLY_DISABLED_CONSTRUCTS = [
  "blockQuote",
  "codeFenced",
  "codeIndented",
  "definition",
  "headingAtx",
  "htmlFlow",
  "labelStartImage",
  "list",
  "setextUnderline",
  "thematicBreak",
];

/**
 * `micromarkExtensions` is contributed to unified's `Data` by `remark-parse`,
 * which reaches this package only as a transitive dependency of react-markdown
 * and so cannot be imported here for its type augmentation. Name the one field
 * this plugin touches rather than widening `data` to `any`.
 */
type MicromarkExtensionData = {
  micromarkExtensions?: Array<{ disable?: { null?: Array<string> } }>;
};

function remarkInlineOnly(this: Processor): undefined {
  const data = this.data() as MicromarkExtensionData;
  data.micromarkExtensions ??= [];
  data.micromarkExtensions.push({ disable: { null: INLINE_ONLY_DISABLED_CONSTRUCTS } });
}

export const PLUGINS_WITH_BREAKS: PluggableList = [remarkGfm, remarkBreaks];
export const PLUGINS_WITHOUT_BREAKS: PluggableList = [remarkGfm];
export const INLINE_PLUGINS: PluggableList = [remarkGfm, remarkInlineOnly];
export const INLINE_MARKDOWN_ELEMENTS = ["p", "strong", "em", "del", "code", "a"];

const RICH_PLUGINS = {
  breaks: {
    complete: [remarkGfm, remarkBreaks, [remarkRichMarkdown, { clipped: false }]],
    clipped: [remarkGfm, remarkBreaks, [remarkRichMarkdown, { clipped: true }]],
  },
  noBreaks: {
    complete: [remarkGfm, [remarkRichMarkdown, { clipped: false }]],
    clipped: [remarkGfm, [remarkRichMarkdown, { clipped: true }]],
  },
} satisfies Record<string, Record<string, PluggableList>>;

/** The block plugin list for one rendering mode. Always a hoisted constant. */
export function blockMarkdownPlugins(options: {
  rich: boolean;
  enableBreaks: boolean;
  clipped: boolean;
}): PluggableList {
  if (!options.rich) return options.enableBreaks ? PLUGINS_WITH_BREAKS : PLUGINS_WITHOUT_BREAKS;
  const group = options.enableBreaks ? RICH_PLUGINS.breaks : RICH_PLUGINS.noBreaks;
  return options.clipped ? group.clipped : group.complete;
}

export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "href" && node.tagName === "a" && parseLocalFileLinkTarget(url)) {
    return url;
  }

  return defaultUrlTransform(url);
};

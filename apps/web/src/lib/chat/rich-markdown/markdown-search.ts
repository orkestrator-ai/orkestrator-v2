/**
 * Find projection for Markdown rendered by `MessageMarkdown`.
 *
 * Find counts matches in the message model but draws highlights from mounted
 * DOM text, pairing them by occurrence ordinal within a row. The two must
 * agree exactly, so this projection is derived from the *same* parse the
 * renderer performs — react-markdown with the shared plugin lists — and then
 * reads the hast tree the way the DOM will hold it:
 *
 *  - text and raw-HTML nodes contribute their text (react-markdown renders raw
 *    HTML as literal text);
 *  - whitespace-only text inside table rows is dropped, as React drops it;
 *  - a task-list item drops whitespace-only direct children, as
 *    `MarkdownListItem` does; images and checkboxes contribute nothing;
 *  - each rich block contributes its semantic search segment: a code block its
 *    displayed body, a diagram its source (kept findable, and revealable, even
 *    while the preview is shown), a chart its labels, a disclosure its summary
 *    plus its body (findable while collapsed through a hidden mirror the block
 *    renders, with a reveal action that opens it).
 *
 * Toolbar chrome, labels and omission notices are marked `data-rich-chrome`
 * in the DOM and excluded on both sides. Offsets are UTF-16 code units of the
 * projected string, the convention `findAgentChatTextMatches` uses.
 *
 * `markdownSearchProjection` additionally returns per-block segments (see
 * `search-segments.ts`): each outermost keyed rich block — a code block, a
 * diagram, a disclosure, a table — with its stable block id, its range in the
 * projected text and in the source, and how find reveals it. Find pairs
 * matches with DOM text per block instead of by one ordinal per row.
 */
import Markdown from "react-markdown";
import { parseChartSpec } from "@orkestrator/protocol/chart-spec";
import { chartSpecSearchText } from "@/lib/chat/rich-search-text";
import {
  blockMarkdownPlugins,
  INLINE_PLUGINS,
  MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS,
  MAX_INLINE_MARKDOWN_RENDER_CHARACTERS,
  markdownRenderSource,
  markdownUrlTransform,
} from "./markdown-plugins";
import { RICH_ELEMENTS } from "./remark-rich-markdown";
import { registerProtectedRichCache } from "@/lib/chat/rich-content-reset";
import type {
  SearchProjection,
  SearchSegment,
  SearchSegmentKind,
  SearchSegmentReveal,
} from "./search-segments";

export interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const TABLE_ROW_ELEMENTS = new Set(["table", "thead", "tbody", "tfoot", "tr"]);

function isWhitespaceText(node: HastNode): boolean {
  return (node.type === "text" || node.type === "raw") && /^[ \t\n\f\r]*$/.test(node.value ?? "");
}

/** The text a code body shows: one DOM line per source line, `\n`-joined. */
export function codeDisplayText(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** Searchable text for a `chart` fence: validated labels, else its source. */
export function chartFenceSearchText(source: string, closed: boolean): string {
  if (closed) {
    const parsed = parseChartSpec(source);
    if (parsed.ok) return chartSpecSearchText(parsed.value);
  }
  return codeDisplayText(source);
}

export function richCodeSearchText(properties: Record<string, unknown> | undefined): string {
  const source = typeof properties?.source === "string" ? properties.source : "";
  if (properties?.language === "chart")
    return chartFenceSearchText(source, properties.closed === true);
  return codeDisplayText(source);
}

/** Text of a hast subtree as the transcript DOM will hold it. */
export function hastSearchText(node: HastNode): string {
  if (node.type === "text" || node.type === "raw") return node.value ?? "";
  if (node.type !== "element" && node.type !== "root") return "";
  switch (node.tagName) {
    case "img":
    case "input":
      return "";
    case RICH_ELEMENTS.code:
      return richCodeSearchText(node.properties);
    case RICH_ELEMENTS.details: {
      const summary = typeof node.properties?.summary === "string" ? node.properties.summary : "";
      return inlineMarkdownSearchText(summary) + hastChildrenSearchText(node);
    }
    default:
      return hastChildrenSearchText(node);
  }
}

export function hastChildrenSearchText(node: HastNode): string {
  const children = node.children ?? [];
  const dropWhitespace =
    (node.tagName !== undefined && TABLE_ROW_ELEMENTS.has(node.tagName)) ||
    (node.tagName === "li" &&
      children.some((child) => child.type === "element" && child.tagName === "input"));
  let text = "";
  for (const child of children) {
    if (dropWhitespace && isWhitespaceText(child)) continue;
    text += hastSearchText(child);
  }
  return text;
}

/**
 * The keyed block a hast element renders as, if any: the elements whose DOM
 * carries `data-rich-block-key` around their searchable text. A `chart`
 * fence is not keyed: its searchable labels are a mirror beside the chart.
 */
function keyedBlock(
  node: HastNode,
): { blockId: string; kind: SearchSegmentKind; reveal: SearchSegmentReveal } | null {
  if (node.type !== "element") return null;
  const blockId = node.properties?.blockId;
  if (typeof blockId !== "string" || !blockId) return null;
  switch (node.tagName) {
    case RICH_ELEMENTS.code: {
      const language = node.properties?.language;
      if (language === "chart") return null;
      return language === "mermaid"
        ? { blockId, kind: "diagram", reveal: "show-source" }
        : { blockId, kind: "code", reveal: null };
    }
    case RICH_ELEMENTS.details:
      return { blockId, kind: "details", reveal: "open-disclosure" };
    case "table":
      return { blockId, kind: "table", reveal: null };
    default:
      return null;
  }
}

interface ProjectionSink {
  text: string;
  segments: SearchSegment[];
}

/** `hastSearchText`, also recording the outermost keyed blocks as segments. */
function projectHast(node: HastNode, sink: ProjectionSink): void {
  const keyed = keyedBlock(node);
  if (keyed) {
    const start = sink.text.length;
    sink.text += hastSearchText(node);
    sink.segments.push({
      part: 0,
      blockId: keyed.blockId,
      kind: keyed.kind,
      start,
      end: sink.text.length,
      sourceStart: node.position?.start.offset ?? null,
      sourceEnd: node.position?.end.offset ?? null,
      reveal: keyed.reveal,
    });
    return;
  }
  if (
    node.type !== "element" && node.type !== "root"
      ? true
      : node.tagName === "img" ||
        node.tagName === "input" ||
        node.tagName === RICH_ELEMENTS.code ||
        node.tagName === RICH_ELEMENTS.details
  ) {
    // Leaves and unkeyed rich elements contribute exactly `hastSearchText`.
    sink.text += hastSearchText(node);
    return;
  }
  const children = node.children ?? [];
  const dropWhitespace =
    (node.tagName !== undefined && TABLE_ROW_ELEMENTS.has(node.tagName)) ||
    (node.tagName === "li" &&
      children.some((child) => child.type === "element" && child.tagName === "input"));
  for (const child of children) {
    if (dropWhitespace && isWhitespaceText(child)) continue;
    projectHast(child, sink);
  }
}

/** Search projection of a hast tree: `hastSearchText` plus block segments. */
export function hastSearchProjection(root: HastNode): SearchProjection {
  const sink: ProjectionSink = { text: "", segments: [] };
  projectHast(root, sink);
  return sink;
}

/** Text of an inline (`InlineMessageMarkdown`) render. */
function inlineHastText(node: HastNode): string {
  if (node.type === "text" || node.type === "raw") return node.value ?? "";
  if (node.type !== "element" && node.type !== "root") return "";
  const children = node.children ?? [];
  if (node.tagName === "a" && children.length === 0) {
    const href = node.properties?.href;
    return typeof href === "string" && href ? href : "[]";
  }
  return children.map(inlineHastText).join("");
}

interface CaptureSink {
  tree: HastNode | null;
}

/** Captures the final hast and hands react-markdown an empty tree to render. */
function captureHast(sink: CaptureSink) {
  return (tree: HastNode) => {
    sink.tree = tree;
    return { type: "root", children: [] };
  };
}

function parseToHast(
  source: string,
  remarkPlugins: ReturnType<typeof blockMarkdownPlugins>,
): HastNode | null {
  const sink: CaptureSink = { tree: null };
  // react-markdown's synchronous `Markdown` is a pure function of its options
  // (no hooks), so calling it directly runs the identical pipeline.
  Markdown({
    children: source,
    remarkPlugins,
    rehypePlugins: [[captureHast, sink]],
    urlTransform: markdownUrlTransform,
  });
  return sink.tree;
}

/** The hast a rich (or plain) block render of `source` produces; for tests and tooling. */
export function markdownHast(
  source: string,
  options: { rich: boolean; enableBreaks?: boolean; clipped?: boolean },
): HastNode | null {
  return parseToHast(
    source,
    blockMarkdownPlugins({
      rich: options.rich,
      enableBreaks: options.enableBreaks ?? true,
      clipped: options.clipped ?? false,
    }),
  );
}

const CACHE_MAX_ENTRIES = 512;
const CACHE_MAX_CHARACTERS = 8 * 1024 * 1024;
/** Estimated characters per stored segment record. */
const SEGMENT_COST = 64;
const cache = new Map<string, SearchProjection>();
let cachedCharacters = 0;

function sizeOf(key: string, value: SearchProjection): number {
  return key.length + value.text.length + value.segments.length * SEGMENT_COST;
}

function cachedProjection(key: string, compute: () => SearchProjection): SearchProjection {
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const value = compute();
  const size = sizeOf(key, value);
  if (size > CACHE_MAX_CHARACTERS / 8) return value;
  cache.set(key, value);
  cachedCharacters += size;
  while (cache.size > CACHE_MAX_ENTRIES || cachedCharacters > CACHE_MAX_CHARACTERS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const entry = cache.get(oldest.value);
    cachedCharacters -= entry ? sizeOf(oldest.value, entry) : oldest.value.length;
    cache.delete(oldest.value);
  }
  return value;
}

function cached(key: string, compute: () => string): string {
  return cachedProjection(key, () => ({ text: compute(), segments: [] })).text;
}

export function clearMarkdownSearchCache(): void {
  cache.clear();
  cachedCharacters = 0;
}

// Projections hold message text: cleared with other protected rich content.
registerProtectedRichCache("markdown-search", { clearAll: clearMarkdownSearchCache });

export interface MarkdownSearchOptions {
  /** Rendered with the rich transcript pipeline (`MessageMarkdown rich`). */
  rich: boolean;
  enableBreaks?: boolean;
}

/** Searchable text of one `MessageMarkdown` block render. */
export function markdownSearchText(markdown: string, options: MarkdownSearchOptions): string {
  return markdownSearchProjection(markdown, options).text;
}

/**
 * Searchable text of one `MessageMarkdown` block render plus its keyed rich
 * block segments (`part` is 0; callers combining parts renumber it).
 */
export function markdownSearchProjection(
  markdown: string,
  options: MarkdownSearchOptions,
): SearchProjection {
  if (!markdown) return { text: "", segments: [] };
  const enableBreaks = options.enableBreaks ?? true;
  const key = `${options.rich ? "r" : "p"}${enableBreaks ? "b" : "n"}\u0000${markdown}`;
  return cachedProjection(key, () => {
    const bounded = markdownRenderSource(markdown, MAX_BLOCK_MARKDOWN_RENDER_CHARACTERS);
    try {
      const tree = parseToHast(
        bounded.source,
        blockMarkdownPlugins({
          rich: options.rich,
          enableBreaks,
          clipped: bounded.omittedCharacters > 0,
        }),
      );
      return tree ? hastSearchProjection(tree) : { text: bounded.source, segments: [] };
    } catch {
      // Search must stay available even if a fragment cannot be tokenized.
      return { text: bounded.source, segments: [] };
    }
  });
}

/** Searchable text of an `InlineMessageMarkdown` render, omission note included. */
export function inlineMarkdownSearchText(markdown: string): string {
  if (!markdown) return "";
  return cached(`i\u0000${markdown}`, () => {
    const bounded = markdownRenderSource(markdown, MAX_INLINE_MARKDOWN_RENDER_CHARACTERS);
    let text: string;
    try {
      const tree = parseToHast(bounded.source, INLINE_PLUGINS);
      text = tree ? inlineHastText(tree) : bounded.source;
    } catch {
      text = bounded.source;
    }
    return bounded.omittedCharacters > 0
      ? `${text} … [${bounded.omittedCharacters} additional characters omitted]`
      : text;
  });
}

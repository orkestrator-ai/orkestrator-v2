/**
 * The rich transcript Markdown plugin.
 *
 * Runs inside react-markdown's normal remark pipeline (after GFM and breaks),
 * so the whole bounded document keeps its CommonMark/GFM semantics. It only
 * annotates and regroups the parsed tree:
 *
 *  - registers the controlled disclosure syntax and pairs its delimiter lines
 *    into `richDetails` nodes (malformed candidates become literal text);
 *  - turns a blockquote that opens with a GFM alert marker into a callout;
 *  - turns every code block into a `rich-code` element carrying its exact
 *    body, language, safe title/file hints, closed/incomplete state and a
 *    stable block id;
 *  - gives tables a stable block id.
 *
 * Block ids are `<kind>:<source offset>`: derived from parser position and node
 * kind, so repeated identical fences stay distinct, an appended token never
 * changes an earlier block's id, and no content hash or array index is used.
 * An edit before a block moves its offset and deliberately invalidates it.
 *
 * A fence is `closed` only when its own closing delimiter is present. A fence
 * that reaches the omission boundary of a clipped document is never closed,
 * because the boundary is not a genuine end of message.
 */
import { MARKDOWN_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { Processor } from "unified";
import {
  classifyDisclosureLine,
  DISCLOSURE_LINE_NODE,
  disclosureFromMarkdownExtension,
  disclosureMicromarkExtension,
  type DisclosureLineKind,
} from "./disclosure-syntax";
import { parseFenceInfo } from "./fence-info";

interface Point {
  line: number;
  column: number;
  offset?: number;
}

export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  lang?: string | null;
  meta?: string | null;
  position?: { start: Point; end: Point };
  data?: {
    hName?: string;
    hProperties?: Record<string, unknown>;
  };
}

export interface RichMarkdownPluginOptions {
  /** The rendered source is a prefix of a longer original (parser cap). */
  clipped: boolean;
}

export const RICH_CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type RichCalloutKind = (typeof RICH_CALLOUT_KINDS)[number];

/** Custom element names emitted for react-markdown `components`. */
export const RICH_ELEMENTS = {
  code: "rich-code",
  details: "rich-details",
  callout: "rich-callout",
} as const;

/** Properties carried by a `rich-code` element. */
export interface RichCodeProperties {
  source: string;
  language: string | null;
  title: string | null;
  fileHint: string | null;
  closed: boolean;
  fenced: boolean;
  blockId: string;
}

type ExtensionData = {
  micromarkExtensions?: unknown[];
  fromMarkdownExtensions?: unknown[];
};

export function remarkRichMarkdown(
  this: Processor,
  options: RichMarkdownPluginOptions = { clipped: false },
) {
  const data = this.data() as ExtensionData;
  (data.micromarkExtensions ??= []).push(disclosureMicromarkExtension);
  (data.fromMarkdownExtensions ??= []).push(disclosureFromMarkdownExtension);
  return (tree: MdNode, file: { value: unknown }) => {
    transformRichTree(tree, String(file.value ?? ""), options);
  };
}

export function transformRichTree(
  tree: MdNode,
  source: string,
  options: RichMarkdownPluginOptions,
): void {
  pairDisclosures(tree, 0);
  annotate(tree, source, options, 0);
}

function offsetOf(node: MdNode, edge: "start" | "end"): number {
  return node.position?.[edge].offset ?? 0;
}

// ---------------------------------------------------------------------------
// Disclosures

function isDisclosureLine(node: MdNode): boolean {
  return node.type === DISCLOSURE_LINE_NODE;
}

function literalLine(node: MdNode): MdNode {
  return {
    type: "paragraph",
    children: [{ type: "text", value: node.value ?? "", position: node.position }],
    position: node.position,
  };
}

/**
 * Pair candidate lines among one parent's children: a balanced opener and
 * closer whose first body node is a summary line becomes a disclosure, within
 * the nesting limit. Everything else is literal text.
 */
function buildDisclosureChildren(children: readonly MdNode[], depth: number): MdNode[] {
  const kinds = new Map<number, DisclosureLineKind>();
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  children.forEach((node, index) => {
    if (!isDisclosureLine(node)) return;
    const kind = classifyDisclosureLine(node.value ?? "");
    kinds.set(index, kind);
    if (kind.kind === "open") stack.push(index);
    else if (kind.kind === "close" && stack.length > 0) pairs.set(stack.pop()!, index);
  });

  const build = (from: number, to: number, level: number): MdNode[] => {
    const output: MdNode[] = [];
    for (let index = from; index < to; index++) {
      const node = children[index]!;
      const kind = kinds.get(index);
      if (!kind) {
        output.push(node);
        continue;
      }
      const close = kind.kind === "open" ? pairs.get(index) : undefined;
      if (close === undefined) {
        output.push(literalLine(node));
        continue;
      }
      const summary = index + 1 < close ? kinds.get(index + 1) : undefined;
      if (summary?.kind === "summary" && level < MARKDOWN_POLICY.maxDisclosureDepth) {
        const closer = children[close]!;
        output.push({
          type: "richDetails",
          children: build(index + 2, close, level + 1),
          position:
            node.position && closer.position
              ? { start: node.position.start, end: closer.position.end }
              : undefined,
          data: {
            hName: RICH_ELEMENTS.details,
            hProperties: {
              summary: summary.summary,
              blockId: `details:${offsetOf(node, "start")}`,
            },
          },
        });
      } else {
        output.push(
          literalLine(node),
          ...build(index + 1, close, level),
          literalLine(children[close]!),
        );
      }
      index = close;
    }
    return output;
  };

  return build(0, children.length, depth);
}

function pairDisclosures(parent: MdNode, depth: number): void {
  if (!parent.children) return;
  if (parent.children.some(isDisclosureLine)) {
    parent.children = buildDisclosureChildren(parent.children, depth);
  }
  for (const child of parent.children) {
    if (child.type === "richDetails") {
      // Its own children were paired while it was built; containers inside
      // the body (lists, quotes) are paired at the nested depth.
      for (const grandchild of child.children ?? []) pairDisclosures(grandchild, depth + 1);
    } else {
      pairDisclosures(child, depth);
    }
  }
}

// ---------------------------------------------------------------------------
// Callouts

const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][\t ]*(\r?\n|$)/i;

function applyCallout(blockquote: MdNode): void {
  const paragraph = blockquote.children?.[0];
  if (paragraph?.type !== "paragraph" || !paragraph.children) return;
  const first = paragraph.children[0];
  if (first?.type !== "text" || typeof first.value !== "string") return;
  const match = CALLOUT_MARKER.exec(first.value);
  if (!match) return;
  if (!match[2]) {
    // The marker must be its line's only content: the paragraph ends or a
    // (remark-breaks) line break follows.
    const next = paragraph.children[1];
    if (next && next.type !== "break") return;
    if (next) paragraph.children.splice(1, 1);
  }
  first.value = first.value.slice(match[0].length);
  if (first.value.length === 0) paragraph.children.splice(0, 1);
  if (paragraph.children.length === 0) blockquote.children!.splice(0, 1);
  blockquote.data = {
    ...blockquote.data,
    hName: RICH_ELEMENTS.callout,
    hProperties: { calloutKind: match[1]!.toLowerCase() as RichCalloutKind },
  };
}

// ---------------------------------------------------------------------------
// Code

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Whether a code block's own closing delimiter is present. Container prefixes
 * (`>` for each enclosing blockquote) are removed from the last line first.
 */
export function codeFenceState(
  source: string,
  node: MdNode,
  blockquoteDepth: number,
  clipped: boolean,
): { fenced: boolean; closed: boolean } {
  const start = offsetOf(node, "start");
  const end = offsetOf(node, "end");
  const text = source.slice(start, end);
  const lines = text.split(/\r\n|\r|\n/);
  const atOmissionBoundary = clipped && !/[\r\n]/.test(source.slice(end));
  const open = FENCE_OPEN.exec(lines[0] ?? "");
  if (!open) return { fenced: false, closed: !atOmissionBoundary };
  if (lines.length < 2) return { fenced: true, closed: false };
  let last = lines[lines.length - 1]!;
  for (let index = 0; index < blockquoteDepth; index++) last = last.replace(/^[ \t]*>[ \t]?/, "");
  const marker = open[1]!;
  const fenceChar = marker[0] === "`" ? "`" : "~";
  const closing = new RegExp(`^[ \\t]*\\${fenceChar}{${marker.length},}[ \\t]*$`);
  return { fenced: true, closed: closing.test(last) && !atOmissionBoundary };
}

function annotateCode(
  node: MdNode,
  source: string,
  options: RichMarkdownPluginOptions,
  blockquoteDepth: number,
) {
  const info = parseFenceInfo(node.lang, node.meta);
  const state = codeFenceState(source, node, blockquoteDepth, options.clipped);
  const properties: RichCodeProperties = {
    source: node.value ?? "",
    language: info.language,
    title: info.title,
    fileHint: info.fileHint,
    closed: state.closed,
    fenced: state.fenced,
    blockId: `code:${offsetOf(node, "start")}`,
  };
  node.type = "richCode";
  node.data = { hName: RICH_ELEMENTS.code, hProperties: { ...properties } };
}

// ---------------------------------------------------------------------------

function annotate(
  node: MdNode,
  source: string,
  options: RichMarkdownPluginOptions,
  blockquoteDepth: number,
): void {
  if (node.type === "code") {
    annotateCode(node, source, options, blockquoteDepth);
    return;
  }
  if (node.type === "table") {
    node.data = {
      ...node.data,
      hProperties: { ...node.data?.hProperties, blockId: `table:${offsetOf(node, "start")}` },
    };
  }
  const nestedDepth = node.type === "blockquote" ? blockquoteDepth + 1 : blockquoteDepth;
  if (node.children) {
    for (const child of node.children) annotate(child, source, options, nestedDepth);
  }
  // After the children: the marker removal must not hide a nested quote's own marker.
  if (node.type === "blockquote") applyCallout(node);
}

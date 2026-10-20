/**
 * Semantic model of a rendered Markdown table, read from the same hast the
 * renderer draws, so exports carry exactly the displayed cell text. Ordinary
 * Markdown tables are never sorted or typed: every cell stays text.
 */
import type { MarkdownAlignment } from "@orkestrator/protocol/tabular-export";
import { hastChildrenSearchText, type HastNode } from "./markdown-search";

export interface TableModel {
  header: string[];
  rows: string[][];
  align: MarkdownAlignment[];
}

function elementChildren(node: HastNode | undefined, tagName: string): HastNode[] {
  return (node?.children ?? []).filter(
    (child) => child.type === "element" && child.tagName === tagName,
  );
}

function cellAlignment(cell: HastNode): MarkdownAlignment {
  const align = cell.properties?.align;
  return align === "left" || align === "center" || align === "right" ? align : null;
}

export function tableModelFromHast(table: HastNode): TableModel {
  const head = elementChildren(table, "thead")[0];
  const body = elementChildren(table, "tbody")[0];
  const headerRow = elementChildren(head, "tr")[0];
  const headerCells = elementChildren(headerRow, "th");
  const header = headerCells.map((cell) => hastChildrenSearchText(cell));
  const align = headerCells.map(cellAlignment);
  const rows = elementChildren(body, "tr").map((row) =>
    elementChildren(row, "td").map((cell) => hastChildrenSearchText(cell)),
  );
  return { header, rows, align };
}

/** The exact Markdown source of a node from its parser offsets, or null. */
export function nodeSourceSlice(node: HastNode, source: string): string | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end < start || end > source.length) return null;
  return source.slice(start, end);
}

/**
 * Whether a node reaches the omission boundary of a clipped render. It is
 * known complete only when other content or a blank line follows it inside
 * the rendered slice; otherwise the cut may have removed its remaining rows.
 */
export function reachesOmissionBoundary(
  node: HastNode,
  renderedSource: string,
  clipped: boolean,
): boolean {
  if (!clipped) return false;
  const end = node.position?.end.offset;
  if (end === undefined) return true;
  const rest = renderedSource.slice(end);
  return !(/\S/.test(rest) || /\r?\n[ \t]*\r?\n/.test(rest));
}

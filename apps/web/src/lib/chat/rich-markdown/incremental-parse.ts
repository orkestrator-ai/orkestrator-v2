/**
 * Completed-prefix reuse for streaming Markdown.
 *
 * A streaming answer re-renders up to 20 times a second
 * (`MARKDOWN_POLICY.maxStreamingUpdatesPerSecond`), and running the whole
 * pipeline over a long answer costs tens of milliseconds, growing with its
 * length. Everything before the last block boundary that is proven safe cannot
 * change while text is appended after it, so it runs through the pipeline once
 * and its React elements are kept. React skips an element it has already
 * rendered, so only the tail costs anything per update.
 *
 * Correctness comes first and is conservative:
 *
 * - A boundary is the start of a line that follows a blank line, outside any
 *   fenced code, whose first character cannot continue or join the block
 *   before it (no indentation, list marker, block quote, table row, HTML or
 *   bracket). Rendering both sides on their own gives the same output as
 *   rendering the whole, which the equivalence tests check for every prefix of
 *   their fixtures.
 * - Constructs with document-wide meaning disable reuse for the whole text:
 *   link reference definitions and footnotes, raw HTML blocks (including the
 *   custom disclosures), and carriage returns.
 * - Reuse requires the new text to extend the cached prefix exactly; any
 *   other change resets the cache.
 * - Positions (line, column, offset) are shifted into document coordinates and
 *   the plugins still see the whole document, so block identities derived from
 *   source offsets are unchanged.
 * - Keys match a whole render's (`p-0`, `p-1`, counted per tag name among
 *   siblings), so the final render updates these elements in place rather than
 *   remounting them.
 *
 * Every remark/rehype transform, the URL policy and sanitisation still run over
 * every block; each block just runs once.
 */
import { cloneElement, isValidElement, type ReactNode } from "react";
import type { Processor } from "unified";

interface Point {
  line: number;
  column: number;
  offset?: number;
}

/** The slice of mdast this module touches: positions and children. */
interface MdNode {
  type: string;
  position?: { start: Point; end: Point };
  children?: MdNode[];
}

interface Root extends MdNode {
  type: "root";
  children: MdNode[];
}

/** Reuse is disabled for text containing any of these (document-wide or ambiguous). */
// Definitions can live inside any number of quote/list containers. A broad
// match is intentional: false positives only disable this optimisation.
const DOCUMENT_WIDE = /\[[^\]\n]+\]:|\[\^|^ {0,3}<|\r/m;

/** First characters a boundary line may not start with. */
const NON_BOUNDARY_START = /^(?:[ \t>|<[]|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|$)/;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The offset of the last safe boundary in `text`, or 0 when there is none.
 * Exported for tests.
 */
export function lastSafeBoundary(text: string): number {
  if (DOCUMENT_WIDE.test(text)) return 0;
  let boundary = 0;
  let fence: { char: string; length: number } | null = null;
  let previousBlank = false;
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf("\n", offset);
    // The final line may still be growing: never a boundary candidate.
    if (end === -1) break;
    const line = text.slice(offset, end);
    const marker = FENCE.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        line.slice(marker[0].length).trim() === ""
      ) {
        fence = null;
      }
      previousBlank = false;
    } else if (marker) {
      // Only an unindented fence: an indented one can belong to a list item.
      if (previousBlank && offset > 0 && (line[0] === "`" || line[0] === "~")) boundary = offset;
      fence = { char: marker[1]![0]!, length: marker[1]!.length };
      previousBlank = false;
    } else {
      const blank = line.trim() === "";
      if (!blank && previousBlank && offset > 0 && !NON_BOUNDARY_START.test(line)) {
        boundary = offset;
      }
      previousBlank = blank;
    }
    offset = end + 1;
  }
  return boundary;
}

function countLines(text: string): number {
  let lines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

function shiftPoint(point: Point | undefined, lines: number, offset: number): void {
  if (!point) return;
  point.line += lines;
  if (point.offset !== undefined) point.offset += offset;
}

/** Shift every position in `node`'s subtree from segment to document coordinates. */
function shift(node: MdNode, lines: number, offset: number): void {
  if (node.position) {
    shiftPoint(node.position.start, lines, offset);
    shiftPoint(node.position.end, lines, offset);
  }
  if (node.children) for (const child of node.children) shift(child, lines, offset);
}

/** One stretch of the document to render on its own. */
export interface MarkdownRange {
  start: number;
  end: number;
  /** Lines before `start`, to move positions into document coordinates. */
  lines: number;
}

const TOP_LEVEL_KEY = /^(.*)-(\d+)$/;

/**
 * Moves one stretch's top-level keys past the blocks before it. `seen` holds how
 * many of each tag name came before, and is advanced when `commit` is set.
 */
function continueKeys(
  nodes: readonly ReactNode[],
  seen: Map<string, number>,
  commit: boolean,
): ReactNode[] {
  const added = new Map<string, number>();
  const continued = nodes.map((node) => {
    if (!isValidElement(node) || node.key === null) return node;
    const match = TOP_LEVEL_KEY.exec(node.key);
    if (!match) return node;
    const name = match[1]!;
    const index = Number(match[2]);
    added.set(name, index + 1);
    const before = seen.get(name) ?? 0;
    return before === 0 ? node : cloneElement(node, { key: `${name}-${before + index}` });
  });
  if (commit) {
    for (const [name, count] of added) seen.set(name, (seen.get(name) ?? 0) + count);
  }
  return continued;
}

/** Blocks at the root of a rendered Markdown document are separated by a newline. */
function appendBlocks(blocks: readonly ReactNode[], next: readonly ReactNode[]): ReactNode[] {
  return blocks.length > 0 && next.length > 0 ? [...blocks, "\n", ...next] : [...blocks, ...next];
}

/**
 * Per text part, owned by its renderer. Holds the elements of the safe prefix;
 * bounded by that part's text, and released when the part stops streaming.
 */
export class IncrementalMarkdownCache {
  /**
   * @param configuration The plugins and components the elements were rendered
   *   with; a cache is only ever used with that one configuration.
   */
  constructor(readonly configuration?: unknown) {}

  private prefix = "";
  private prefixLines = 0;
  private blocks: ReactNode[] = [];
  private seenTags = new Map<string, number>();
  /** Characters actually rendered and renders reusing a prefix, for tests. */
  renderedCharacters = 0;
  reused = 0;

  reset(): void {
    this.prefix = "";
    this.prefixLines = 0;
    this.blocks = [];
    this.seenTags = new Map();
  }

  /** The top-level nodes for `document`, rendering only what the cache does not hold. */
  render(
    document: string,
    renderRange: (range: MarkdownRange) => readonly ReactNode[],
  ): ReactNode[] {
    if (!document.startsWith(this.prefix) || DOCUMENT_WIDE.test(document)) this.reset();
    const boundary = lastSafeBoundary(document);
    if (boundary > this.prefix.length) {
      // Extend the cache by the newly completed segment, rendered on its own.
      const range = { start: this.prefix.length, end: boundary, lines: this.prefixLines };
      this.blocks = appendBlocks(
        this.blocks,
        continueKeys(renderRange(range), this.seenTags, true),
      );
      this.renderedCharacters += boundary - range.start;
      this.prefix = document.slice(0, boundary);
      this.prefixLines += countLines(document.slice(range.start, boundary));
    } else if (boundary < this.prefix.length) {
      // The prefix is no longer a safe split of this document.
      this.reset();
    }
    const tail = { start: this.prefix.length, end: document.length, lines: this.prefixLines };
    this.renderedCharacters += tail.end - tail.start;
    if (tail.start === 0) return [...renderRange(tail)];
    this.reused += 1;
    return appendBlocks(this.blocks, continueKeys(renderRange(tail), this.seenTags, false));
  }
}

/**
 * Makes the processor parse only `range` of its document. Must follow
 * `remark-parse` (react-markdown adds it first): the parse configuration —
 * micromark and mdast extensions registered by later plugins such as GFM —
 * is still read by the original parser at call time.
 */
export function remarkParseRange(this: Processor, range: MarkdownRange): void {
  const original = this.parser;
  if (!original) return;
  this.parser = ((document: string, file: Parameters<typeof original>[1]) => {
    const tree = original(String(document).slice(range.start, range.end), file) as unknown as Root;
    for (const child of tree.children) shift(child, range.lines, range.start);
    return tree;
  }) as never;
}

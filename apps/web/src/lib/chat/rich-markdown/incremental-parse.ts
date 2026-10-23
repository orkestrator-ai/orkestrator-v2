/**
 * Completed-prefix reuse for streaming Markdown.
 *
 * A streaming answer re-renders up to 20 times a second
 * (`MARKDOWN_POLICY.maxStreamingUpdatesPerSecond`), and a full parse of a long
 * answer costs tens of milliseconds, growing with its length. Everything
 * before the last block boundary that is proven safe cannot change while text
 * is appended after it, so its syntax tree is parsed once and reused; only the
 * tail is parsed again.
 *
 * Correctness comes first and is conservative:
 *
 * - A boundary is the start of a line that follows a blank line, outside any
 *   fenced code, whose first character cannot continue or join the block
 *   before it (no indentation, list marker, block quote, table row, HTML or
 *   bracket). Splitting there and parsing both sides gives the same tree as
 *   parsing the whole, which the equivalence tests check for every prefix of
 *   their fixtures.
 * - Constructs with document-wide meaning disable reuse for the whole text:
 *   link reference definitions and footnotes, raw HTML blocks (including the
 *   custom disclosures), and carriage returns.
 * - Reuse requires the new text to extend the cached prefix exactly; any
 *   other change resets the cache.
 * - Positions (line, column, offset) are shifted into document coordinates,
 *   so block identities derived from source offsets are unchanged.
 * - The cached nodes stay pristine: every parse hands out a deep copy, because
 *   later transforms mutate their input.
 *
 * Only the parse step is replaced. Every remark/rehype transform, the URL
 * policy and sanitisation still run over the whole tree, exactly as before.
 */
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
const DOCUMENT_WIDE = /^ {0,3}\[[^\]\n]+\]:|\[\^|^ {0,3}<|\r/m;

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

type Parse = (document: string) => Root;

/**
 * Per text part, owned by its renderer. Holds the parsed nodes of the safe
 * prefix in document coordinates; bounded by that part's text.
 */
export class IncrementalMarkdownCache {
  /**
   * @param configuration The plugin configuration the cached trees were
   *   parsed under; a cache is only ever used with that one configuration.
   */
  constructor(readonly configuration?: unknown) {}

  private prefix = "";
  private prefixLines = 0;
  private children: MdNode[] = [];
  /** Parses served and the characters actually parsed, for tests and diagnostics. */
  parses = 0;
  parsedCharacters = 0;
  reused = 0;

  reset(): void {
    this.prefix = "";
    this.prefixLines = 0;
    this.children = [];
  }

  /** The tree for `document`, parsing only what the cache does not hold. */
  parse(document: string, parseSegment: Parse): Root {
    this.parses += 1;
    if (!document.startsWith(this.prefix) || DOCUMENT_WIDE.test(document)) this.reset();
    const boundary = lastSafeBoundary(document);
    if (boundary > this.prefix.length) {
      // Extend the cache by the newly completed segment, parsed on its own.
      const segment = document.slice(this.prefix.length, boundary);
      const tree = parseSegment(segment);
      this.parsedCharacters += segment.length;
      for (const child of tree.children) shift(child, this.prefixLines, this.prefix.length);
      this.children.push(...tree.children);
      this.prefix = document.slice(0, boundary);
      this.prefixLines += countLines(segment);
    } else if (boundary < this.prefix.length) {
      // The prefix is no longer a safe split of this document.
      this.reset();
    }
    if (this.prefix.length === 0) {
      this.parsedCharacters += document.length;
      return parseSegment(document);
    }
    this.reused += 1;
    const tailText = document.slice(this.prefix.length);
    const tail = parseSegment(tailText);
    this.parsedCharacters += tailText.length;
    for (const child of tail.children) shift(child, this.prefixLines, this.prefix.length);
    const children = [...structuredClone(this.children), ...tail.children];
    const end = tail.position?.end;
    return {
      type: "root",
      children,
      position: {
        start: { line: 1, column: 1, offset: 0 },
        end: end
          ? {
              line: end.line + this.prefixLines,
              column: end.column,
              offset: (end.offset ?? 0) + this.prefix.length,
            }
          : { line: this.prefixLines + 1, column: 1, offset: this.prefix.length },
      },
    };
  }
}

/**
 * Replaces the processor's parser with one that serves `cache`. Must follow
 * `remark-parse` (react-markdown adds it first): the parse configuration —
 * micromark and mdast extensions registered by later plugins such as GFM —
 * is still read by the original parser at call time.
 */
export function remarkIncrementalParse(this: Processor, cache: IncrementalMarkdownCache): void {
  const original = this.parser;
  if (!original) return;
  this.parser = ((document: string, file: Parameters<typeof original>[1]) =>
    cache.parse(
      String(document),
      (segment) => original(segment, file) as unknown as Root,
    )) as never;
}

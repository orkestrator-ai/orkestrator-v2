/**
 * Controlled `<details>` disclosure syntax for transcript Markdown.
 *
 * Broad raw HTML stays off. Instead, a bounded micromark flow construct claims
 * only *candidate delimiter lines* — an own line that starts with `<details`,
 * `</details` or `<summary` followed by `>`, `/`, whitespace or the end of the
 * line — and the mdast extension turns each into a `richDisclosureLine` node.
 * Pairing those lines into disclosures happens afterwards, as an AST transform
 * over sibling nodes (`pairDisclosures` in `remark-rich-markdown.ts`), which is
 * what makes recognition transactional:
 *
 *  - the body between an opener and its closer is ordinary flow content of the
 *    same document, so reference definitions and footnotes resolve across the
 *    boundary and every source offset points into the original text;
 *  - an opener and closer pair only when they are siblings, i.e. at the same
 *    container depth;
 *  - a malformed, unbalanced or over-depth candidate costs exactly its own line,
 *    which is rendered as inert literal text. Unlike the CommonMark raw-HTML
 *    block (`<details>` is an HTML block name), it can never swallow the lines
 *    that follow it;
 *  - fenced and indented code consume their lines before flow constructs run,
 *    and an escaped `\<details>` is not a flow line at all, so delimiter-like
 *    text there stays text.
 *
 * Only the exact lowercase forms below are valid. Attributes (including
 * `open`), styles, handlers, other tag variants or trailing text make a line a
 * candidate that is shown literally.
 */

/** Character code as micromark passes it: a char code, a negative virtual code, or EOF. */
type Code = number | null;
type State = (code: Code) => State | undefined;

interface Effects {
  consume: (code: Code) => undefined;
  enter: (type: string) => unknown;
  exit: (type: string) => unknown;
}

interface Construct {
  name: string;
  tokenize: (this: unknown, effects: Effects, ok: State, nok: State) => State;
  add?: "before" | "after";
}

interface MicromarkToken {
  type: string;
}

interface CompileContext {
  enter: (node: RichDisclosureLineNode, token: MicromarkToken) => unknown;
  exit: (token: MicromarkToken) => unknown;
  sliceSerialize: (token: MicromarkToken) => string;
  stack: unknown[];
}

export const DISCLOSURE_LINE_TOKEN = "richDisclosureLine";
export const DISCLOSURE_LINE_NODE = "richDisclosureLine";

export interface RichDisclosureLineNode {
  type: typeof DISCLOSURE_LINE_NODE;
  /** The candidate line exactly as written, without leading indentation or line ending. */
  value: string;
  position?: unknown;
}

const LESS_THAN = 60;
const GREATER_THAN = 62;
const SLASH = 47;
const SPACE = 32;
const TAB = -2;
const VIRTUAL_SPACE = -1;
const CARRIAGE_RETURN = -5;
const LINE_FEED = -4;
const CARRIAGE_RETURN_LINE_FEED = -3;
const MAX_TAG_NAME = 7;

function isLineEnd(code: Code): boolean {
  return (
    code === null ||
    code === CARRIAGE_RETURN ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN_LINE_FEED
  );
}

function isAsciiAlpha(code: Code): code is number {
  return code !== null && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122));
}

function tokenizeDisclosureLine(effects: Effects, ok: State, nok: State): State {
  let name = "";

  const rest: State = (code) => {
    if (isLineEnd(code)) {
      effects.exit(DISCLOSURE_LINE_TOKEN);
      return ok(code);
    }
    effects.consume(code);
    return rest;
  };

  const tagName: State = (code) => {
    if (isAsciiAlpha(code)) {
      if (name.length >= MAX_TAG_NAME) return nok(code);
      name += String.fromCharCode(code).toLowerCase();
      effects.consume(code);
      return tagName;
    }
    if (name !== "details" && name !== "summary") return nok(code);
    if (
      code === GREATER_THAN ||
      code === SLASH ||
      code === SPACE ||
      code === TAB ||
      code === VIRTUAL_SPACE ||
      isLineEnd(code)
    ) {
      return rest(code);
    }
    return nok(code);
  };

  const afterLessThan: State = (code) => {
    if (code === SLASH) {
      effects.consume(code);
      return tagName;
    }
    return tagName(code);
  };

  return (code) => {
    if (code !== LESS_THAN) return nok(code);
    effects.enter(DISCLOSURE_LINE_TOKEN);
    effects.consume(code);
    return afterLessThan;
  };
}

const disclosureLineConstruct: Construct = {
  name: "richDisclosureLine",
  tokenize: tokenizeDisclosureLine,
  // Ahead of CommonMark's raw-HTML block, which would otherwise claim the line
  // and everything after it up to the next blank line.
  add: "before",
};

/** micromark syntax extension: candidate delimiter lines in flow position. */
export const disclosureMicromarkExtension = {
  flow: { [LESS_THAN]: [disclosureLineConstruct] },
};

/** mdast-util-from-markdown extension producing `richDisclosureLine` nodes. */
export const disclosureFromMarkdownExtension = {
  enter: {
    [DISCLOSURE_LINE_TOKEN](this: CompileContext, token: MicromarkToken) {
      this.enter({ type: DISCLOSURE_LINE_NODE, value: "" }, token);
    },
  },
  exit: {
    [DISCLOSURE_LINE_TOKEN](this: CompileContext, token: MicromarkToken) {
      const node = this.stack[this.stack.length - 1] as RichDisclosureLineNode;
      node.value = this.sliceSerialize(token);
      this.exit(token);
    },
  },
};

export type DisclosureLineKind =
  { kind: "open" } | { kind: "close" } | { kind: "summary"; summary: string } | { kind: "literal" };

const OPEN_LINE = /^<details>[\t ]*$/;
const CLOSE_LINE = /^<\/details>[\t ]*$/;
const SUMMARY_LINE = /^<summary>(.*)<\/summary>[\t ]*$/;

/** Classify one candidate line. Anything but the three exact forms is literal. */
export function classifyDisclosureLine(value: string): DisclosureLineKind {
  if (OPEN_LINE.test(value)) return { kind: "open" };
  if (CLOSE_LINE.test(value)) return { kind: "close" };
  const summary = SUMMARY_LINE.exec(value);
  if (summary) {
    const text = summary[1]!;
    // One summary element per line; a nested or repeated tag is not the grammar.
    if (!/<\/?summary\b/i.test(text)) return { kind: "summary", summary: text.trim() };
  }
  return { kind: "literal" };
}

/**
 * Splits a Key information prose section (summary, problem, context,
 * solution) into paragraphs and lists, so a long brief does not read as one
 * wall of text.
 *
 * The agent's own structure wins: a blank line starts a new paragraph, and
 * lines starting `- `, `* `, `• `, `1. ` or `1) ` form a list. Text written
 * as a single unbroken run, which is what briefs recorded before agents were
 * asked for paragraphs look like, is regrouped into paragraphs of a few
 * sentences once it is long enough to need it.
 */

export type KeyInformationBlock =
  { kind: "paragraph"; text: string } | { kind: "list"; ordered: boolean; items: string[] };

const LIST_ITEM = /^(\s*)(?:([-*•])|(\d{1,3})[.)])\s+(\S.*)$/;

/** A single-run text at least this long is regrouped by sentence. */
export const REGROUP_MIN_LENGTH = 480;
/** A regrouped paragraph closes once it reaches this many characters. */
const PARAGRAPH_TARGET_LENGTH = 300;
/** A last paragraph shorter than this joins the one before it. */
const PARAGRAPH_MIN_LENGTH = 120;

/**
 * Words whose trailing full stop does not end a sentence. Matched without the
 * stop and case-insensitively.
 */
const ABBREVIATIONS = new Set(["e.g", "i.e", "etc", "vs", "cf", "approx", "incl"]);

export function keyInformationBlocks(text: string): KeyInformationBlock[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  if (!normalized.includes("\n")) {
    return regroupSentences(normalized).map((paragraph) => ({
      kind: "paragraph",
      text: paragraph,
    }));
  }

  const blocks: KeyInformationBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;

  const closeParagraph = () => {
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
    paragraph = [];
  };
  const closeList = () => {
    if (list) blocks.push({ kind: "list", ...list });
    list = undefined;
  };

  for (const line of normalized.split("\n")) {
    if (!line.trim()) {
      closeParagraph();
      closeList();
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      closeParagraph();
      const ordered = item[3] !== undefined;
      if (list && list.ordered !== ordered) closeList();
      list ??= { ordered, items: [] };
      list.items.push((item[4] ?? "").trim());
      continue;
    }
    // An indented line under a list item continues that item.
    if (list && /^\s/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    closeList();
    paragraph.push(line.trimEnd());
  }
  closeParagraph();
  closeList();
  return blocks;
}

/**
 * Regroups one long run of text into paragraphs of whole sentences. Short
 * text, and text with too few sentences to split, comes back unchanged.
 */
export function regroupSentences(text: string): string[] {
  if (text.length < REGROUP_MIN_LENGTH) return [text];
  const sentences = splitSentences(text);
  if (sentences.length < 3) return [text];

  const paragraphs: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    current = current ? `${current} ${sentence}` : sentence;
    if (current.length >= PARAGRAPH_TARGET_LENGTH) {
      paragraphs.push(current);
      current = "";
    }
  }
  if (current) {
    if (paragraphs.length > 0 && current.length < PARAGRAPH_MIN_LENGTH) {
      paragraphs[paragraphs.length - 1] += ` ${current}`;
    } else {
      paragraphs.push(current);
    }
  }
  return paragraphs;
}

/**
 * Sentence boundaries: `.`, `!` or `?`, optionally followed by a closing
 * quote or bracket, then whitespace and a capital letter, digit or opening
 * quote or bracket. A full stop inside a word (`v1.2`, `a.ts`) is never a
 * boundary because no whitespace follows it.
 */
function splitSentences(text: string): string[] {
  const boundary = /[.!?]["')\]]*\s+(?=["'([]?[A-Z0-9])/g;
  const sentences: string[] = [];
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const end = match.index + match[0].trimEnd().length;
    if (match[0].startsWith(".") && endsWithAbbreviation(text.slice(start, match.index))) continue;
    sentences.push(text.slice(start, end));
    start = match.index + match[0].length;
  }
  sentences.push(text.slice(start));
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
}

function endsWithAbbreviation(textBeforeStop: string): boolean {
  const word = /(\S+)$/.exec(textBeforeStop)?.[1] ?? "";
  return ABBREVIATIONS.has(word.replace(/^[("'[]+/, "").toLowerCase());
}

import type { ReactNode } from "react";
import { firstSegmentIsHost } from "@/lib/chat/inline-file-reference";

/**
 * The transcript's inline-code chip (`MessageMarkdown`), so a path or command
 * reads the same in the Key information panel as in the conversation.
 */
export const KEY_INFORMATION_CODE_CLASS =
  "rounded-md bg-primary/12 px-1.5 py-0.5 font-mono text-xs text-blue-300 [overflow-wrap:anywhere] box-decoration-clone";

/** Extensions that make a bare `name.ext` a file name rather than prose. */
const FILE_EXTENSIONS = new Set([
  "c",
  "cjs",
  "css",
  "go",
  "h",
  "html",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "lock",
  "md",
  "mdx",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "swift",
  "toml",
  "ts",
  "tsx",
  "txt",
  "yaml",
  "yml",
  "zsh",
]);

const PRODUCT_NAMES = new Set(["Node.js", "Next.js"]);
const LOCATION_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$/;

const LEADING_PUNCTUATION = /^[("'[]+/;
const TRAILING_PUNCTUATION = /[)"'\].,;:!?]+$/;

/**
 * Whether a bare word is a file path the transcript would have shown as code:
 * a home-relative path (`~/.agents/skills`), or a path whose last segment has
 * a known source extension (`apps/web/src/a.tsx`, `SKILL.md`). Words with a
 * slash but no such extension (`and/or`, `/home/node`) stay prose, because
 * the brief is free text and a wrong guess is worse than a missed one.
 */
export function isBarePathToken(word: string): boolean {
  word = word.replace(LOCATION_SUFFIX, "");
  if (word.length < 3 || word.includes("://") || firstSegmentIsHost(word)) return false;
  if (/^~\/\S/.test(word)) return true;
  const name = word.split("/").pop() ?? "";
  // Product names (`Node.js`, `Next.js`) are prose, not files.
  if (name === word && PRODUCT_NAMES.has(name)) return false;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return FILE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

type Segment = { kind: "text" | "code"; value: string };

/**
 * Splits brief text into prose and code: backtick spans (the agent's own
 * Markdown) and bare file paths. Punctuation around a bare path stays prose.
 */
export function keyInformationSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const push = (kind: Segment["kind"], value: string) => {
    if (!value) return;
    const last = segments.at(-1);
    if (kind === "text" && last?.kind === "text") last.value += value;
    else segments.push({ kind, value });
  };
  const pattern = /`([^`\n]+)`|[^`\s]+|`/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    push("text", text.slice(index, match.index));
    index = match.index + match[0].length;
    if (match[1] !== undefined) {
      push("code", match[1]);
      continue;
    }
    const word = match[0];
    const leading = LEADING_PUNCTUATION.exec(word)?.[0] ?? "";
    const rest = word.slice(leading.length);
    const trailing = TRAILING_PUNCTUATION.exec(rest)?.[0] ?? "";
    const citation = rest.slice(0, rest.length - trailing.length);
    const location = LOCATION_SUFFIX.exec(citation)?.[0] ?? "";
    const core = citation.slice(0, citation.length - location.length);
    if (!isBarePathToken(core)) {
      push("text", word);
      continue;
    }
    push("text", leading);
    push("code", core);
    push("text", location + trailing);
  }
  push("text", text.slice(index));
  return segments;
}

/** A span of brief text after inline Markdown: code, prose, or emphasis around more spans. */
export type KeyInformationInline =
  Segment | { kind: "strong" | "em" | "strike"; children: KeyInformationInline[] };

/**
 * A delimiter opens only at the start, after whitespace or after opening
 * punctuation, and closes only before the end, whitespace or punctuation.
 * That is stricter than CommonMark, so globs (`src/**`), arithmetic
 * (`2 * 3 * 4`, `2**10`) and identifiers (`snake_case_name`) stay prose.
 */
const OPEN = String.raw`(?<=^|[\s(\[{"'])`;
const CLOSE = String.raw`(?=$|[\s)\]}"'.,;:!?/-])`;

/**
 * The inline Markdown agents write in a brief, leftmost first. A code span
 * wins over emphasis, as in CommonMark, so `` `**x**` `` stays literal.
 * Groups: 1 code, 2 `**strong**`, 3 `__strong__`, 4 `*em*`, 5 `_em_`,
 * 6 `~~strike~~`.
 */
const INLINE_MARKDOWN = new RegExp(
  [
    "`([^`\\n]+)`",
    String.raw`${OPEN}\*\*(?=[^\s*])([^\n]*?[^\s*\\])\*\*${CLOSE}`,
    String.raw`${OPEN}__(?=[^\s_])([^\n]*?[^\s_\\])__${CLOSE}`,
    String.raw`${OPEN}\*(?=[^\s*])([^\n*]*?[^\s*\\])\*${CLOSE}`,
    String.raw`${OPEN}_(?=[^\s_])([^\n_]*?[^\s_\\])_${CLOSE}`,
    String.raw`${OPEN}~~(?=\S)([^\n]*?\S)~~${CLOSE}`,
  ].join("|"),
  "g",
);

/**
 * Splits brief text into the inline Markdown it uses: code spans, bold,
 * italic and strikethrough, nested as written. Prose between them goes
 * through {@link keyInformationSegments}, so bare file paths are still shown
 * as code.
 */
export function keyInformationInline(text: string): KeyInformationInline[] {
  const nodes: KeyInformationInline[] = [];
  const push = (node: KeyInformationInline) => {
    const last = nodes.at(-1);
    if (node.kind === "text" && last?.kind === "text") last.value += node.value;
    else nodes.push(node);
  };
  const pushProse = (value: string) => {
    for (const segment of keyInformationSegments(value)) push(segment);
  };
  let index = 0;
  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    pushProse(text.slice(index, match.index));
    index = match.index + match[0].length;
    const [, code, strong, underscoreStrong, em, underscoreEm, strike] = match;
    if (code !== undefined) push({ kind: "code", value: code });
    else if (strong !== undefined || underscoreStrong !== undefined) {
      push({ kind: "strong", children: keyInformationInline(strong ?? underscoreStrong ?? "") });
    } else if (em !== undefined || underscoreEm !== undefined) {
      push({ kind: "em", children: keyInformationInline(em ?? underscoreEm ?? "") });
    } else {
      push({ kind: "strike", children: keyInformationInline(strike ?? "") });
    }
  }
  pushProse(text.slice(index));
  return nodes;
}

function renderInline(nodes: KeyInformationInline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return node.value;
      case "code":
        return (
          <code key={index} className={KEY_INFORMATION_CODE_CLASS}>
            {node.value}
          </code>
        );
      case "strong":
        return (
          <strong key={index} className="font-semibold text-foreground">
            {renderInline(node.children)}
          </strong>
        );
      case "em":
        return <em key={index}>{renderInline(node.children)}</em>;
      case "strike":
        return <del key={index}>{renderInline(node.children)}</del>;
    }
  });
}

/**
 * Brief text with its inline Markdown rendered (code, bold, italic,
 * strikethrough) and bare file paths highlighted, as in the transcript.
 */
export function KeyInformationText({ text }: { text: string }): ReactNode {
  return renderInline(keyInformationInline(text));
}

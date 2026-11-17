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
 * Scan code and path tokens before delimiter runs. A stack lets adjacent runs
 * close nested emphasis without ever interpreting the contents of a code chip.
 * Word-boundary guards deliberately keep arithmetic and identifiers literal.
 */
export function keyInformationInline(text: string): KeyInformationInline[] {
  type Frame = {
    marker: string;
    kind: "strong" | "em" | "strike";
    children: KeyInformationInline[];
  };
  const root: KeyInformationInline[] = [];
  const stack: Frame[] = [];
  const children = () => stack.at(-1)?.children ?? root;
  const push = (node: KeyInformationInline) => {
    const target = children();
    const last = target.at(-1);
    if (node.kind === "text" && last?.kind === "text") last.value += node.value;
    else target.push(node);
  };
  const prose = (value: string) => {
    for (const node of keyInformationSegments(value)) push(node);
  };
  const unwind = () => {
    while (stack.length) {
      const frame = stack.pop()!;
      push({ kind: "text", value: frame.marker });
      for (const node of frame.children) push(node);
    }
  };
  // Path candidates include surrounding punctuation, just as the legacy chip
  // renderer does. Formatting-wrapped paths do not pass isBarePathToken.
  const tokens = /`[^`\n]+`|[^\s`]+|\s+|`/g;
  for (const token of text.matchAll(tokens)) {
    const word = token[0];
    if (word.startsWith("`") && word.length > 1 && word.endsWith("`")) {
      push({ kind: "code", value: word.slice(1, -1) });
      continue;
    }
    const segments = keyInformationSegments(word);
    if (segments.some((node) => node.kind === "code")) {
      for (const node of segments) push(node);
      continue;
    }
    let start = 0;
    for (const run of word.matchAll(/\*+|_+|~{2,}|\n/g)) {
      prose(word.slice(start, run.index));
      start = run.index + run[0].length;
      const marker = run[0];
      if (marker === "\n") {
        unwind();
        push({ kind: "text", value: marker });
        continue;
      }
      const position = token.index + run.index;
      const before = text[position - 1] ?? "";
      const after = text[position + marker.length] ?? "";
      let remaining = marker.length;
      const canClose =
        before !== "" &&
        !/[\s\\]/.test(before) &&
        (after === "" || /[\s)\]}"'.,;:!?/-]/.test(after));
      if (canClose) {
        while (remaining && stack.at(-1)?.marker[0] === marker[0]) {
          const frame = stack.at(-1)!;
          if (frame.marker.length > remaining) break;
          stack.pop();
          remaining -= frame.marker.length;
          push({ kind: frame.kind, children: frame.children });
        }
      }
      const canOpen =
        (before === "" || /[\s([{"']/.test(before)) && after !== "" && !/\s/.test(after);
      if (remaining && canOpen && stack.length < 64) {
        while (remaining) {
          const width = remaining >= 2 ? 2 : 1;
          if (marker[0] === "~" && width === 1) break;
          stack.push({
            marker: marker[0]!.repeat(width),
            kind: marker[0] === "~" ? "strike" : width === 2 ? "strong" : "em",
            children: [],
          });
          remaining -= width;
          if (stack.length >= 64) break;
        }
      }
      if (remaining) push({ kind: "text", value: marker[0]!.repeat(remaining) });
    }
    prose(word.slice(start));
  }
  unwind();
  return root;
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

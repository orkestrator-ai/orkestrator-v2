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

/** Brief text with code and file paths highlighted as in the transcript. */
export function KeyInformationText({ text }: { text: string }): ReactNode {
  return keyInformationSegments(text).map((segment, index) =>
    segment.kind === "code" ? (
      <code key={index} className={KEY_INFORMATION_CODE_CLASS}>
        {segment.value}
      </code>
    ) : (
      segment.value
    ),
  );
}

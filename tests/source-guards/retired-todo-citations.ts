import type { SourceIndex } from "./repository-index";

/**
 * Citations of retired to-dos in source comments (to-do 7571 task 10, retired).
 * A to-do file is deleted when its last task is done, so a comment that still
 * cites it by number sends the reader to a file that no longer exists.
 * The root `AGENTS.md` ("Keep references current") asks every change that
 * retires a file to repoint its references; this guard catches the ones in
 * code, which no link checker reads.
 *
 * A citation is `to-do NNNN`, `todo NNNN` or `to-dos NNNN` (any case). Plural
 * citations can list numbers separated by commas, `and` or `or`. Each number is
 * current when `docs/todo/<area>/NNNN-*.md` exists, and acceptable when the
 * word `retired` sits right before or after it (`to-do 0019 (retired) task 5`,
 * `retired to-do 1250`), the form `docs/README.md` ("Maintaining the folders")
 * gives. Otherwise point it at the pull request that did the work (`#2149`),
 * or mark it retired.
 */

/** Text files a comment can cite a to-do from; Markdown is the link checker's. */
const SCANNED_FILE =
  /(?:\.(?:ts|tsx|js|mjs|cjs|sh|zsh|ya?ml|toml|pl|py|swift|css|html|svg)|(?:^|\/)Dockerfile[^/]*)$/;

/** Documentation, plans, generated protocol and build output: not source comments. */
export const IGNORED: readonly string[] = [
  "docs/**",
  "plans/**",
  "**/generated/**",
  "test-fixtures/**",
  "output/**",
  "binaries/**",
];

/**
 * Files whose to-do numbers are data, not citations. Each needs its reason.
 * - `KeyInformationTabFixture.tsx` renders a sample pipeline brief whose text
 *   names a to-do; it is display text for a screenshot fixture.
 * - `retired-todo-citations.test.ts` plants offenders to prove this guard.
 */
export const DATA_FILES: readonly string[] = [
  "e2e/fixture/KeyInformationTabFixture.tsx",
  "tests/unit/retired-todo-citations.test.ts",
];

const LIVE_TODO_FILE = /^docs\/todo\/[^/]+\/(\d{4})-[^/]*\.md$/;
const CITATION =
  /\b(?:to-?dos[ :#]*\d{4}\b(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)\d{4}\b)*|to-?do[ :#]*\d{4}\b)/gi;
/** How far from the number the word `retired` may sit and still mark it. */
const MARK_WINDOW = 24;

export interface RetiredTodoCitation {
  file: string;
  line: number;
  number: string;
  text: string;
}

/** Numbers with a readable to-do file in the working tree. */
export function liveTodoNumbers(index: SourceIndex): Set<string> {
  const numbers = new Set<string>();
  for (const file of index.files) {
    const match = LIVE_TODO_FILE.exec(file);
    if (match && index.read(file) !== null) numbers.add(match[1]!);
  }
  return numbers;
}

/** Every unmarked citation of a to-do number with no file under `docs/todo/`. */
export function findRetiredTodoCitations(index: SourceIndex): RetiredTodoCitation[] {
  const live = liveTodoNumbers(index);
  const skipped = [...IGNORED, ...DATA_FILES].map((glob) => new Bun.Glob(glob));
  const findings: RetiredTodoCitation[] = [];
  for (const file of index.files) {
    if (!SCANNED_FILE.test(file) || skipped.some((glob) => glob.match(file))) continue;
    const text = index.read(file);
    if (text === null || !/to-?do/i.test(text)) continue;
    const lines = text.split("\n");
    lines.forEach((lineText, lineIndex) => {
      for (const match of lineText.matchAll(CITATION)) {
        const start = match.index;
        const end = start + match[0].length;
        const around = (
          lineText.slice(Math.max(0, start - MARK_WINDOW), start) +
          " " +
          lineText.slice(end, end + MARK_WINDOW)
        ).toLowerCase();
        if (around.includes("retired")) continue;
        for (const numberMatch of match[0].matchAll(/\b\d{4}\b/g)) {
          const number = numberMatch[0];
          if (!live.has(number)) {
            findings.push({ file, line: lineIndex + 1, number, text: match[0] });
          }
        }
      }
    });
  }
  return findings;
}

/** One problem line per citation, for the guard stage. */
export function checkRetiredTodoCitations(index: SourceIndex): string[] {
  return findRetiredTodoCitations(index).map(
    (finding) =>
      `${finding.file}:${finding.line} cites "${finding.text}", which has no file under docs/todo/`,
  );
}

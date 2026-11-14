import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Reads the review fan-out's `build-pipeline` `review.prompt-reads` debug
 * lines (BG-11's live count, to-do 7566 (retired)) out of a profile's logs for
 * `auto-pipeline-live.spec.ts`. Kept apart from the spec so its parsing is
 * unit-tested against the logger's real text and JSON renderings
 * (`auto-pipeline-prompt-reads.test.ts`).
 */
export type PromptReads = { prompts: number; instructionReads: number; notesReads: number };

/**
 * Matches the text rendering (`prompts=4`) and the JSON one (`"prompts":4`),
 * whatever prefix the writing process put before it.
 */
const PROMPT_READS_LINE =
  /review\.prompt-reads\b.*?prompts\W{1,3}(\d+).*?instructionReads\W{1,3}(\d+).*?notesReads\W{1,3}(\d+)/;

/** One log line's counts, or null when the line is not a prompt-reads line. */
export function parsePromptReadsLine(line: string): PromptReads | null {
  const match = PROMPT_READS_LINE.exec(line);
  if (!match) return null;
  return {
    prompts: Number(match[1]),
    instructionReads: Number(match[2]),
    notesReads: Number(match[3]),
  };
}

/** Every prompt-reads line in one log's text, in order. */
export function promptReadsInText(text: string): PromptReads[] {
  const passes: PromptReads[] = [];
  for (const line of text.split("\n")) {
    const reads = parsePromptReadsLine(line);
    if (reads) passes.push(reads);
  }
  return passes;
}

/**
 * Every prompt-reads line in the profile's logs, one per review pass that
 * built or tried to build prompts. The relay copies a backend record into more
 * than one file, so the file holding the most lines is the one counted rather
 * than the sum; on a tie the first file in name order wins.
 */
export function promptReadsFromLogs(logDir: string): {
  file: string | null;
  passes: PromptReads[];
} {
  let best: { file: string | null; passes: PromptReads[] } = { file: null, passes: [] };
  for (const name of readdirSync(logDir).sort()) {
    if (!name.endsWith(".log")) continue;
    const passes = promptReadsInText(readFileSync(path.join(logDir, name), "utf8"));
    if (passes.length > best.passes.length) best = { file: name, passes };
  }
  return best;
}

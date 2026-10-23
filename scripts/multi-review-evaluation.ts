import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MULTI_REVIEW_REPORTS_FRAME_CLOSE,
  MULTI_REVIEW_REPORTS_FRAME_OPEN,
} from "../packages/protocol/src/review-evidence-frames";
import type { StructuredReviewReport } from "../packages/protocol/src/structured-review";
import { evaluationCorpus } from "../apps/backend/src/core/multi-review-evaluation-corpus";
import {
  evaluationConsolidationPrompt,
  referenceConsolidation,
  scoreConsolidation,
  summarizePanelValue,
} from "../apps/backend/src/core/multi-review-evaluation";

/**
 * Multi Review panel-value evaluation.
 *
 *   bun scripts/multi-review-evaluation.ts prompts [--out <dir>]
 *     Writes every corpus case's full and compact consolidation prompt,
 *     `<case>.full.txt` and `<case>.compact.txt`, plus `<case>.reference.json`
 *     (default `output/multi-review-evaluation/`). Prints each prompt's size
 *     and the size of the framed evidence inside it.
 *
 *   bun scripts/multi-review-evaluation.ts score <case-id> <answer.json>
 *     Scores one consolidation answer (the report as the model returned it,
 *     with reviewSourceIds) against the case. Prints counts and flags only.
 *
 *   bun scripts/multi-review-evaluation.ts panel <record.json>...
 *     Reads exported Multi Review workflows (bare, or the stored record from
 *     `get_multi_review_workflow`) or Build Pipeline records, one or an array
 *     per file, and prints each panel's overlap counts and
 *     per-reviewer cache reads.
 *
 * The corpus is synthetic, so its prompts are safe to write. Keep model
 * answers and exported records out of the repository and CI logs; the
 * `score` and `panel` output holds no report text.
 */

const DEFAULT_OUT = "output/multi-review-evaluation";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function prompts(args: string[]): Promise<void> {
  const outIndex = args.indexOf("--out");
  const out = path.resolve(outIndex === -1 ? DEFAULT_OUT : (args[outIndex + 1] ?? DEFAULT_OUT));
  await mkdir(out, { recursive: true });
  const rows = [];
  for (const entry of evaluationCorpus()) {
    const row: Record<string, string | number> = { case: entry.id };
    for (const variant of ["full", "compact"] as const) {
      const prompt = evaluationConsolidationPrompt(entry, variant);
      await writeFile(path.join(out, `${entry.id}.${variant}.txt`), prompt);
      const evidence = prompt
        .split(MULTI_REVIEW_REPORTS_FRAME_OPEN)[1]!
        .split(MULTI_REVIEW_REPORTS_FRAME_CLOSE)[0]!;
      row[`${variant}Bytes`] = Buffer.byteLength(prompt, "utf8");
      row[`${variant}EvidenceBytes`] = Buffer.byteLength(evidence, "utf8");
    }
    const ratio = (compact: string, full: string) =>
      Number(((row[compact] as number) / (row[full] as number)).toFixed(3));
    row.reviewers = entry.reviewers.filter((reviewer) => reviewer.report).length;
    row.promptRatio = ratio("compactBytes", "fullBytes");
    row.evidenceRatio = ratio("compactEvidenceBytes", "fullEvidenceBytes");
    await writeFile(
      path.join(out, `${entry.id}.reference.json`),
      `${JSON.stringify(referenceConsolidation(entry), null, 2)}\n`,
    );
    rows.push(row);
  }
  console.table(rows);
  console.log(`Wrote ${rows.length * 3} files to ${out}`);
}

async function score(args: string[]): Promise<void> {
  const [caseId, answerPath] = args;
  if (!caseId || !answerPath) fail("Usage: score <case-id> <answer.json>");
  const entry = evaluationCorpus().find((candidate) => candidate.id === caseId);
  if (!entry) fail(`Unknown case ${JSON.stringify(caseId)}.`);
  const answer = JSON.parse(await readFile(answerPath, "utf8")) as StructuredReviewReport;
  console.log(JSON.stringify(scoreConsolidation(entry, answer), null, 2));
}

async function panel(args: string[]): Promise<void> {
  if (args.length === 0) fail("Usage: panel <record.json>...");
  const summaries = [];
  for (const file of args) {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      // `get_multi_review_workflow` wraps the workflow in its stored record.
      const snapshot = (record as { snapshot?: unknown } | null)?.snapshot;
      const workflow = typeof snapshot === "object" && snapshot !== null ? snapshot : record;
      summaries.push(...summarizePanelValue(workflow as never));
    }
  }
  console.log(JSON.stringify(summaries, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
if (command === "prompts") await prompts(rest);
else if (command === "score") await score(rest);
else if (command === "panel") await panel(rest);
else fail("Usage: bun scripts/multi-review-evaluation.ts prompts|score|panel ...");

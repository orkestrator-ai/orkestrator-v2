import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MULTI_REVIEW_REPORTS_FRAME_CLOSE,
  MULTI_REVIEW_REPORTS_FRAME_OPEN,
} from "../packages/protocol/src/review-evidence-frames";
import {
  safeParseStructuredReviewReport,
  type StructuredReviewReport,
} from "../packages/protocol/src/structured-review";
import { evaluationCorpus } from "../apps/backend/src/core/multi-review-evaluation-corpus";
import {
  evaluationConsolidationPrompt,
  referenceConsolidation,
  scoreConsolidation,
  summarizePanelValue,
} from "../apps/backend/src/core/multi-review-evaluation";
import {
  consolidationArgsProblem,
  DEFAULT_EVALUATION_MODEL,
  EVALUATION_EXECUTABLE_ENV,
  executableVersion,
  isEvaluationProvider,
  resolveEvaluationExecutable,
  runConsolidation,
} from "./multi-review-evaluation-drivers";

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
 *   bun scripts/multi-review-evaluation.ts live [--provider claude|codex] [--cases a,b]
 *       [--variants full,compact] [--samples <n>] [--model <alias>] [--bin <path>]
 *       [--out <dir>] [--cwd <empty-dir>]
 *     Sends each selected case's prompts to a CLI already signed in on this
 *     host, one tool-free, non-persistent turn per prompt with the report
 *     schema enforced (`multi-review-evaluation-drivers.ts` has each
 *     provider's flags): Claude (`claude -p`, default model `sonnet`) or Codex
 *     (`codex exec`, the CLI's default model unless `--model`). The executable
 *     is `--bin`, else `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH`, else the name on
 *     PATH. Saves each answer, `run.json` (provider, model, CLI version) and
 *     `scores.json` under `<out>/live/<provider>/`, and prints one
 *     content-free row per answer: the score, schema validity, and the
 *     provider's token and cache-read usage (Codex reports no cost or cache
 *     writes). It spends provider quota; keep the selection small.
 *     Each call runs in a fresh temporary directory unless `--cwd` names one
 *     shared directory. Claude's context names its working directory, so
 *     sharing one is what lets identical prompts share a cache prefix; the
 *     Codex driver leaves the environment context out of the prompt.
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

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function live(args: string[]): Promise<void> {
  const corpus = evaluationCorpus();
  const caseIds = option(args, "--cases")?.split(",") ?? corpus.map((entry) => entry.id);
  const variants = (option(args, "--variants")?.split(",") ?? ["full", "compact"]) as Array<
    "full" | "compact"
  >;
  const samples = Number(option(args, "--samples") ?? "1");
  const provider = option(args, "--provider") ?? "claude";
  if (!isEvaluationProvider(provider)) fail("--provider is claude or codex.");
  const model = option(args, "--model") ?? DEFAULT_EVALUATION_MODEL[provider];
  const executable = resolveEvaluationExecutable(
    option(args, "--bin") ?? process.env[EVALUATION_EXECUTABLE_ENV[provider]] ?? provider,
  );
  const out = path.resolve(option(args, "--out") ?? DEFAULT_OUT, "live", provider);
  const cwdOption = option(args, "--cwd");
  const fixedCwd = cwdOption === undefined ? undefined : path.resolve(cwdOption);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 5) fail("--samples is 1 to 5.");
  if (variants.some((variant) => variant !== "full" && variant !== "compact")) {
    fail("--variants takes full and/or compact.");
  }
  // Check every case before the first (billed) call.
  const entries = caseIds.map((caseId) => {
    const entry = corpus.find((candidate) => candidate.id === caseId);
    if (!entry) fail(`Unknown case ${JSON.stringify(caseId)}.`);
    return entry;
  });
  // The native CLI must accept the argument set before anything is billed.
  const argsProblem = await consolidationArgsProblem(provider, executable, { model });
  if (argsProblem) fail(`${provider} rejected the consolidation arguments (${argsProblem}).`);
  await mkdir(out, { recursive: true });
  const cliVersion = await executableVersion(executable);
  const run = { provider, model: model ?? "(CLI default)", cliVersion, startedAt: new Date() };
  await writeFile(path.join(out, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run));
  const rows = [];
  for (const entry of entries) {
    for (let sample = 1; sample <= samples; sample++) {
      for (const variant of variants) {
        const result = await runConsolidation({
          provider,
          executable,
          prompt: evaluationConsolidationPrompt(entry, variant),
          model,
          ...(fixedCwd ? { fixedCwd } : {}),
        });
        const answer = result.answer;
        await writeFile(
          path.join(out, `${entry.id}.${variant}.${sample}.answer.json`),
          `${JSON.stringify(answer ?? null, null, 2)}\n`,
        );
        const parsed = answer === undefined ? undefined : safeParseStructuredReviewReport(answer);
        const scored = parsed?.success ? scoreConsolidation(entry, parsed.data) : undefined;
        rows.push({
          provider,
          case: entry.id,
          variant,
          sample,
          ok: result.ok,
          ...(result.failure ? { failure: result.failure } : {}),
          schemaValid: parsed?.success === true,
          ...(scored
            ? {
                expected: scored.expectedFindings,
                actual: scored.actualFindings,
                recalled: scored.recalled,
                falseMerges: scored.falseMerges,
                splits: scored.splits,
                unexpected: scored.unexpected,
                dropped: scored.droppedSources,
                severity: `${scored.severityMatches}/${scored.recalledIssues}`,
                location: `${scored.locationMatches}/${scored.recalled}`,
                provenance: scored.provenanceValid,
                verdict: scored.verdictMatches,
              }
            : {}),
          inputTokens: result.inputTokens,
          cacheRead: result.cacheReadTokens,
          cacheWrite: result.cacheWriteTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
        });
        console.log(JSON.stringify(rows.at(-1)));
      }
    }
  }
  await writeFile(path.join(out, "scores.json"), `${JSON.stringify(rows, null, 2)}\n`);
  console.table(rows);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "prompts") await prompts(rest);
else if (command === "score") await score(rest);
else if (command === "panel") await panel(rest);
else if (command === "live") await live(rest);
else fail("Usage: bun scripts/multi-review-evaluation.ts prompts|score|panel|live ...");

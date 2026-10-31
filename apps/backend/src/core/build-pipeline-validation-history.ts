/**
 * Summaries of the validation runs earlier forward passes replaced.
 *
 * `BuildPipeline.validationRun` holds only the current pass's run. When a
 * failed Verify starts the next round, or a review retry prepares a new
 * package, the old run is dropped; its summary stays on the record so the
 * older Prepare node still shows what it checked. A rewind keeps the run it
 * invalidates on the rewind itself, so callers on that path do not archive.
 */
import {
  MAX_PIPELINE_VALIDATION_HISTORY,
  MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH,
  type BuildPipeline,
  type PipelineValidationSummary,
} from "@orkestrator/protocol/build-pipeline";
import type { ReviewValidationRun } from "@orkestrator/protocol/review-workflow";

function bounded(text: string): string {
  return text.length <= MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH
    ? text
    : `${text.slice(0, MAX_PIPELINE_VALIDATION_SUMMARY_TEXT_LENGTH - 1)}…`;
}

function isoDate(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** The bounded summary of `run`, or undefined when its start time is unusable. */
export function summarizeValidationRun(
  run: ReviewValidationRun,
  iteration: number,
  skipped: boolean,
): PipelineValidationSummary | undefined {
  const startedAt = isoDate(run.startedAt);
  if (!startedAt) return undefined;
  const completedAt = run.completedAt ? isoDate(run.completedAt) : undefined;
  const status = run.status === "planned" || run.status === "running" ? "cancelled" : run.status;
  return {
    runId: run.id,
    iteration,
    status,
    headRef: run.plan.headRef,
    startedAt,
    ...(completedAt ? { completedAt } : {}),
    ...(run.error ? { error: bounded(run.error) } : {}),
    ...(skipped ? { skipped: true } : {}),
    commands: run.results.map((result) => ({
      id: result.id,
      command: bounded(result.command),
      // A stopped run's unfinished commands never finished.
      status:
        status === "cancelled" &&
        (result.status === "pending" || result.status === "queued" || result.status === "running")
          ? "incomplete"
          : result.status,
      exitCode: result.exitCode,
      durationMs: Math.max(0, Math.round(result.durationMs)),
    })),
  };
}

/**
 * Moves the pipeline's current validation run into its history and clears it.
 * Pass `run` when the caller holds a fresher copy (a cancellation's result).
 */
export function archiveValidationRun(
  pipeline: Pick<
    BuildPipeline,
    "validationRun" | "validationHistory" | "iteration" | "skippedValidationRunId"
  >,
  run: ReviewValidationRun | undefined = pipeline.validationRun,
): void {
  delete pipeline.validationRun;
  if (!run) return;
  const summary = summarizeValidationRun(
    run,
    pipeline.iteration,
    pipeline.skippedValidationRunId === run.id,
  );
  if (!summary) return;
  const history = (pipeline.validationHistory ?? []).filter((entry) => entry.runId !== run.id);
  pipeline.validationHistory = [...history, summary].slice(-MAX_PIPELINE_VALIDATION_HISTORY);
}

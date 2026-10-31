import {
  isReviewPackagePreparationSession,
  isSupersededPipelineSession,
} from "@orkestrator/protocol/build-pipeline";
import type { BuildPipeline, PipelineSession } from "@/stores/buildPipelineStore";

export type PipelineStageItem =
  | { kind: "session"; id: string; key: string; session: PipelineSession }
  | { kind: "validation"; id: string; key: string };

export type ValidationRun = NonNullable<BuildPipeline["validationRun"]>;
export type ValidationSummary = NonNullable<BuildPipeline["validationHistory"]>[number];

/** Shown with an earlier pass's checks, whose output the record does not keep. */
export const ARCHIVED_VALIDATION_NOTE =
  "An earlier pass's run: its results are kept, its command output is not.";

/**
 * An earlier pass's validation summary as a read-only run, so its Prepare
 * node and Tests view render like the live one. Output paths are empty, so
 * nothing is fetched, and no result is running, so nothing can be stopped.
 */
export function validationRunFromSummary(summary: ValidationSummary): ValidationRun {
  return {
    id: summary.runId,
    plan: {
      headRef: summary.headRef,
      commands: summary.commands.map((command) => ({
        id: command.id,
        command: command.command,
        cwd: ".",
        dependsOn: [],
        resources: [],
        weight: 1,
        timeoutMs: 0,
      })),
      limitations: [ARCHIVED_VALIDATION_NOTE],
    },
    status: summary.status,
    startedAt: summary.startedAt,
    ...(summary.completedAt ? { completedAt: summary.completedAt } : {}),
    ...(summary.error ? { error: summary.error } : {}),
    results: summary.commands.map((command) => ({
      id: command.id,
      command: command.command,
      status: command.status,
      exitCode: command.exitCode,
      stdoutPath: null,
      stderrPath: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      durationMs: command.durationMs,
      limitation: null,
    })),
  };
}
export type ValidationOutcome = "running" | "failed" | "cancelled" | "incomplete" | "passed";

/**
 * Lifecycle `completed` means every command finished, not that they passed.
 * Failed is reserved for run-level faults (HEAD moved, runner died), so the
 * stage icon has to read the per-command results as well. Cancellation is a
 * distinct terminal state: the run stopped, it did not fail.
 */
export function validationOutcome(run: ValidationRun | undefined): ValidationOutcome {
  const status = run?.status;
  if (status === "planned" || status === "running") return "running";
  if (status === "cancelled") return "cancelled";
  if (status === "failed") return "failed";
  const results = run?.results ?? [];
  if (results.some((result) => result.status === "failed")) return "failed";
  if (results.some((result) => result.status === "incomplete")) return "incomplete";
  return "passed";
}

export function validationStageSummary(run: ValidationRun): string {
  if (run.status === "failed") {
    const error = run.error?.trim();
    return error && error.length > 0 ? error : "Validation failed";
  }
  if (run.status === "cancelled") {
    const error = run.error?.trim();
    return error && error.length > 0 ? error : "Validation cancelled";
  }
  const commandCount = run.plan.commands.length;
  const checkWord = commandCount === 1 ? "check" : "checks";
  const outcome = validationOutcome(run);
  if (outcome === "failed" && run.status === "completed") {
    const failed = run.results.filter((result) => result.status === "failed").length;
    return failed === commandCount
      ? `${failed} ${checkWord} failed`
      : `${failed} of ${commandCount} ${checkWord} failed`;
  }
  if (outcome === "incomplete") {
    const incomplete = run.results.filter((result) => result.status === "incomplete").length;
    return incomplete === commandCount
      ? `${incomplete} ${checkWord} incomplete`
      : `${incomplete} of ${commandCount} ${checkWord} incomplete`;
  }
  return `${commandCount} ${checkWord}`;
}

/**
 * Validation is backend-owned work rather than an agent session, but it is a
 * first-class pipeline stage to the reader. Insert it immediately after the
 * package-preparation turn that discovered the commands, leaving the review
 * sessions below it in their existing order.
 */
export function pipelineStageItems(pipeline: BuildPipeline): PipelineStageItem[] {
  const items: PipelineStageItem[] = pipeline.sessions.map((session) => ({
    kind: "session",
    id: session.sdkSessionId,
    key: session.sessionKey,
    session,
  }));
  if (!pipeline.validationRun) return items;

  const validationItem: PipelineStageItem = {
    kind: "validation",
    id: `validation:${pipeline.validationRun.id}`,
    key: `validation-${pipeline.validationRun.id}`,
  };
  let preparationIndex = -1;
  // The run belongs to the live round; a rewind's superseded preparation is history.
  for (let index = pipeline.sessions.length - 1; index >= 0; index -= 1) {
    const session = pipeline.sessions[index];
    if (
      isReviewPackagePreparationSession(session, pipeline) &&
      !isSupersededPipelineSession(session)
    ) {
      preparationIndex = index;
      break;
    }
  }
  if (preparationIndex >= 0) {
    items.splice(preparationIndex + 1, 0, validationItem);
    return items;
  }

  // Old persisted snapshots can have validation evidence without the labelled
  // preparation session. It still belongs before the first review it supplied.
  const firstReviewIndex = pipeline.sessions.findIndex(
    (session) => session.phase === "review" && !isSupersededPipelineSession(session),
  );
  items.splice(firstReviewIndex >= 0 ? firstReviewIndex : items.length, 0, validationItem);
  return items;
}

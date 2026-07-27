import type { StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import {
  parseStructuredReviewReport,
  type StructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type {
  BuildPipeline,
  PipelineSession,
} from "@/stores/buildPipelineStore";

export function structuredReviewHasFindings(report: StructuredReviewReport): boolean {
  return report.issues.length > 0 || report.testCoverageGaps.length > 0;
}

/**
 * Provider completion events and their durable structured payload can arrive a
 * few frames apart. Poll the authoritative result briefly; never inspect or
 * parse nearby transcript text.
 */
export async function readValidatedBuildReview(
  load: () => Promise<StructuredOutputResult<unknown> | null>,
  options: {
    attempts?: number;
    intervalMs?: number;
    allowLegacyTestResults?: boolean;
  } = {},
): Promise<StructuredReviewReport> {
  const attempts = options.attempts ?? 12;
  const intervalMs = options.intervalMs ?? 150;
  for (let index = 0; index < attempts; index += 1) {
    const result = await load();
    if (result) {
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return parseStructuredReviewReport(result.value, {
        allowLegacyTestResults: options.allowLegacyTestResults,
      });
    }
    if (index + 1 < attempts) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("The review session completed without a structured review result.");
}

export type RecoveredBuildReview = {
  report: StructuredReviewReport;
  session: PipelineSession;
};

type RecoverableBuildPipeline = Pick<
  BuildPipeline,
  "sessions" | "structuredReviewRequestId" | "structuredReview"
>;

/**
 * A domain-validation failure happens after the provider has already completed
 * the expensive review. Before starting another review, re-read that durable
 * result so contract migrations and transient observation failures can recover
 * without rerunning tests and the production build.
 *
 * Returns `null` when the pipeline already holds a report. `beginStructuredReview`
 * clears `structuredReview` and sets the request id together, so an *unconsumed*
 * review is the only state in which the recorded id and the last review session
 * are guaranteed to belong to the round that just failed. Once a report has been
 * consumed the pair can still point at the previous round — the bridge keeps a
 * session's structured output until the next *structured* prompt, and the
 * address-issues prompt is not one — and reusing it would silently skip the
 * review this pipeline is waiting on.
 *
 * The read tolerates legacy test results on purpose: the durable payload may
 * have been written by a build that predates `testResults.notRun`, which is the
 * failure this recovery exists to undo.
 */
export async function readExistingValidatedBuildReview(
  pipeline: RecoverableBuildPipeline,
  load: (
    sessionId: string,
    requestId: string,
  ) => Promise<StructuredOutputResult<unknown> | null>,
): Promise<RecoveredBuildReview | null> {
  const requestId = pipeline.structuredReviewRequestId;
  const session = [...pipeline.sessions]
    .reverse()
    .find((candidate) => candidate.phase === "review");
  if (!requestId || !session || pipeline.structuredReview) return null;

  const report = await readValidatedBuildReview(
    () => load(session.sdkSessionId, requestId),
    { attempts: 1, intervalMs: 0, allowLegacyTestResults: true },
  );
  return { report, session };
}

/**
 * {@link readExistingValidatedBuildReview} with the "no usable result" outcomes
 * collapsed to `null`, so callers can branch without a `try` around the advance
 * that follows. Keeping the advance outside the `catch` matters: a failure there
 * happens *after* the phase has moved and a prompt may already have been
 * dispatched, and treating it as "recovery failed" would start a second,
 * concurrent review turn on top of it.
 */
export async function recoverExistingBuildReview(
  pipeline: RecoverableBuildPipeline,
  load: (
    sessionId: string,
    requestId: string,
  ) => Promise<StructuredOutputResult<unknown> | null>,
  logLabel: string,
): Promise<RecoveredBuildReview | null> {
  try {
    return await readExistingValidatedBuildReview(pipeline, load);
  } catch (error) {
    console.warn(
      `${logLabel} Existing review result could not be read; starting a fresh review:`,
      error,
    );
    return null;
  }
}

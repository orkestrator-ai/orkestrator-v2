/**
 * The loop breaker for a failed Verify that another round cannot fix.
 *
 * A failed verdict starts a Fix round. When every acceptance criterion passed
 * and the only thing left red is validation the branch did not cause, Fix has
 * nothing to change: it spends a round proving the failure exists on the
 * target branch, validation runs the same suites again, they fail the same
 * tests, and Verify fails again until the iteration cap fails the pipeline.
 * The failure triage (`@orkestrator/protocol/validation-failure-triage`) lets
 * the supervisor see that before dispatching the round, and pause for a person
 * instead. Resume still runs the round, exactly as it would have.
 */
import type { BuildPipeline, PipelineCriterionResult } from "@orkestrator/protocol/build-pipeline";
import { isReviewPackageReference } from "@orkestrator/protocol/review-workflow";
import type { ValidationFailureSummary } from "@orkestrator/protocol/validation-failure-triage";

const PAUSE_ACTIONS =
  "Read the verdict and the review package's failure triage, then Resume to run another round anyway, send a message first to steer the fix, or Cancel and open the pull request yourself.";

export const UNRELATED_FAILURES_PAUSE_MESSAGE = `Paused: Verify failed, but every acceptance criterion passed and every failing test in this round's validation is classified unrelated to this branch (it passed on retry, is a known flake, fails on the target branch, or reaches no changed code). Another fix round cannot change that. ${PAUSE_ACTIONS}`;

export const REPEATED_FAILURES_PAUSE_MESSAGE = `Paused: Verify failed again with every acceptance criterion passed, and validation failed exactly the same tests as in the previous round, so the last fix did not change them. ${PAUSE_ACTIONS}`;

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Every failure is accounted for: no unparsed command and no omitted test. */
function fullyListed(summary: ValidationFailureSummary): boolean {
  return summary.unattributedCommands === 0 && !summary.truncated;
}

/**
 * Why the failed verdict just recorded should pause rather than start another
 * round, or null to continue. Call it before the round's package is archived.
 */
export function validationStallReason(
  pipeline: Pick<BuildPipeline, "reviewPackage" | "validationHistory" | "iteration">,
  criterionResults: readonly PipelineCriterionResult[],
): string | null {
  // A failed criterion is work Fix can do.
  if (criterionResults.some((result) => result.status === "failed")) return null;
  const reviewPackage = pipeline.reviewPackage;
  const current = isReviewPackageReference(reviewPackage)
    ? reviewPackage.failureSummary
    : undefined;
  if (!current || current.ids.length === 0 || !fullyListed(current)) return null;
  if (current.related === 0 && current.undetermined === 0) {
    return UNRELATED_FAILURES_PAUSE_MESSAGE;
  }
  const previous = (pipeline.validationHistory ?? [])
    .filter((entry) => entry.iteration < pipeline.iteration && entry.failures)
    .at(-1)?.failures;
  if (previous && fullyListed(previous) && sameIds(previous.ids, current.ids)) {
    return REPEATED_FAILURES_PAUSE_MESSAGE;
  }
  return null;
}

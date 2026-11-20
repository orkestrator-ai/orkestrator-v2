import type { MultiReviewPhase } from "@orkestrator/protocol/multi-review";

// What a delete or a new start says when an environment's Multi Review is
// still active (`isMultiReviewTerminalPhase` is false).
//
// `failed` stays active on purpose: the tab offers "Retry failed stage" and
// "Abandon" (which cancels) on it, and closing the tab leaves it for the
// launcher to reattach. So the refusal stands, but it must not call a failed
// review "running", and it names the two ways out (#2321).

/** The refusal of a delete of a workflow in `phase`. */
export function multiReviewDeleteRefusal(phase: MultiReviewPhase): string {
  return phase === "failed"
    ? "This Multi Review failed. Retry the failed stage or abandon (cancel) the review before deleting it"
    : "Cancel or finish the running Multi Review before deleting it";
}

/**
 * The refusal of a new start while the environment's active workflows are in
 * `phases`. Only when every one of them failed is the failed wording true.
 */
export function multiReviewStartRefusal(phases: readonly MultiReviewPhase[]): string {
  return phases.length > 0 && phases.every((phase) => phase === "failed")
    ? "The existing Multi Review failed. Retry its failed stage or abandon (cancel) it before starting another"
    : "Finish, cancel, or delete the existing Multi Review before starting another";
}

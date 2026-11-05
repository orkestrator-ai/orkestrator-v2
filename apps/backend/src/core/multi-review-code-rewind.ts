/**
 * "Rewind code to here" for a Multi Review: resets the worktree to the commit a
 * step started from, then restarts that step.
 *
 * Two steps can change code. Preparation started from the head the review pinned
 * when it began, and Address Findings from the head the package sealed, because
 * reviewers and consolidation only read. The Git side is shared with the build
 * pipeline and graph runs (`workspace-code-rewind.ts`): the old tip stays at a
 * backup ref, and a dirty worktree or a target that is not an ancestor refuses.
 *
 * A Multi Review's pull request step does not know how to force-push, so commits
 * already on the upstream branch refuse the rewind instead.
 */
import type {
  MultiReviewRewindStep,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import { codeRewindRefComponent } from "./workspace-code-rewind.js";

/** The commit `step` started from, when the review has reached it. */
export function multiReviewRewindTarget(
  workflow: Pick<MultiReviewWorkflow, "reviewWorktreeSnapshot" | "reviewPackage">,
  step: MultiReviewRewindStep,
): string | undefined {
  return step === "prepare"
    ? workflow.reviewWorktreeSnapshot?.head
    : workflow.reviewPackage?.headRef;
}

/** Why the review's state forbids a code rewind now, or undefined. The worktree is checked apart. */
export function multiReviewRewindStateBlocker(workflow: MultiReviewWorkflow): string | undefined {
  if (
    workflow.phase === "preparing" ||
    workflow.phase === "reviewing" ||
    workflow.phase === "consolidating" ||
    workflow.phase === "fixing" ||
    workflow.phase === "cancelling"
  ) {
    return "A running step could write to the worktree during the reset. Pause it or wait for it to finish.";
  }
  if (workflow.phase === "cancelled") return "This review was cancelled.";
  if (workflow.fixSession?.status === "running") {
    return "The Address Findings session is still running. Stop it first.";
  }
  if (
    workflow.validationRun &&
    (workflow.validationRun.status === "planned" || workflow.validationRun.status === "running")
  ) {
    return "Validation checks are still running.";
  }
  return undefined;
}

export function multiReviewRewindBackupRef(workflowId: string, rewindId: string): string {
  const component = (value: string) => codeRewindRefComponent(value, "review");
  return `refs/orkestrator/multi-review-rewinds/${component(workflowId)}/${component(rewindId)}`;
}

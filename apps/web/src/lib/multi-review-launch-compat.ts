/**
 * A Multi Review launch against a backend older than `launch_multi_review`.
 *
 * Such a backend starts a review but leaves its tab to the caller, so this
 * renderer reuses an active review, fills the saved target branch and
 * instruction, creates the tab and cleans up if it cannot, as it did before the
 * backend took that over. Frozen compatibility code; new behaviour goes in the
 * backend. Listed in `docs/architecture/version-compatibility.md`; delete it
 * when its row retires.
 */
import type { MultiReviewLaunchSelection } from "@/components/review/MultiReviewLaunchDialog";
import * as backend from "@/lib/backend";
import { findActiveMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { useMultiReviewStore } from "@/stores";

export interface LegacyMultiReviewLaunchInput {
  environmentId: string;
  projectId: string;
  targetBranch: string;
  reviewInstruction: string | undefined;
  selection: MultiReviewLaunchSelection;
  /** Opens the review's tab; false when the environment cannot take another. */
  createTab: (workflowId: string) => boolean;
}

/** `reused` when the tab reopened the review already running in the environment. */
export async function legacyLaunchMultiReview(
  input: LegacyMultiReviewLaunchInput,
): Promise<{ reused: boolean }> {
  const { createTab, selection } = input;
  let workflowId: string | undefined;
  let cancelRequested = false;
  try {
    // An environment may hold only one active Multi Review, and closing its
    // tab deliberately leaves the backend workflow running. Reattach to it
    // rather than failing the launch: the running one is otherwise
    // unreachable, and its Abandon control — the only way to free the
    // environment for a new review — lives inside the tab being reopened.
    const active = await findActiveMultiReviewWorkflow(input.environmentId);
    if (active) {
      if (!createTab(active.id)) {
        throw new Error(
          "A Multi Review is already running, but its tab could not be reopened." +
            " Close a tab and try again.",
        );
      }
      return { reused: true };
    }
    const workflow = await backend.startMultiReview({
      environmentId: input.environmentId,
      projectId: input.projectId,
      targetBranch: input.targetBranch,
      reviewInstruction: input.reviewInstruction,
      reviewers: selection.reviewers,
      reviewModel: selection.reviewModel,
      fixModel: selection.fixModel,
      autoFix: selection.autoFix,
      autoPr: selection.autoPr,
    });
    workflowId = workflow.id;
    useMultiReviewStore.getState().replaceWorkflow(workflow);
    if (!createTab(workflow.id)) {
      const launchError = "The environment is not ready or the maximum tab count was reached.";
      const cancelled = await backend.cancelMultiReview(workflow.id);
      cancelRequested = true;
      useMultiReviewStore.getState().replaceWorkflow(cancelled);
      // Cancellation is asynchronous, and only a terminal workflow may be
      // deleted. Deleting a still-cancelling one is rejected by the backend,
      // which would replace this message with a confusing storage error and
      // strand the record. Keep it installed for recovery instead.
      if (cancelled.phase !== "cancelled") {
        throw new Error(
          `${launchError} Cancellation is still in progress; the saved Multi Review remains available for recovery.`,
        );
      }
      await backend.deleteMultiReviewWorkflow(workflow.id);
      useMultiReviewStore.getState().removeWorkflow(workflow.id);
      throw new Error(launchError);
    }
    return { reused: false };
  } catch (error) {
    if (workflowId && !cancelRequested) {
      void backend.cancelMultiReview(workflowId).catch(() => undefined);
    }
    throw error;
  }
}

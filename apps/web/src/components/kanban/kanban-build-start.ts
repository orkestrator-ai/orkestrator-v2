import type { BuildLaunchSelection } from "@/components/build/BuildLaunchDialog";

/**
 * The `startBuild` options a Kanban ticket's build launcher selection becomes.
 * Both of the dialog's start paths (an existing ticket, and one created just
 * now) pass exactly this, so a launcher choice cannot reach one and not the other.
 */
export function kanbanBuildStartOptions(selection: BuildLaunchSelection) {
  return {
    steps: selection.steps,
    reviewers: selection.reviewers,
    reviewPreparation: selection.reviewPreparation,
    deliveryPolicy: selection.deliveryPolicy,
    networkAccessMode: selection.networkAccessMode,
  };
}

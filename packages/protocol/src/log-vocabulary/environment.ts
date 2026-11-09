import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const ENVIRONMENT_LOG_AREAS = defineLogAreas({
  environment: {
    description: "Environment naming, setup, status, moves, deletion and cleanup afterwards.",
    events: {
      "cleanup.sessions-failed":
        "Session metadata cleanup failed during environment deletion; deletion continues.",
      "cleanup.branch-kept":
        "A deleted environment's local branch was kept, as it may hold unmerged work.",
      "rename.failed": "Naming an environment from its pending prompt failed for the first time.",
      "rename.still-failing":
        "That rename is still failing; written at the 2nd, 4th, 8th... failure.",
      "rename.recovered": "A rename from a pending prompt succeeded after failing.",
      "setup.attention-not-recorded":
        "Held setup could not be recorded as needing the user's attention.",
      "setup.coordinator-not-notified":
        "The worker's coordinator could not be told that its setup is held for approval.",
      "setup.unknown-environment":
        "The renderer was asked to act on the setup of an environment it does not hold.",
      "cleanup.rearmed":
        "A deleted environment's stopped cleanup is retried once under a new backend version.",
      "cleanup.exhausted":
        "A deleted environment's cleanup keeps failing after its attempts; written once per environment.",
      "cleanup.retry-not-admitted":
        "A cleanup retry was not admitted; the entry stays for the next start.",
      "cleanup.step-failed":
        "One step of a deleted environment's cleanup failed; a later reconcile retries it.",
      "cleanup.record-failed":
        "A finished cleanup step could not be recorded, so it may run again.",
      "cleanup.sweep-failed": "A cleanup sweep failed; written once per sweep.",
      "cleanup.reconcile-failed": "A cleanup reconcile pass failed; the next one retries.",
      "orphan-state.remove-failed": "An orphaned environment state directory could not be removed.",
      "orphan-state.removed": "Orphaned environment state directories were removed.",
      "orphan-state.sweep-failed": "Sweeping orphaned environment state failed.",
      "orphan-canvas.removed": "Orphaned design canvases were removed.",
      "orphan-canvas.sweep-failed": "Sweeping orphaned design canvases failed.",
      "orphan-branches.swept":
        "Orphaned environment branches were deleted, or kept as they may hold unmerged work.",
      "stray-workspace.remove-failed": "A stray workspace directory could not be removed.",
      "stray-workspace.removed": "Stray workspace directories were removed.",
      "stray-workspace.kept":
        "Unowned workspace directories that hold files were kept; remove them by hand if unneeded.",
      "temp-files.removed": "Abandoned temp files were removed.",
      "status.ownership-probe-failed":
        "A strict container ownership probe failed, so the stored status is kept.",
      "status.docker-error":
        "A transient Docker error stopped a status read, so the stored status is kept.",
      "setup.clear-launch-failed":
        "A pending agent launch could not be cleared after setup failed.",
      "setup.record-failure-failed":
        "A setup failure before its first attempt could not be recorded.",
      "setup.tab-publish-failed": "The setup terminal's tab could not be published.",
      "lifecycle.failed":
        "Starting, rebuilding or recreating an environment failed; `operation` says which.",
      "git-https-probe.failed":
        "Checking whether a project's GitHub remote works over HTTPS failed; `reason` says why.",
      "git-https-remedy.failed":
        "Deciding whether to offer HTTPS after an SSH failure threw; no remedy is offered.",
      "git-origin.switched-to-https":
        "A project's origin remote was switched from GitHub SSH to HTTPS at the user's request.",
      "tab-teardown.pending":
        "A tab's teardown failed and stays pending; the reconcile sweep retries.",
      "tab-reconcile.skipped":
        "Orphaned tab reconciliation was skipped because pane layouts are unreadable.",
      "orphan-session.reaped": "A native session no tab references was torn down.",
      "handoff-sweep.failed": "Sweeping transferred transcripts no tab references failed.",
      "delete.terminals-survived":
        "Terminal process trees outlived termination, so the deletion stops.",
      "delete.step-deadline":
        "A deletion step that runs child processes passed its deadline; they are stopped and the deletion fails once they have.",
      "delete.artifacts-left": "Graph run artifact directories were not removed.",
      "delete.worktrees-kept": "Graph runs kept branch worktrees.",
      "delete.step-failed":
        "One best-effort part of deleting an environment failed; `step` says which, and the rest goes on.",
      "merge-cleanup.resume-failed":
        "A merge cleanup interrupted by a restart could not be resumed.",
      "move.sessions-not-moved": "A provider's sessions could not follow a moved environment.",
      "move.recovery-failed": "Recovering an interrupted environment move failed.",
      "stop.settle-activity-failed": "Agent activity could not be settled after a runtime stopped.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

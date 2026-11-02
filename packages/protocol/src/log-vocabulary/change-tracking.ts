import { defineLogAreas } from "./define.js";

export const CHANGE_TRACKING_LOG_AREAS = defineLogAreas({
  "change-tracking": {
    description: "Change tracking: turn capture, evidence pulls and measurements.",
    events: {
      "journal-import.failed":
        "Importing surviving OpenCode command journals as legacy summaries failed.",
      "projection.failed": "Projecting a change event onto its environment failed.",
      "startup.reconcile-failed": "Reconciling change tracking at startup failed.",
      "turn-start.capture-failed": "Capturing a turn's start failed, so the turn is untracked.",
      "dispatch.record-failed": "Recording a turn's dispatch outcome failed.",
      "turn.finalize-failed": "Finalizing a turn failed.",
      "turn.settle-failed": "Settling a late interrupted turn failed.",
      "evidence.pull-failed": "Pulling change evidence from a bridge failed; a later pull retries.",
      "measurement.failed": "Recomputing a tool's measurement failed.",
    },
  },
  "diff-stats": {
    description: "Environment diff stats and the worktree signals that drive them.",
    events: {
      "baseline.update-failed": "An environment's diff baseline could not be updated.",
      "scan.warning":
        "A diff scan step failed. `detail` is the service's own text with identifiers only.",
      "signal.demoted":
        "A worktree signal stopped being trusted, so scans fall back to timers until it is re-armed.",
    },
  },
});

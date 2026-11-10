import { defineLogAreas } from "./define.js";

export const CHANGE_TRACKING_LOG_AREAS = defineLogAreas({
  "change-tracking": {
    description: "Change tracking: turn capture, evidence pulls and measurements.",
    events: {
      "journal-import.failed":
        "Importing surviving OpenCode command journals as legacy summaries failed.",
      "measurement-drain.failed":
        "Draining an owner's superseded measurements failed; the retention pass retries.",
      "retention.failed":
        "A retention pass failed partway; what it deleted stands and the next pass goes on.",
      "projection.failed": "Projecting a change event onto its environment failed.",
      "startup.reconcile-failed": "Reconciling change tracking at startup failed.",
      "turn-start.capture-failed": "Capturing a turn's start failed, so the turn is untracked.",
      "dispatch.record-failed": "Recording a turn's dispatch outcome failed.",
      "turn.finalize-failed": "Finalizing a turn failed.",
      "turn.settle-failed": "Settling a late interrupted turn failed.",
      "turn.end-recovery":
        "A background retry of a turn end capture that timed out finished: recovered, done (no longer eligible) or exhausted.",
      "turn.end-recovery-failed":
        "A background retry of a turn end capture threw; it counts as a failed attempt.",
      "evidence.pull-failed": "Pulling change evidence from a bridge failed; a later pull retries.",
      "measurement.failed": "Recomputing a tool's measurement failed.",
    },
  },
  "diff-stats": {
    description: "Environment diff stats and the worktree signals that drive them.",
    events: {
      "baseline.update-failed": "An environment's diff baseline could not be updated.",
      "scan.watcher-failed":
        "An environment's diff watcher failed; its scans fall back to polling.",
      "scan.failed":
        "A diff scan failed; the last results stay, marked stale, and the scan is retried.",
      "scan.freshness-read-failed": "Reading whether an environment's remote is fresh failed.",
      "scan.listener-failed": "A change-tracking scan listener threw; the scan itself stands.",
      "emit.diff-stats-failed": "A diff stats change could not be emitted to its sink.",
      "emit.worktree-snapshot-failed": "A worktree snapshot could not be emitted to its sink.",
      "signal.demoted":
        "A worktree signal stopped being trusted, so scans fall back to timers until it is re-armed.",
    },
  },
});

import { defineLogAreas } from "./define.js";

export const GRAPH_LOG_AREAS = defineLogAreas({
  graph: {
    description: "Graph runs: launches, passes, rewinds, system actions and templates.",
    events: {
      "describe.pass-failed":
        "A graph describe pass failed. Content-free: never the description or draft.",
      "system.stop-failed": "A system action's work could not be stopped.",
      "system.action-failed": "A system action failed; `cause` is its fixed failure cause.",
      "attention.update-failed": "The sidebar could not be updated for a run.",
      "launch.ticket-link-failed": "A launched run's ticket could not be linked.",
      "launch.started": "A graph run was launched.",
      "launch.swept": "Runs that ended without an environment were removed.",
      "rewind.pending": "A run's code rewind has not finished.",
      "rewind.applied": "A run was restarted or rewound.",
      "rewind.waiting": "A run waits for its code rewind to finish.",
      "history.pruned": "Finished runs beyond an environment's history were removed.",
      "history.prune-failed": "Pruning an environment's run history failed.",
      "worktree.cleanup-failed": "A run's branch worktree cleanup failed.",
      "run.unreadable": "A run is unreadable, so it is not scheduled.",
      "run.pass-failed": "A pass over a run failed.",
      "transcript.capture-failed": "A run's transcript capture failed.",
      "ticket.link-failed": "A run's ticket could not be linked to its environment.",
      "template.skipped": "A built-in template was skipped as invalid or a duplicate.",
    },
  },
});

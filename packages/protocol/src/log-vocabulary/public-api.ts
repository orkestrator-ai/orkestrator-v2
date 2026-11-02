import { defineLogAreas } from "./define.js";

export const PUBLIC_API_LOG_AREAS = defineLogAreas({
  "public-api": {
    description: "The public CLI's operations: their outcomes, reconciliation and exec workers.",
    events: {
      "outcome.record-failed":
        "A background operation's outcome could not be recorded; reconciliation settles it.",
      "goal-checks.stop-failed": "Goal checks could not be stopped.",
      "exec.list-failed": "Exec workers could not be listed.",
      "exec.cancel-failed": "An exec could not be cancelled.",
      "goal-workers.list-failed": "Goal check workers could not be listed.",
      "operation.reconcile-failed": "Reconciling one operation failed; the next pass retries.",
      "reconcile.pass-failed": "A reconciliation pass failed; the next one retries.",
    },
  },
});

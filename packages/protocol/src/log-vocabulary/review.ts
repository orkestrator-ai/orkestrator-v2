import { defineLogAreas } from "./define.js";

export const REVIEW_LOG_AREAS = defineLogAreas({
  review: {
    description: "Multi Review workflows: scheduling, graph runs and interactive fix sessions.",
    events: {
      "fix-tab.publish-failed":
        "A fix request was delivered but its tab could not be opened; the user is told.",
      "graph-run.not-started": "A workflow's graph run did not start.",
      "reconcile.scan-failed": "A reconciliation scan failed; the next scan retries.",
      "graph-engine.unavailable":
        "The graph engine is selected but unavailable, so the bespoke engine runs.",
      "graph-run.cancel-failed":
        "Cancelling a graph run failed; the next pass projects how it ended.",
      "delete.cleanup-failed":
        "A cleanup step after deleting a workflow failed; stale tabs reconcile away on hydration.",
      "fix-session.read-failed": "Reading an interactive fix session's state failed.",
      "fix-outcome.read-failed": "Reading an interactive fix's outcome failed; it stays pending.",
      "fix-usage.read-failed": "Reading a fix session's token usage failed.",
      "result.consume-deferred":
        "Consuming a workflow result failed; it stays staged and is retried.",
      "failure-triage.failed":
        "Classifying a review package's failing tests failed; the package is sealed without the triage and says so.",
    },
  },
  "pull-request": {
    description: "Pull request monitoring, auto-merge and the `gh` reads behind them.",
    events: {
      "merged-state.persist-failed":
        "A merged pull request's state could not be saved; GitHub stays authoritative and cleanup goes on.",
      "refresh.failed": "A pull request could not be refreshed; the armed flag stands.",
      "arm.track-failed":
        "An armed environment could not be tracked; the monitor's next sync retries.",
      "gh.pr-list-unparseable":
        "`gh pr list` returned nothing that parses. Sizes only, never the output.",
      "monitor.start-failed": "Monitoring could not start for a newly opened pull request.",
      "cleanup-scheduler.missing":
        "A merged pull request was seen, but this runtime has no merge cleanup scheduler.",
      "auto-merge.warning":
        "An auto-merge evaluation or action failed. `detail` is the service's own text with identifiers only.",
      "monitor.warning":
        "A monitor step failed. `detail` is the service's own text with identifiers only.",
    },
  },
});

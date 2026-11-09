import { defineLogAreas } from "./define.js";

export const REVIEW_LOG_AREAS = defineLogAreas({
  review: {
    description: "Multi Review workflows: scheduling, graph runs and interactive fix sessions.",
    events: {
      "fix-tab.publish-failed":
        "A Address Findings request was delivered but its tab could not be opened; the user is told.",
      "graph-run.not-started": "A workflow's graph run did not start.",
      "reconcile.scan-failed": "A reconciliation scan failed; the next scan retries.",
      "graph-engine.unavailable":
        "The graph engine is selected but unavailable, so the bespoke engine runs.",
      "graph-run.cancel-failed":
        "Cancelling a graph run failed; the next pass projects how it ended.",
      "delete.cleanup-failed":
        "A cleanup step after deleting a workflow failed; stale tabs reconcile away on hydration.",
      "fix-session.read-failed": "Reading an interactive Address Findings session's state failed.",
      "fix-outcome.read-failed": "Reading an interactive fix's outcome failed; it stays pending.",
      "fix-usage.read-failed": "Reading an Address Findings session's token usage failed.",
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
      "checkout.follow-merge-lookup-failed":
        "A merged pull request's project could not be read, so its checkout was not fast-forwarded.",
      "auto-merge.evaluation-failed": "Evaluating an environment for auto-merge failed.",
      "auto-merge.merge-failed":
        "Auto-merge could not merge a pull request; the attempt is held and retried.",
      "auto-merge.resolve-failed":
        "Auto-merge could not launch Resolve for a pull request; the attempt is held and retried.",
      "monitor.detection-failed": "Checking an environment for its pull request failed.",
      "monitor.detection-admission-failed":
        "A pull request check could not be admitted to the work pool.",
      "monitor.terminal-repair-failed":
        "Repairing a merged or closed pull request's side effects failed.",
      "monitor.terminal-resume-failed":
        "Resuming a merged or closed pull request's side effects failed.",
      "monitor.stale-reading-ignored":
        "A non-merged reading (`state`) for a pull request already merged was ignored as stale.",
      "monitor.state-persist-failed": "A pull request's observed state could not be saved.",
      "monitor.state-clear-failed": "A pull request's saved state could not be cleared.",
      "monitor.task-reconcile-failed":
        "Updating the Kanban task of a merged or closed (`state`) pull request failed.",
      "monitor.task-store-failed": "A pull request could not be recorded on its Kanban task.",
      "monitor.merged-tickets-closed":
        "The startup sweep moved Kanban tickets whose pull request had merged to done (`count`).",
      "monitor.merged-tickets-close-failed":
        "The startup sweep closing Kanban tickets whose pull request merged failed; the next backend start retries.",
      "monitor.emit-failed": "A pull request monitor event could not be emitted to its sink.",
      "branch-cleanup.kept":
        "A merge or cleanup kept a pull request's head branch because it is not the branch created for the environment (`reason`).",
    },
  },
});

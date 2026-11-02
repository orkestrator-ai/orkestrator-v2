import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const WEB_ANNOTATIONS_LOG_AREAS = defineLogAreas({
  "web-annotations": {
    description: "Web annotation requests and their background reconciler.",
    events: {
      "reconcile.failed": "A background reconcile pass failed; the next one retries.",
      "legacy.degraded":
        "Legacy annotation storage is damaged, so the previous committed copy is served read-only.",
      "legacy.draft-index-problem": "The legacy draft index could not be used; `status` says why.",
      "legacy.unreadable-records": "The legacy import found unreadable records; they stay unread.",
      "legacy.unavailable": "Legacy annotation storage could not be read.",
      "legacy.unreadable": "An environment's legacy annotation storage is unreadable.",
      "legacy.archive-failed": "Imported legacy annotation files could not be archived.",
      "legacy.files-archived":
        "Legacy files beside an imported environment were archived, not imported.",
      "migration.draft-failed": "Migrating one draft failed.",
      "draft-reconcile.deferred": "Draft reconciliation was deferred; a later pass retries.",
      "request.handoff-deferred": "A request's handoff was deferred; a later pass retries.",
      "evidence.materialize-failed":
        "Materializing a request's evidence failed; it backs off and retries.",
      "queue.publish-deferred":
        "Publishing a request to the queue was deferred; it retries under the same id.",
      "request.reconcile-failed": "Reconciling a request failed; the next pass retries.",
      "turn-end.reconcile-failed":
        "Reconciling a request at the end of a turn failed; the next pass retries.",
      "gc.failed": "Annotation garbage collection failed; the next pass retries.",
      "record.unavailable": "An annotation record is unavailable; written once per record.",
      "storage.unavailable": "An environment's annotation store is unreadable.",
      "change-hint.listener-failed": "A change hint listener threw.",
      "orphan.remove-failed": "An orphaned environment's annotation storage could not be removed.",
      "storage.load-failed": "An environment's annotation storage could not be loaded.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

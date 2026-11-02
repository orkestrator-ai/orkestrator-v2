import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const WEB_ANNOTATIONS_LOG_AREAS = defineLogAreas({
  "web-annotations": {
    description: "Web annotation requests and their background reconciler.",
    events: {
      "reconcile.failed": "A background reconcile pass failed; the next one retries.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

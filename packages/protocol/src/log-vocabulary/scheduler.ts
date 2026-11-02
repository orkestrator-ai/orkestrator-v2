import { defineLogAreas } from "./define.js";

export const SCHEDULER_LOG_AREAS = defineLogAreas({
  scheduler: {
    description: "Scheduled jobs and the backend-owned timing that fires them.",
    events: {
      "service.warning":
        "A scheduled job service step failed. `detail` is the service's own text with identifiers only.",
    },
  },
});

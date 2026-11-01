import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const BACKEND_LOG_AREAS = defineLogAreas({
  "backend.activity": {
    description: "The backend's recurring activity and maintenance jobs.",
    events: {
      "job.failed": "One pass of the job named in `scope` failed; its next pass retries.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

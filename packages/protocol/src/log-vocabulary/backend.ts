import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const BACKEND_LOG_AREAS = defineLogAreas({
  "build.pipeline": {
    description: "Build delivery, ticket reconciliation and persisted pipeline recovery.",
    events: {
      "delivery-policy.failed":
        "A ticket delivery edit could not be reconciled with the running build.",
      "criteria.failed": "Verify could not record criterion results on the ticket.",
      "transcript-maintenance.failed": "Pipeline transcript maintenance failed.",
      "hydrate.failed": "The renderer could not load the authoritative pipeline snapshot.",
    },
  },
  "backend.activity": {
    description: "The backend's recurring activity and maintenance jobs.",
    events: {
      "job.failed": "One pass of the job named in `scope` failed; its next pass retries.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

import { defineLogAreas } from "./define.js";

export const SCHEDULER_LOG_AREAS = defineLogAreas({
  scheduler: {
    description: "Scheduled jobs and the backend-owned timing that fires them.",
    events: {
      "tick.failed": "A scheduler tick failed; the next tick retries.",
      "job.claim-failed": "A due job could not be claimed.",
      "fire.heartbeat-failed": "A running fire's heartbeat could not be recorded.",
      "fire.outcome-record-failed": "A finished fire's outcome could not be recorded.",
    },
  },
});

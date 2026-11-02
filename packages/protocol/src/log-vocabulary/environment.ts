import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const ENVIRONMENT_LOG_AREAS = defineLogAreas({
  environment: {
    description: "Environment naming, held setup and cleanup after deletion.",
    events: {
      "cleanup.branch-kept":
        "A deleted environment's local branch was kept, as it may hold unmerged work.",
      "rename.failed": "Naming an environment from its pending prompt failed for the first time.",
      "rename.still-failing":
        "That rename is still failing; written at the 2nd, 4th, 8th... failure.",
      "rename.recovered": "A rename from a pending prompt succeeded after failing.",
      "setup.attention-not-recorded":
        "Held setup could not be recorded as needing the user's attention.",
      "setup.coordinator-not-notified":
        "The worker's coordinator could not be told that its setup is held for approval.",
      "setup.unknown-environment":
        "The renderer was asked to act on the setup of an environment it does not hold.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

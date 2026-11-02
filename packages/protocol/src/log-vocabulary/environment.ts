import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const ENVIRONMENT_LOG_AREAS = defineLogAreas({
  environment: {
    description: "Environment naming, setup approval and cleanup after deletion.",
    events: {
      "cleanup.branch-kept":
        "A deleted environment's local branch was kept, as it may hold unmerged work.",
      "rename.failed": "Naming an environment from its pending prompt failed for the first time.",
      "rename.still-failing":
        "That rename is still failing; written at the 2nd, 4th, 8th... failure.",
      "rename.recovered": "A rename from a pending prompt succeeded after failing.",
      "setup-approval.unknown-environment":
        "A setup approval named an environment the renderer does not know; nothing was approved.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

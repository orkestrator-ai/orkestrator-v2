import { defineLogAreas } from "./define.js";

export const FEATURE_LOG_AREAS = defineLogAreas({
  feature: {
    description: "Feature builds and feature planning.",
    events: {
      "naming.fallback":
        "Automatic naming failed, so a local fallback name is used. Error kind only: the description stays out.",
      "planning.legacy-adopt-failed": "Legacy planning conversations could not be adopted.",
      "planning.tick-retrying":
        "A planning tick failed on a transient error; the next tick retries.",
    },
  },
});

import { defineLogAreas } from "./define.js";

export const FEATURE_LOG_AREAS = defineLogAreas({
  feature: {
    description: "Pipeline environments started from a feature, and feature planning.",
    events: {
      "debug-build.launched":
        "The debug button's pipeline environment was launched. Ids and counts only: no ticket text, transcript or screenshot.",
      "naming.fallback":
        "Automatic naming failed, so a local fallback name is used. Error kind only: the description stays out.",
      "planning.legacy-adopt-failed": "Legacy planning conversations could not be adopted.",
      "planning.tick-retrying":
        "A planning tick failed on a transient error; the next tick retries.",
    },
  },
});

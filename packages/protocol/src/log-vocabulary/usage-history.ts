import { defineLogAreas } from "./define.js";

export const USAGE_HISTORY_LOG_AREAS = defineLogAreas({
  "usage-history": {
    description: "Recorded agent token usage.",
    events: {
      "record.failed": "Agent usage could not be recorded; a later read counts it.",
      "prune.failed": "Pruning recorded usage failed; the next prune retries.",
      "settled-read.failed":
        "Reading a settled turn's usage failed; the next session or projection read counts it.",
    },
  },
});

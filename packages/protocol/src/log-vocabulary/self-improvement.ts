import { defineLogAreas } from "./define.js";

export const SELF_IMPROVEMENT_LOG_AREAS = defineLogAreas({
  "self-improvement": {
    description:
      "Self-improvement runs: diagnostics and conversation review turned into tickets. Counts and steps only, never conversation text.",
    events: {
      "run.started": "A run started; `trigger` is manual, daily or dry-run.",
      "run.finished":
        "A run finished; `created`, `verified`, `fixFailed` and `parts` count its tickets, confirmed fixes, failed fixes and conversation parts read.",
      "run.failed": "A run stopped before it finished; `reason` is a fixed label.",
      "review.call-failed":
        "One conversation review call failed; the run carries on and the part is read again next run.",
      "daily.check-failed": "The daily run check failed; the next check retries.",
    },
  },
});

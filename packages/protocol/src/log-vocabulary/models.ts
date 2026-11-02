import { defineLogAreas } from "./define.js";

export const MODEL_LOG_AREAS = defineLogAreas({
  models: {
    description: "Agent model catalogues and their persistent caches.",
    events: {
      "cache.write-failed": "A successful catalogue refresh could not update the host cache.",
    },
  },
});

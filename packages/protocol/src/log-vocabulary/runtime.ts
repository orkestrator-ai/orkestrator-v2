import { defineLogAreas } from "./define.js";

export const RUNTIME_LOG_AREAS = defineLogAreas({
  "event-loop": {
    description:
      "This process's event loop. A stall of 10 seconds or more is written at error, so no level hides it.",
    events: {
      stalled: "A timer fired late, so every request in that window waited.",
    },
  },
});

import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const NATIVE_AGENT_LOG_AREAS = defineLogAreas({
  "native-agent": {
    description: "Native agent sessions and what the backend reads from their bridges.",
    events: {
      "catalogue.outdated-bridge":
        "A bridge predates the command catalogue, so its commands stay unavailable.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const LOCAL_SERVER_LOG_AREAS = defineLogAreas({
  "local-server": {
    description: "Agent bridge processes the backend runs on the host.",
    events: {
      "bridge.not-answering":
        "A bridge with work in progress fails health checks, so it is not restarted yet.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

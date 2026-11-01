import { defineLogAreas } from "./define.js";

export const GATEWAY_LOG_AREAS = defineLogAreas({
  gateway: {
    description: "The remote gateway other devices and browsers connect through.",
    events: {
      "remote.start-failed": "The desktop could not start the remote gateway.",
      "remote.stop-failed": "The desktop could not stop the remote gateway cleanly.",
    },
  },
});

import { defineLogAreas } from "./define.js";

export const AGENT_MAIL_LOG_AREAS = defineLogAreas({
  "agent-mail": {
    description: "Delivering agent mail into waiting agent sessions.",
    events: {
      "delivery.waiting":
        "The drain passed over a pending message, for a reason it had not yet logged.",
    },
  },
});

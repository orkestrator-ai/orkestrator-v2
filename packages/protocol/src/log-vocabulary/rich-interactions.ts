import { defineLogAreas } from "./define.js";

export const RICH_INTERACTIONS_LOG_AREAS = defineLogAreas({
  "rich-interactions": {
    description:
      "App-owned rich interactions: requests agents present, decisions the user submits, and the delivery of those decisions to sessions and product operations. Never a prompt, field value, comment or excerpt.",
    events: {
      "dispatch.enqueue-failed":
        "A committed follow-up could not be handed to the session's prompt queue; it stays pending and is retried.",
      "sweep.deliver-failed":
        "The delivery sweep could not advance one receipt; the next sweep retries it.",
      "start.failed":
        "The rich interaction service could not start; interaction tools are unavailable on this backend.",
    },
  },
});

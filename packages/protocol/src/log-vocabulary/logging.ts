import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const LOGGING_LOG_AREAS = defineLogAreas({
  logging: {
    description: "The logger and the on-disk application log themselves.",
    events: {
      "capture.started": "Saving logs to disk began for this process.",
      "capture.stopped": "Saving logs to disk stopped for this process.",
      "config.invalid": "A logging environment variable held a value that was ignored.",
      "entries.dropped": {
        description:
          "Entries were dropped and counted, for the fixed `reason` given: the queue was full, a write failed or, in the essential log, one event was repeating too fast.",
        essential: true,
        fields: { entries: "number", bytes: "number", reason: "label" },
      },
      "essential.started": {
        description:
          "This process began writing the essential log. One with no `essential.stopped` before it means the last writer died.",
        essential: true,
        fields: { owner: "label" },
      },
      "essential.stopped": {
        description: "This process stopped writing the essential log, in an orderly exit.",
        essential: true,
        fields: { owner: "label" },
      },
      "essential.write-failed":
        "Writing the essential log failed. Its entries are counted, and a marker reports them at the next write that works.",
      "policy.changed":
        "The logging settings changed: saving, retention and levels, with no content.",
      "policy.bridge-predates-route":
        "A running bridge has no logging settings route; it applies them at its next start.",
      "policy.push-failed":
        "A running bridge did not take the logging settings after retries; its next start resends them.",
      "prune.failed": "Removing expired log files failed; the next sweep retries.",
      "write.failed": "Appending to the log file failed.",
      "unknown-area": "Code outside the type checker asked for an area that is not listed.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

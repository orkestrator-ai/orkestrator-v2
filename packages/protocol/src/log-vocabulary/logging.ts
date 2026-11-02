import { defineLogAreas } from "./define.js";

export const LOGGING_LOG_AREAS = defineLogAreas({
  logging: {
    description: "The logger and the on-disk application log themselves.",
    events: {
      "capture.started": "Saving logs to disk began for this process.",
      "capture.stopped": "Saving logs to disk stopped for this process.",
      "config.invalid": "A logging environment variable held a value that was ignored.",
      "entries.dropped": "The log queue was full, so entries were dropped and counted.",
      "policy.changed":
        "The logging settings changed: saving, retention and levels, with no content.",
      "policy.bridge-predates-route":
        "A running bridge has no logging settings route; it applies them at its next start.",
      "policy.push-failed":
        "A running bridge did not take the logging settings after retries; its next start resends them.",
      "prune.failed": "Removing expired log files failed; the next sweep retries.",
      "write.failed": "Appending to the log file failed.",
      "unknown-area": "Code outside the type checker asked for an area that is not listed.",
    },
  },
});

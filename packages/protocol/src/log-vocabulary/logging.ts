import { defineLogAreas } from "./define.js";

export const LOGGING_LOG_AREAS = defineLogAreas({
  logging: {
    description: "The logger and the on-disk application log themselves.",
    events: {
      "capture.started": "Saving logs to disk began for this process.",
      "config.invalid": "A logging environment variable held a value that was ignored.",
      "entries.dropped": "The log queue was full, so entries were dropped and counted.",
      "prune.failed": "Removing expired log files failed; the next sweep retries.",
      "write.failed": "Appending to the log file failed.",
      "unknown-area": "Code outside the type checker asked for an area that is not listed.",
    },
  },
});

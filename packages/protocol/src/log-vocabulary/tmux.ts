import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const TMUX_LOG_AREAS = defineLogAreas({
  tmux: {
    description: "The poll loop behind a Claude tmux tab.",
    events: {
      "poll.discovery-failed": "Finding the session's transcript failed; a later tick retries.",
      "poll.snapshot-failed":
        "Reading the hook and transcript state failed; the next tick retries.",
      "poll.drain-pending-failed": "Delivering pending hook events failed; the next tick retries.",
      "poll.drain-timeouts-failed": "Delivering hook timeouts failed; the next tick retries.",
      "poll.tail-failed": "Reading new transcript lines failed; the next tick retries.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

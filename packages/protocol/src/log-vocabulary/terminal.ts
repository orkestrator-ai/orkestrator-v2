import { defineLogAreas, THROTTLE_LOG_EVENTS } from "./define.js";

export const TERMINAL_LOG_AREAS = defineLogAreas({
  terminal: {
    description:
      "The renderer's terminal. Its lines stay in the browser console, never the saved log.",
    events: {
      "input.undelivered": "A keystroke did not reach a shell: `no-session` or `not-delivered`.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

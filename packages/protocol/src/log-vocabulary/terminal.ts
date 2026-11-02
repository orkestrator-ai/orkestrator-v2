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
  "terminal.setup": {
    description: "The renderer attaching a backend-managed environment setup terminal.",
    events: {
      "session.bind-from-environment": "The environment hook bound a setup session to a tab.",
      "setup.started-received": "An environment-setup-started event arrived.",
      "setup.complete-received": "An environment-setup-complete event arrived.",
    },
  },
});

import { defineLogAreas, ESSENTIAL_ERROR_FIELDS, THROTTLE_LOG_EVENTS } from "./define.js";

export const RUNTIME_LOG_AREAS = defineLogAreas({
  "event-loop": {
    description:
      "This process's event loop. A stall of 10 seconds or more is written at error, so no level hides it.",
    events: {
      stalled: {
        description: "A timer fired late, so every request in that window waited.",
        essential: true,
        minLevel: "error",
        fields: { lagMs: "number", intervalMs: "number" },
      },
    },
  },
  process: {
    description: "Failures of a whole process that nothing in it handled.",
    events: {
      "rejection.unhandled": {
        description:
          "A promise rejection reached the fatal rejection guard, which keeps the process running.",
        essential: true,
        fields: { kind: "label", ...ESSENTIAL_ERROR_FIELDS },
      },
      "uncaught-exception": {
        description:
          "An exception reached the top of the backend, which is about to die with it. `origin` says whether it was thrown or a rejected top-level await.",
        essential: true,
        fields: { origin: "label", ...ESSENTIAL_ERROR_FIELDS },
      },
      "child.reaped":
        "A macOS child whose exit Bun lost was reaped after its command settled, so it no longer waits as a zombie.",
      "child.reap-abandoned":
        "A child whose exit Bun lost was left unreaped: `reason` says whether it was never seen as a zombie (`not-a-zombie`), too many were pending (`capacity`), or `waitpid` failed.",
      "child.reap-unavailable":
        "waitpid could not be loaded, so children whose exit Bun lost stay zombies until this process exits.",
      ...THROTTLE_LOG_EVENTS,
    },
  },
});

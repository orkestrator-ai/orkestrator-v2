import { defineLogAreas } from "./define.js";

export const DESIGN_LOG_AREAS = defineLogAreas({
  design: {
    description: "The design canvas: its library, renderer and session links.",
    events: {
      "change-signal.failed": "A design change signal failed.",
      "library.index-write-failed": "The design library index could not be written.",
      "library.refresh-failed": "The design library could not be refreshed.",
      "renderer.problem": "The renderer hit a limit or lost a browser; `problem` is a fixed name.",
      "task.failed": "A design background task failed.",
      "canvas.needs-recovery": "A design canvas is unreadable and marked for recovery.",
      "startup.step-failed": "One part of design startup failed; `step` says which.",
      "legacy.retire-failed": "A migrated legacy design could not be retired.",
      "profiles.swept": "Design startup removed stale browser profiles.",
      "session-link.record-failed":
        "A closing conversation could not be recorded on a design link.",
      "session-link.archived-read-failed":
        "Whether design links' conversations are archived could not be read; they read as not archived.",
    },
  },
});

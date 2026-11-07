import { defineLogAreas } from "./define.js";

/**
 * Every `web.*` area is the renderer's own. Its lines reach the browser console
 * and stop there: only the exact `[DesktopStartup]` markers cross into the saved
 * log, and those do not come from a logger.
 */
export const WEB_SHELL_LOG_AREAS = defineLogAreas({
  "web.startup": {
    description: "Loading the renderer, after the desktop connection check.",
    events: {
      "renderer.load-failed": "Importing or mounting the application failed.",
      "model-catalogue.restore-failed":
        "The cached model catalogue could not be restored; bundled fallbacks stay in use.",
      "model-catalogue.seed-failed":
        "The background model-catalogue seed failed; cached catalogues stay in use.",
    },
  },
  "web.window": {
    description: "Errors nothing in the renderer caught. Bug reports classify these two lines.",
    events: {
      "error.unhandled": "A window error event reached the bootstrap handler.",
      "rejection.unhandled": "A promise rejected with no handler.",
    },
  },
  "web.react": {
    description: "React's root error callbacks and the lazy view boundary.",
    events: {
      "root.caught-error": "An error boundary caught a render error.",
      "root.uncaught-error": "A render error reached the root with no boundary.",
      "root.recoverable-error": "React recovered from a render error by retrying.",
      "lazy-view.failed": "A lazily loaded view failed; fields are the bounded diagnostic.",
    },
  },
});

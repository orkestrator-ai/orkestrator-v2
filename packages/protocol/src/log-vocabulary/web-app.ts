import { defineLogAreas } from "./define.js";

export const WEB_APP_LOG_AREAS = defineLogAreas({
  "web.app": {
    description: "The application root: startup checks and restoring state.",
    events: {
      "config.load-failed": "The application config could not be loaded.",
    },
  },
  "web.session": {
    description: "The renderer's terminal and agent session store.",
    events: {
      "status.update-failed": "A session status change could not be saved.",
    },
  },
  "web.action-bar": {
    description: "The environment action bar.",
    events: {
      "editor.open-failed": "The external editor could not be opened.",
    },
  },
});

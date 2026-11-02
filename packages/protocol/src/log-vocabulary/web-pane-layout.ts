import { defineLogAreas } from "./define.js";

export const WEB_PANE_LAYOUT_LOG_AREAS = defineLogAreas({
  "web.pane-layout": {
    description: "Panes and tabs in the renderer: moves, splits, teardown and saved layouts.",
    events: {
      "persist.failed": "A pane layout could not be written to the backend.",
    },
  },
});

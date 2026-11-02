import { defineLogAreas } from "./define.js";

export const WEB_KANBAN_LOG_AREAS = defineLogAreas({
  "web.kanban": {
    description: "The Kanban board, its task dialog and project notes.",
    events: {
      "tasks.load-failed": "A project's tasks could not be loaded.",
    },
  },
  "web.feature-plan": {
    description: "Feature planning in the renderer.",
    events: {
      "features.load-failed": "A project's features could not be loaded.",
    },
  },
});

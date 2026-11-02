import { defineLogAreas } from "./define.js";

export const WEB_ENVIRONMENT_LOG_AREAS = defineLogAreas({
  "web.environment": {
    description: "Environment lifecycle and dialogs as the renderer drives them.",
    events: {
      "start.failed": "Starting an environment from the renderer failed.",
    },
  },
  "web.sidebar": {
    description: "The project and environment sidebar.",
    events: {
      "reorder.persist-failed": "A sidebar reorder could not be saved.",
    },
  },
  "web.docker": {
    description: "The Docker settings view.",
    events: {
      "data.load-failed": "Container or image data could not be loaded.",
    },
  },
  "web.project": {
    description: "Adding a project from the renderer.",
    events: {
      "directory-picker.failed": "The directory picker could not be opened.",
    },
  },
});

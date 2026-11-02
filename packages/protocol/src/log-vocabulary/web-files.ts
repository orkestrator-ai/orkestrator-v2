import { defineLogAreas } from "./define.js";

export const WEB_FILES_LOG_AREAS = defineLogAreas({
  "web.files": {
    description: "The files panel, file viewer and file search.",
    events: {
      "file.save-failed": "A file could not be saved.",
    },
  },
});

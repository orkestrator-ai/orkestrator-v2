import { defineLogAreas } from "./define.js";

export const WEB_SETTINGS_LOG_AREAS = defineLogAreas({
  "web.settings": {
    description: "The settings screens.",
    events: {
      "config.save-failed": "Global settings could not be saved.",
    },
  },
});

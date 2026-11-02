import { defineLogAreas } from "./define.js";

export const WEB_DESIGN_LOG_AREAS = defineLogAreas({
  "web.design": {
    description: "Opening design canvas tabs.",
    events: {
      "tab.duplicate-refused": "A design tab was not opened because its id is already in use.",
    },
  },
});

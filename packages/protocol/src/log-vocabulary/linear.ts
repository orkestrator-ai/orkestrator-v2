import { defineLogAreas } from "./define.js";

export const LINEAR_LOG_AREAS = defineLogAreas({
  linear: {
    description: "Linear issues read for build actions.",
    events: {
      "comments.load-failed":
        "An issue's comments could not be loaded; the issue still renders without them.",
    },
  },
});

import { defineLogAreas } from "./define.js";

export const WEB_BUILD_PIPELINE_LOG_AREAS = defineLogAreas({
  "web.build-pipeline": {
    description: "Build pipelines as the renderer starts, hydrates and shows them.",
    events: {
      "build.start-failed": "A build could not be started.",
    },
  },
});

import { defineLogAreas } from "./define.js";

export const WEB_BUILD_PIPELINE_LOG_AREAS = defineLogAreas({
  "web.build-pipeline": {
    description: "Build pipelines as the renderer starts, hydrates and shows them.",
    events: {
      "build.start-failed": "A build could not be started.",
      "pipeline.hydrate-failed": "A pipeline read failed; source says who asked for it.",
      "pipeline.project-mismatch": "A pending tab activation was dropped: wrong project.",
      "environment.not-found": "A build's environment read returned nothing after creation.",
      "environment.project-mismatch": "A build's environment was not added: wrong project.",
      "environment.hydrate-failed": "A build's environment read failed; live sync can recover.",
      "transcript.load-failed": "A stage transcript read failed and will retry with backoff.",
      "legacy.state-too-large": "Legacy pipeline state was over the limit and skipped.",
      "opencode-catalog.load-failed": "The cached OpenCode model list could not be loaded.",
      "model-catalog.hydrate-failed":
        "A node's cached model lists could not be loaded for a launcher.",
      "opencode-preferences.load-failed": "OpenCode model preferences could not be loaded.",
    },
  },
});

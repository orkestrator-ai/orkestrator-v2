import { defineLogAreas } from "./define.js";

export const MODEL_LOG_AREAS = defineLogAreas({
  models: {
    description: "Agent model catalogues and their persistent caches.",
    events: {
      "cache.write-failed": "A successful catalogue refresh could not update the host cache.",
      "seed.pi-failed": "The host Pi model catalogue could not be seeded; the next launch retries.",
      "bridge.not-ready": "The first-use catalogue bridge did not become ready.",
      "bridge.start-failed": "The first-use catalogue bridge failed to start.",
      "probe.exit-unclean": "A catalogue probe or sign-in server did not exit cleanly.",
      "download.deferred": "A model catalogue could not be downloaded yet.",
    },
  },
});

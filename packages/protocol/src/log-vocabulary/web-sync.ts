import { defineLogAreas } from "./define.js";

export const WEB_SYNC_LOG_AREAS = defineLogAreas({
  "web.resource-sync": {
    description: "Keeping renderer stores current with backend resources.",
    events: {
      "handler.threw": "A resource change handler threw; other handlers still ran.",
    },
  },
  "web.read-coordinator": {
    description: "The renderer's coalesced, bounded backend reads.",
    events: {
      "listener.threw": "A read state listener threw.",
    },
  },
  "web.gateway": {
    description: "The renderer's connection to the gateway: requests and event streams.",
    events: {
      "events.disconnected": "The event stream dropped; it reconnects and replays.",
    },
  },
  "web.federation": {
    description: "Events from federated nodes as the renderer receives them.",
    events: {
      "resync-handler.failed": "A node resync handler failed.",
    },
  },
});
